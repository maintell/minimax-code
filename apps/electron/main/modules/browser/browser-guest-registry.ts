import { randomUUID } from "node:crypto";
import { isAgentPointerActive, setAgentPointerListener } from "./webview-guest-input.js";
const ATTACH_TIMEOUT_MS = 10000;
const LAYOUT_TIMEOUT_MS = 3000;
export let WEBVIEW_HOST_CHANNELS = {
    ready: 'browser-webview:ready',
    snapshot: 'browser-webview:snapshot',
    applied: 'browser-webview:applied',
    prepareNative: 'browser-webview:prepare-native',
    nativeReady: 'browser-webview:native-ready',
    interaction: 'browser-webview:interaction',
    agentPointer: 'browser-webview:agent-pointer',
};
function unavailable(reason) {
    return new Error(`BROWSER_WEBVIEW_UNAVAILABLE: ${reason}`);
}
/**
 * Detach any CDP client before closing a guest. Electron 42's Debugger does not
 * detach itself when collected, so closing an attached guest can leave Chromium
 * dispatching into freed memory and crash the main process.
 */
export function closeBrowserGuest(guest) {
    if (guest.isDestroyed())
        return;
    detachBrowserGuestDebugger(guest);
    guest.close();
}
function detachBrowserGuestDebugger(guest) {
    try {
        if (guest.debugger.isAttached())
            guest.debugger.detach();
    }
    catch {
        // A guest that is already tearing down may reject debugger access.
    }
}
/**
 * Owns guest allocation authority. Each pending guest is matched by its own
 * single-use ticket, so one failed or cancelled attachment never blocks others.
 */
