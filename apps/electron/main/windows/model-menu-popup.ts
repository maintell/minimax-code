import { BrowserWindow, screen, ipcMain } from "electron";
import path from "node:path";
import electronLog from "electron-log";
import { PAGE_URLS } from "../config/routes";
import { DEFAULT_SECURE_WEB_PREFERENCES, registerTransparentWindow } from "./utils";
import { isModelMenuActionAllowed, positionModelMenu } from "./model-menu-layout";
import { scheduleArchonMiniChatBlur } from "./archonMiniChatWindow";
const CHANNEL = 'model-menu-popup';
function validatePresentation(data) {
    if (!data ||
        (data.kind !== undefined && !['asr-device', 'panel-add', 'browser-more'].includes(data.kind)) ||
        !Array.isArray(data.rows) ||
        data.rows.length > 500 ||
        typeof data.locale !== 'string' ||
        typeof data.fontFamily !== 'string' ||
        !data.tokens ||
        typeof data.tokens !== 'object' ||
        JSON.stringify(data).length > 256000 ||
        data.rows.some((row) => !row ||
            typeof row.key !== 'string' ||
            typeof row.label !== 'string' ||
            (row.disabled !== undefined && typeof row.disabled !== 'boolean') ||
            (row.selected !== undefined && typeof row.selected !== 'boolean') ||
            (row.separatorBefore !== undefined && typeof row.separatorBefore !== 'boolean') ||
            (row.description !== undefined && typeof row.description !== 'string') ||
            (row.shortcut !== undefined && typeof row.shortcut !== 'string') ||
            (row.icon !== undefined &&
                !['terminal', 'canvas', 'files', 'browser', 'miniapp', 'changes'].includes(row.icon)) ||
            (row.zoom !== undefined &&
                (data.kind !== 'browser-more' ||
                    !row.zoom ||
                    !Number.isFinite(row.zoom.factor) ||
                    row.zoom.factor < 0.25 ||
                    row.zoom.factor > 3)) ||
            (row.context &&
                (!Array.isArray(row.context.options) || !row.context.options.every(Number.isFinite))) ||
            (row.effort &&
                (!Array.isArray(row.effort.options) ||
                    !row.effort.options.every((value) => typeof value === 'string'))))) {
        throw new TypeError('Invalid model menu presentation');
    }
}
function getOwner(event, menuPageRequired = true) {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const url = new URL(event.sender.getURL());
    const trusted = [PAGE_URLS.ARCHON_CHAT, PAGE_URLS.ARCHON_MINI_CHAT].some((page) => {
        const allowed = new URL(page);
        return (url.protocol === allowed.protocol &&
            url.host === allowed.host &&
            url.pathname.replace(/\/$/, '') === allowed.pathname.replace(/\/$/, ''));
    });
    if (!owner ||
        event.sender !== owner.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        (menuPageRequired && !trusted)) {
        throw new Error('Model menu requires its owning application renderer');
    }
    return owner;
}
function getScreenAnchor(owner, anchor) {
    const zoom = owner.webContents.getZoomFactor();
    const content = owner.getContentBounds();
    return {
        x: content.x + anchor.x * zoom,
        y: content.y + anchor.y * zoom,
        width: anchor.width * zoom,
        height: anchor.height * zoom,
    };
}
/** One reusable, non-modal popup per owner. Does not touch Browser/PPT views. */
export function setupModelMenuPopupIPC() {
    const initialScope = { revision: 0, modalId: null, acceptsMenu: true };
    const modalScopes = new WeakMap();
    const scopeAllows = (owner, request) => {
        const current = modalScopes.get(owner) ?? initialScope;
        const requested = request.modalScope ?? initialScope;
        return (current.acceptsMenu &&
            requested.revision === current.revision &&
            requested.modalId === current.modalId);
    };
    const entries = new Map();
    const sendState = (entry) => {
        if (entry.ready && !entry.popup.isDestroyed() && !entry.popup.webContents.isDestroyed()) {
            if (!entry.request) {
                entry.popup.webContents.send(`${CHANNEL}:state`, null);
                return;
            }
            if (entry.owner.isDestroyed() || entry.owner.webContents.isDestroyed())
                return;
            const area = screen.getDisplayMatching(entry.request
                ? getScreenAnchor(entry.owner, entry.request.anchor)
                : entry.owner.getContentBounds()).workArea;
            const zoom = entry.owner.webContents.getZoomFactor();
            entry.popup.webContents.send(`${CHANNEL}:state`, entry.request
                ? {
                    id: entry.request.id,
                    presentation: entry.request.presentation,
                    // Reserve shadow padding (32 DIP) plus 1 DIP for integer window rounding.
                    maxWidth: Math.max(1, (area.width - 33) / zoom / 2),
                    maxHeight: Math.max(1, (area.height - 33) / zoom),
                }
                : null);
        }
    };
    const createEntry = (owner) => {
        const ownerContents = owner.webContents;
        const ownerId = owner.id;
        let disposed = false;
        const popup = new BrowserWindow({
            parent: owner,
            modal: false,
            show: false,
            frame: false,
            transparent: true,
            backgroundColor: '#00000000',
            width: 232,
            height: 100,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            alwaysOnTop: false,
            hasShadow: false,
            acceptFirstMouse: true,
            webPreferences: {
                ...DEFAULT_SECURE_WEB_PREFERENCES,
                sandbox: true,
                preload: path.join(__dirname, '..', 'model-menu-preload.js'),
                partition: 'model-menu-popup',
                spellcheck: false,
                backgroundThrottling: false,
            },
        });
        registerTransparentWindow(popup);
        popup.webContents.on('console-message', (details) => {
            if (details.level === 'error')
                electronLog.error('[ModelMenuPopup] Renderer:', details.message);
        });
        popup.webContents.on('preload-error', (_event, _preload, error) => electronLog.error('[ModelMenuPopup] Preload failed', error));
        popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        popup.webContents.on('will-navigate', (event) => event.preventDefault());
        const entry = {
            owner,
            popup,
            request: undefined,
            ready: false,
            measured: false,
            openTimeout: undefined,
            idleTimeout: undefined,
            close: (restoreFocus = false, error = false) => {
                clearTimeout(entry.openTimeout);
                const request = entry.request;
                if (!request)
                    return;
                entry.request = undefined;
                if (!popup.isDestroyed())
                    popup.hide();
                sendState(entry);
                clearTimeout(entry.idleTimeout);
                // Retain fast repeated opens, but do not keep a renderer alive indefinitely.
                if (!disposed)
                    entry.idleTimeout = setTimeout(entry.dispose, 60000);
                if (!owner.isDestroyed() && !ownerContents.isDestroyed()) {
                    if (restoreFocus)
                        owner.focus();
                    ownerContents.send(`${CHANNEL}:event`, {
                        id: request.id,
                        type: 'closed',
                        restoreFocus,
                        ...(error ? { error: true } : {}),
                    });
                    // The owner's blur was suppressed while its menu had focus. Recheck
                    // after closing so switching to another application still hides Mini Chat.
                    scheduleArchonMiniChatBlur(owner);
                }
            },
            dispose: () => {
                if (disposed)
                    return;
                disposed = true;
                entry.close();
                clearTimeout(entry.idleTimeout);
                for (const name of ownerEvents)
                    owner.removeListener(name, close);
                ownerContents.removeListener('did-start-navigation', close);
                owner.removeListener('closed', entry.dispose);
                entries.delete(ownerId);
                if (!popup.isDestroyed())
                    popup.destroy();
            },
        };
        const close = () => entry.close();
        // ponytail: close on geometry changes; continuous tracking can be added if product needs it.
        const ownerEvents = [
            'move',
            'resize',
            'hide',
            'minimize',
            'enter-full-screen',
            'leave-full-screen',
        ];
        for (const name of ownerEvents)
            owner.on(name, close);
        ownerContents.on('did-start-navigation', close);
        owner.once('closed', entry.dispose);
        popup.on('blur', close);
        popup.webContents.on('render-process-gone', () => {
            entry.close(false, true);
            entry.dispose();
        });
        popup.on('closed', () => {
            if (entries.get(ownerId) === entry)
                entry.dispose();
        });
        entries.set(owner.id, entry);
        void popup
            .loadFile(path.join(__dirname, '..', '..', 'model-menu', 'index.html'))
            .catch((error) => {
            electronLog.error('[ModelMenuPopup] Load failed', error);
            entry.close(false, true);
            entry.dispose();
        });
        return entry;
    };
    ipcMain.handle(`${CHANNEL}:modal-scope`, (event, scope) => {
        // Shared modals also run on app pages that cannot open model menus. They may
        // update only their own window's scope; menu open keeps its URL allowlist.
        const owner = getOwner(event, false);
        if (!scope ||
            !Number.isSafeInteger(scope.revision) ||
            scope.revision < 0 ||
            typeof scope.acceptsMenu !== 'boolean' ||
            (scope.modalId !== null &&
                (typeof scope.modalId !== 'string' || !scope.modalId || scope.modalId.length > 200))) {
            throw new TypeError('Invalid model menu modal scope');
        }
        const previous = modalScopes.get(owner) ?? initialScope;
        if (scope.revision <= previous.revision)
            return;
        if (!modalScopes.has(owner)) {
            // A reload starts a fresh renderer revision sequence on the same BrowserWindow.
            owner.webContents.once('did-navigate', () => modalScopes.delete(owner));
        }
        modalScopes.set(owner, scope);
        const entry = entries.get(owner.id);
        if (entry?.request && !scopeAllows(owner, entry.request))
            entry.close();
    });
    ipcMain.handle(`${CHANNEL}:open`, (event, request) => {
        const owner = getOwner(event);
        if (!request ||
            typeof request.id !== 'string' ||
            !request.id ||
            request.id.length > 128 ||
            !request.anchor ||
            !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(request.anchor[key])) ||
            !['up', 'down'].includes(request.direction) ||
            !['start', 'end'].includes(request.align)) {
            throw new TypeError('Invalid model menu request');
        }
        validatePresentation(request.presentation);
        if (!scopeAllows(owner, request)) {
            owner.webContents.send(`${CHANNEL}:event`, {
                id: request.id,
                type: 'closed',
                restoreFocus: false,
            });
            return;
        }
        const entry = entries.get(owner.id) ?? createEntry(owner);
        if (entry.request?.id !== request.id)
            entry.close();
        clearTimeout(entry.idleTimeout);
        entry.measured = false;
        entry.request = request;
        clearTimeout(entry.openTimeout);
        entry.openTimeout = setTimeout(() => {
            electronLog.error('[ModelMenuPopup] Timed out waiting for the menu to paint');
            entry.close(false, true);
            entry.dispose();
        }, 10000);
        entry.popup.webContents.setZoomFactor(owner.webContents.getZoomFactor());
        sendState(entry);
    });
    const ownerMessage = (event, kind, id, data) => {
        try {
            const entry = entries.get(getOwner(event).id);
            if (entry?.request?.id !== id)
                return;
            if (kind === 'close')
                entry.close();
            if (kind === 'update' && data) {
                validatePresentation(data);
                entry.request.presentation = data;
                sendState(entry);
            }
        }
        catch {
            /* Invalid senders cannot alter another window's menu. */
        }
    };
    const rendererMessage = (event, kind, id, payload) => {
        const entry = [...entries.values()].find((item) => !item.popup.isDestroyed() && item.popup.webContents === event.sender);
        if (!entry || event.senderFrame !== event.sender.mainFrame)
            return;
        if (kind === 'ready') {
            entry.ready = true;
            sendState(entry);
            return;
        }
        if (!entry.request || entry.request.id !== id)
            return;
        if (!scopeAllows(entry.owner, entry.request)) {
            entry.close();
            return;
        }
        if (kind === 'close') {
            entry.close(payload === true);
            return;
        }
        if (kind === 'action') {
            if (isModelMenuActionAllowed(entry.request.presentation, payload)) {
                entry.owner.webContents.send(`${CHANNEL}:event`, { id, type: 'action', action: payload });
            }
            return;
        }
        if (kind === 'painted') {
            if (entry.measured)
                clearTimeout(entry.openTimeout);
            if (entry.measured && !entry.popup.isVisible()) {
                // First paint is asynchronous: never steal focus after the user switches away.
                if (!entry.owner.isFocused() || !entry.owner.isVisible() || entry.owner.isMinimized()) {
                    entry.close();
                }
                else {
                    entry.popup.show();
                }
            }
            return;
        }
        if (kind !== 'measure')
            return;
        try {
            const measured = payload;
            const zoom = entry.owner.webContents.getZoomFactor();
            const screenAnchor = getScreenAnchor(entry.owner, entry.request.anchor);
            const area = screen.getDisplayMatching(screenAnchor).workArea;
            const geometry = positionModelMenu(screenAnchor, entry.request.direction, entry.request.align, {
                menu: { width: measured.menu.width * zoom, height: measured.menu.height * zoom },
                ...(measured.submenu
                    ? {
                        submenu: {
                            width: measured.submenu.width * zoom,
                            height: measured.submenu.height * zoom,
                            top: measured.submenu.top * zoom,
                        },
                    }
                    : {}),
            }, area);
            entry.popup.setBounds(geometry.bounds, false);
            entry.measured = true;
            const layout = geometry.layout;
            entry.popup.webContents.send(`${CHANNEL}:layout`, {
                width: layout.width / zoom,
                height: layout.height / zoom,
                menu: { x: layout.menu.x / zoom, y: layout.menu.y / zoom },
                ...(layout.submenu
                    ? { submenu: { x: layout.submenu.x / zoom, y: layout.submenu.y / zoom } }
                    : {}),
            });
        }
        catch {
            entry.close();
        }
    };
    ipcMain.on(`${CHANNEL}:owner`, ownerMessage);
    ipcMain.on(`${CHANNEL}:renderer`, rendererMessage);
    return () => {
        ipcMain.removeHandler(`${CHANNEL}:open`);
        ipcMain.removeHandler(`${CHANNEL}:modal-scope`);
        ipcMain.removeListener(`${CHANNEL}:owner`, ownerMessage);
        ipcMain.removeListener(`${CHANNEL}:renderer`, rendererMessage);
        for (const entry of [...entries.values()])
            entry.dispose();
    };
}