export class BrowserGuestRegistry {
    constructor() {
        this.hosts = new Map();
        this.guestOwners = new Map();
        this.presentationWaits = new Map();
        this.observer = {};
    }
    setObserver(observer) {
        this.observer = observer;
    }
    notify(run) {
        try {
            run(this.observer);
        }
        catch {
            // Observers must never affect guest authority.
        }
    }
    /** Read-only host state for the feedback diagnostics bundle. */
    diagnostics() {
        return [...this.hosts.values()].map((host) => ({
            hostKind: host.hostKind,
            guests: host.views.size,
            ready: host.ready,
            epoch: host.epoch,
            pendingLayouts: [...host.views.values()].reduce((sum, r) => sum + r.layouts.size, 0),
            renderLeases: host.renderLeases,
        }));
    }
    totalGuests() {
        let count = 0;
        for (const host of this.hosts.values())
            count += host.views.size;
        return count;
    }
    install(window, validate, hostKind = 'main') {
        const contents = window.webContents;
        if (this.hosts.has(contents))
            return;
        const host = {
            window,
            contents,
            validate,
            epoch: 1,
            revision: 0,
            ready: false,
            attaching: null,
            views: new Map(),
            renderLeases: 0,
            previousThrottling: true,
            dispose: () => undefined,
            navigationActive: false,
            everReady: false,
            hostKind,
        };
        const endDocument = (cause = 'navigation') => {
            if (!host.everReady)
                return;
            const resetCount = host.views.size;
            if (resetCount > 0)
                this.notify((o) => o.hostReset?.(cause, resetCount, hostKind));
            for (const wait of this.presentationWaits.values())
                if (wait.owner === contents)
                    wait.finish(true);
            host.ready = false;
            host.epoch += 1;
            host.attaching = null;
            for (const record of [...host.views.values()])
                this.remove(host, record, unavailable('host document ended'));
        };
        const navigation = (_event, urlOrDetails, inPlace, mainFrame) => {
            const details = urlOrDetails && typeof urlOrDetails === 'object'
                ? urlOrDetails
                : null;
            if (details
                ? details.isMainFrame !== false && details.isSameDocument !== true
                : mainFrame !== false && inPlace !== true) {
                host.navigationActive = true;
                endDocument();
            }
        };
        const committed = () => {
            host.navigationActive = false;
        };
        const willAttach = (event, preferences, params) => {
            const record = [...host.views.values()].find((r) => r.descriptor.src === params.src);
            if (!host.ready ||
                host.attaching ||
                !validate(contents.getURL()) ||
                !record ||
                record.cancelled ||
                record.admitted) {
                event.preventDefault();
                if (host.ready && typeof params.src === 'string' && params.src.includes('#mavis-guest-'))
                    this.notify((o) => o.guestFailed?.('rejected', hostKind));
                return;
            }
            record.admitted = true;
            host.attaching = record;
            // Electron creates and attaches the guest synchronously after this event.
            // If another listener vetoes it, fail only this ticket.
            queueMicrotask(() => {
                if (host.attaching !== record)
                    return;
                host.attaching = null;
                this.notify((o) => o.guestFailed?.('rejected', hostKind));
                this.remove(host, record, unavailable('guest attachment was rejected'));
            });
            // Guest creation otherwise navigates before did-attach-webview. Restore
            // history and register Mini App credentials before the first actual request.
            params.src = '';
            for (const key of Object.keys(preferences))
                delete preferences[key];
            Object.assign(preferences, record.preferences, {
                nodeIntegration: false,
                nodeIntegrationInSubFrames: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                webviewTag: false,
                disablePopups: false,
            });
        };
        const didAttach = (_event, guest) => {
            const record = host.attaching;
            host.attaching = null;
            if (!record?.admitted ||
                record.cancelled ||
                record.guest ||
                !host.views.has(record.descriptor.id) ||
                guest.hostWebContents !== contents) {
                closeBrowserGuest(guest);
                if (record && !record.cancelled) {
                    this.notify((o) => o.guestFailed?.('rejected', hostKind));
                    this.remove(host, record, unavailable('guest attachment was rejected'));
                }
                return;
            }
            clearTimeout(record.timer);
            record.guest = guest;
            this.guestOwners.set(guest, window);
            guest.once('destroyed', () => {
                this.guestOwners.delete(guest);
                this.remove(host, record, unavailable('guest destroyed'));
            });
            record.resolve(guest);
            const guestCount = this.totalGuests();
            this.notify((o) => o.guestCount?.(guestCount));
            guest.on('before-mouse-event', (_event, input) => {
                if (input.type !== 'mouseDown' || contents.isDestroyed())
                    return;
                // Agent pointer input is announced separately and is not a user interaction.
                if (isAgentPointerActive(guest))
                    return;
                if (record.descriptor.visible)
                    contents.send(WEBVIEW_HOST_CHANNELS.interaction);
            });
            this.publish(host);
        };
        const dispose = () => {
            host.everReady = true;
            endDocument();
            contents.removeListener('will-attach-webview', willAttach);
            contents.removeListener('did-attach-webview', didAttach);
            contents.removeListener('did-start-navigation', navigation);
            contents.removeListener('did-navigate', committed);
            contents.removeListener('render-process-gone', onHostGone);
            contents.removeListener('destroyed', dispose);
            this.hosts.delete(contents);
        };
        host.dispose = dispose;
        this.hosts.set(contents, host);
        contents.on('will-attach-webview', willAttach);
        contents.on('did-attach-webview', didAttach);
        contents.on('did-start-navigation', navigation);
        contents.on('did-navigate', committed);
        const onHostGone = () => endDocument('crash');
        contents.on('render-process-gone', onHostGone);
        contents.once('destroyed', dispose);
        // Chromium destroys remaining guests together with the embedder. Electron's
        // internal 'will-destroy' runs first, while their debuggers can still detach.
        contents.once('will-destroy', () => {
            for (const record of host.views.values())
                if (record.guest)
                    detachBrowserGuestDebugger(record.guest);
        });
    }
    isTrusted(event) {
        const host = this.hosts.get(event.sender);
        try {
            return Boolean(host &&
                !host.navigationActive &&
                !event.sender.isDestroyed() &&
                event.senderFrame &&
                event.senderFrame === event.sender.mainFrame &&
                host.validate(event.sender.getURL()));
        }
        catch {
            return false;
        }
    }
    ready(contents) {
        const host = this.hosts.get(contents);
        if (!host || !host.validate(contents.getURL()) || host.navigationActive)
            throw unavailable('untrusted host');
        host.ready = true;
        host.everReady = true;
        return this.snapshot(host);
    }
    async create(window, preferences, signal, transparentBackground = false, anchorKey) {
        if (window.isDestroyed())
            throw unavailable('host closed');
        const host = this.hosts.get(window.webContents);
        if (!host || signal?.aborted) {
            if (!signal?.aborted)
                this.notify((o) => o.guestFailed?.('host_unavailable', host?.hostKind ?? 'main'));
            throw unavailable('host not available');
        }
        if (host.views.size >= 64) {
            this.notify((o) => o.guestFailed?.('capacity', host.hostKind));
            throw unavailable('guest capacity exceeded');
        }
        const id = randomUUID();
        let resolve;
        let reject;
        const result = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        const record = {
            descriptor: {
                id,
                src: `about:blank#mavis-guest-${randomUUID()}`,
                revision: 1,
                bounds: { x: 0, y: 0, width: 800, height: 600 },
                page: { x: 0, y: 0, width: 800, height: 600 },
                visible: false,
                transparentBackground,
                ...(anchorKey ? { anchorKey } : {}),
            },
            preferences,
            guest: null,
            admitted: false,
            cancelled: false,
            resolve,
            reject,
            layouts: new Set(),
            appliedRevision: 0,
            timer: setTimeout(() => {
                this.notify((o) => o.guestFailed?.('attach_timeout', host.hostKind));
                this.remove(host, record, unavailable('guest attach timeout'));
            }, ATTACH_TIMEOUT_MS),
        };
        host.views.set(id, record);
        const abort = () => {
            if (!record.guest && !record.cancelled)
                this.notify((o) => o.guestFailed?.('cancelled', host.hostKind));
            this.remove(host, record, unavailable('guest creation cancelled'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        this.publish(host);
        try {
            return { id, guest: await result };
        }
        finally {
            signal?.removeEventListener('abort', abort);
        }
    }
    async layout(window, id, bounds, page, visible) {
        if (window.isDestroyed())
            throw unavailable('host closed');
        const host = this.hosts.get(window.webContents);
        const record = host?.views.get(id);
        if (!host || !record || record.cancelled)
            throw unavailable('guest no longer exists');
        const zoom = window.webContents.getZoomFactor();
        const css = (rect) => ({
            x: rect.x / zoom,
            y: rect.y / zoom,
            width: rect.width / zoom,
            height: rect.height / zoom,
        });
        const rendererView = window.contentView?.children.find((view) => 'webContents' in view && view.webContents === window.webContents);
        const offset = rendererView?.getBounds();
        const next = {
            bounds: css({ ...bounds, x: bounds.x - (offset?.x ?? 0), y: bounds.y - (offset?.y ?? 0) }),
            page: css(page),
            visible,
        };
        if (record.appliedRevision >= record.descriptor.revision &&
            JSON.stringify(next) ===
                JSON.stringify({
                    bounds: record.descriptor.bounds,
                    page: record.descriptor.page,
                    visible: record.descriptor.visible,
                }))
            return;
        Object.assign(record.descriptor, next, { revision: record.descriptor.revision + 1 });
        const revision = record.descriptor.revision;
        const applied = new Promise((resolve, reject) => {
            const expire = () => {
                if (!pending.retried && !record.cancelled) {
                    // A busy host may have dropped or delayed the snapshot; resend it once.
                    pending.retried = true;
                    pending.timer = setTimeout(expire, LAYOUT_TIMEOUT_MS);
                    this.publish(host);
                    return;
                }
                record.layouts.delete(pending);
                this.notify((o) => o.guestFailed?.('layout_timeout', host.hostKind));
                reject(unavailable('layout acknowledgement timed out'));
            };
            const pending = {
                revision,
                resolve,
                reject,
                retried: false,
                timer: setTimeout(expire, LAYOUT_TIMEOUT_MS),
            };
            record.layouts.add(pending);
        });
        this.publish(host);
        return applied;
    }
    applied(contents, id, revision) {
        if (typeof id !== 'string' || !Number.isSafeInteger(revision))
            return;
        const record = this.hosts.get(contents)?.views.get(id);
        if (!record || record.descriptor.revision !== revision)
            return;
        record.appliedRevision = revision;
        for (const pending of record.layouts) {
            if (pending.revision <= revision) {
                clearTimeout(pending.timer);
                pending.resolve();
                record.layouts.delete(pending);
            }
        }
    }
    destroy(window, id) {
        if (window.isDestroyed())
            return;
        const host = this.hosts.get(window.webContents);
        const record = host?.views.get(id);
        if (host && record)
            this.remove(host, record, unavailable('guest closed'));
    }
    owner(guest) {
        return this.guestOwners.get(guest) ?? null;
    }
    hasGuests(window) {
        return !window.isDestroyed() && (this.hosts.get(window.webContents)?.views.size ?? 0) > 0;
    }
    async prepareNative(window) {
        if (window.isDestroyed())
            return true;
        const host = this.hosts.get(window.webContents);
        if (!host || host.views.size === 0)
            return false;
        if (!host.ready)
            return true;
        const id = randomUUID();
        return new Promise((resolve) => {
            const timer = setTimeout(() => finish(true), LAYOUT_TIMEOUT_MS);
            const finish = (blocked) => {
                clearTimeout(timer);
                this.presentationWaits.delete(id);
                resolve(blocked);
            };
            this.presentationWaits.set(id, { owner: host.contents, finish });
            try {
                host.contents.send(WEBVIEW_HOST_CHANNELS.prepareNative, id);
            }
            catch {
                finish(true);
            }
        });
    }
    /** Tells the guest's host document that Agent pointer input is about to press. */
    announceAgentPointer(guest) {
        for (const host of this.hosts.values()) {
            for (const record of host.views.values()) {
                if (record.guest !== guest)
                    continue;
                if (host.ready && !host.contents.isDestroyed()) {
                    try {
                        host.contents.send(WEBVIEW_HOST_CHANNELS.agentPointer, record.descriptor.id);
                    }
                    catch {
                        // A closing host has no focus to restore.
                    }
                }
                return;
            }
        }
    }
    nativeReady(contents, id, blocked) {
        if (typeof id !== 'string' || typeof blocked !== 'boolean')
            return;
        const wait = this.presentationWaits.get(id);
        if (wait?.owner === contents)
            wait.finish(blocked);
    }
    acquireRendering(window) {
        if (window.isDestroyed())
            throw unavailable('host closed');
        const host = this.hosts.get(window.webContents);
        if (!host)
            throw unavailable('host closed');
        if (host.renderLeases === 0) {
            host.previousThrottling = window.webContents.backgroundThrottling;
            window.webContents.setBackgroundThrottling(false);
        }
        host.renderLeases += 1;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            if (--host.renderLeases === 0 && !window.isDestroyed() && !window.webContents.isDestroyed())
                window.webContents.setBackgroundThrottling(host.previousThrottling);
        };
    }
    snapshot(host) {
        return {
            epoch: host.epoch,
            revision: host.revision,
            views: [...host.views.values()]
                .filter((r) => !r.cancelled)
                .map((r) => structuredClone(r.descriptor)),
        };
    }
    publish(host) {
        host.revision += 1;
        if (host.ready && !host.contents.isDestroyed()) {
            try {
                host.contents.send(WEBVIEW_HOST_CHANNELS.snapshot, this.snapshot(host));
            }
            catch {
                // Attach/layout deadlines fail the caller; closing a host must not
                // interrupt the rest of guest cleanup with a send-on-dead-frame error.
            }
        }
    }
    remove(host, record, error) {
        if (record.cancelled)
            return;
        record.cancelled = true;
        clearTimeout(record.timer);
        host.views.delete(record.descriptor.id);
        record.reject(error);
        for (const pending of record.layouts) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        record.layouts.clear();
        if (record.guest) {
            this.guestOwners.delete(record.guest);
            closeBrowserGuest(record.guest);
        }
        if (host.attaching === record)
            host.attaching = null;
        this.publish(host);
    }
}

export let browserGuestRegistry = new BrowserGuestRegistry();
setAgentPointerListener((guest) => browserGuestRegistry.announceAgentPointer(guest));
