import { randomUUID } from "node:crypto";
import { parseMiniAppHostPublishedState, readMiniAppHostOpenTarget, parseMiniAppHostOpenResponse } from "@mavis/shared/miniapp-surface";
const MAX_PAGE_SUBSCRIPTIONS = 64;
const fail = (code) => ({ success: false, code });
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function readModule(value) {
    return value === 'ui' || value === 'navigation' ? value : null;
}
function readSubscriptionId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : null;
}
/** Host snapshots and user navigation are scoped to the calling document and its fixed owner. */
export class MiniAppHostBroker {
    constructor(options) {
        this.options = options;
        this.owners = new Map();
        this.pages = new Map();
        this.opens = new Map();
        this.permissionEpochs = new Map();
        this.closed = false;
        this.stopPermissions = options.manager.observeMiniAppPermissionChanges((pluginId, permission, enabled) => {
            if (permission !== 'host:navigation.read' || enabled)
                return;
            this.permissionEpochs.set(pluginId, (this.permissionEpochs.get(pluginId) ?? 0) + 1);
            for (const page of this.pages.values()) {
                if (page.source.pluginId !== pluginId)
                    continue;
                page.navigationRevision = -1;
                for (const subscription of [...page.subscriptions.values()]) {
                    if (subscription.module === 'navigation')
                        this.endSubscription(page, subscription, 'not_permitted');
                }
            }
        });
    }
    /** The IPC adapter has verified the Host main-frame origin. A new handshake fences the old epoch. */
    handshake(sender) {
        if (this.closed ||
            !sender.senderFrame ||
            sender.sender.isDestroyed() ||
            sender.senderFrame.detached ||
            sender.sender.mainFrame !== sender.senderFrame)
            return fail('host_unavailable');
        this.endOwner(sender.sender);
        const owner = {
            host: sender.sender,
            frame: sender.senderFrame,
            epoch: randomUUID(),
            state: null,
            lastNavigation: null,
            navigationRevision: 0,
            dispose: () => { },
        };
        this.owners.set(sender.sender, owner);
        owner.dispose = this.options.manager.observeHostDocumentEnd(sender.sender, () => this.endOwner(sender.sender, owner));
        return { success: true, epoch: owner.epoch };
    }
    publish(sender, input) {
        const value = record(input);
        const owner = this.owners.get(sender.sender);
        if (!owner ||
            owner.frame !== sender.senderFrame ||
            owner.epoch !== value?.epoch ||
            !this.ownerCurrent(owner))
            return;
        const state = parseMiniAppHostPublishedState(value.state);
        if (!state)
            return;
        if (state.navigation &&
            JSON.stringify(owner.lastNavigation) !== JSON.stringify(state.navigation)) {
            owner.navigationRevision += 1;
            owner.lastNavigation = state.navigation;
        }
        owner.state = state;
        const permissionReads = new Map();
        for (const page of this.pages.values()) {
            if (page.source.owner !== owner.host)
                continue;
            for (const subscription of page.subscriptions.values())
                void this.deliver(page, subscription, permissionReads);
        }
    }
    async getState(sender, input) {
        const module = readModule(record(input)?.module);
        if (!module)
            return fail('invalid_request');
        const page = this.page(sender);
        if (!page)
            return fail('host_unavailable');
        const permission = module === 'navigation' ? await this.authorizeNavigation(page) : null;
        if (permission)
            return fail(permission);
        return this.snapshot(page, module);
    }
    async subscribe(sender, input) {
        const value = record(input);
        const module = readModule(value?.module);
        const id = readSubscriptionId(value?.subscriptionId);
        if (!module || !id)
            return fail('invalid_request');
        const page = this.page(sender);
        if (!page)
            return fail('host_unavailable');
        if (page.subscriptions.has(id))
            return fail('invalid_request');
        if (page.subscriptions.size >= MAX_PAGE_SUBSCRIPTIONS)
            return fail('not_permitted');
        const subscription = {
            id,
            module,
            revision: 0,
            pendingRevision: 0,
            delivered: null,
        };
        page.subscriptions.set(id, subscription);
        const permission = module === 'navigation' ? await this.authorizeNavigation(page, true) : null;
        if (page.subscriptions.get(id) !== subscription)
            return { success: true };
        const owner = this.ownerFor(page);
        if (!permission &&
            module === 'navigation' &&
            owner?.state &&
            (!page.source.isVisible() || owner.state.navigation === null)) {
            return { success: true, paused: true };
        }
        const snapshot = permission ? fail(permission) : this.snapshot(page, module);
        if (!snapshot.success) {
            page.subscriptions.delete(id);
            return snapshot;
        }
        this.sendState(page, subscription, snapshot);
        return { success: true };
    }
    unsubscribe(sender, input) {
        const id = readSubscriptionId(record(input)?.subscriptionId);
        const page = this.pages.get(sender.sender);
        if (id && page?.source.frame === sender.senderFrame)
            page.subscriptions.delete(id);
    }
    async open(sender, input) {
        const value = record(input);
        if (!value || typeof value.userActivated !== 'boolean')
            return fail('invalid_request');
        const target = readMiniAppHostOpenTarget(value.target);
        if (!target.success)
            return target;
        if (!value.userActivated)
            return fail('not_permitted');
        const page = this.page(sender);
        const owner = page ? this.ownerFor(page) : null;
        if (!page || !owner?.state)
            return fail('host_unavailable');
        // A newer request from this owner always wins, including an open from another Mini App.
        for (const pending of [...this.opens.values()])
            if (pending.owner === owner) {
                pending.settle({ success: true, result: { status: 'cancelled', reason: 'superseded' } }, true);
            }
        return new Promise((resolve) => {
            const id = randomUUID();
            let timer;
            const pending = {
                owner,
                page,
                settle: (result, cancel = false) => {
                    if (this.opens.get(id) !== pending)
                        return;
                    this.opens.delete(id);
                    if (timer)
                        clearTimeout(timer);
                    if (cancel) {
                        try {
                            this.options.cancelOpen(owner.frame, { epoch: owner.epoch, requestId: id });
                        }
                        catch {
                            /* The owner may have gone away. */
                        }
                    }
                    resolve(result);
                },
            };
            this.opens.set(id, pending);
            timer = setTimeout(() => pending.settle(fail('result_unknown'), true), this.options.openTimeoutMs ?? 60000);
            try {
                page.source.revealOwner();
                this.options.sendOpen(owner.frame, {
                    epoch: owner.epoch,
                    requestId: id,
                    target: target.target,
                });
            }
            catch {
                pending.settle(fail('result_unknown'), true);
            }
        });
    }
    reply(sender, input) {
        const value = record(input);
        const pending = typeof value?.requestId === 'string' ? this.opens.get(value.requestId) : undefined;
        if (!pending ||
            pending.owner.host !== sender.sender ||
            pending.owner.frame !== sender.senderFrame ||
            pending.owner.epoch !== value?.epoch ||
            !this.ownerCurrent(pending.owner))
            return;
        pending.settle(parseMiniAppHostOpenResponse(value.result) ?? fail('result_unknown'));
    }
    dispose() {
        this.closed = true;
        this.stopPermissions();
        for (const owner of [...this.owners.values()])
            this.endOwner(owner.host, owner);
        for (const page of [...this.pages.values()])
            this.endPage(page);
    }
    page(sender) {
        if (this.closed)
            return null;
        const source = this.options.manager.captureMiniAppHostSource(sender.sender, sender.senderFrame);
        if (!source || !source.isCurrent())
            return null;
        const existing = this.pages.get(sender.sender);
        if (existing?.source.isCurrent())
            return existing;
        if (existing)
            this.endPage(existing);
        const page = {
            source,
            subscriptions: new Map(),
            key: randomUUID(),
            navigationRevision: -1,
            dispose: () => { },
        };
        this.pages.set(source.page, page);
        const stopDocument = this.options.manager.observeMiniAppHostEnd(source.page, () => this.endPage(page));
        const stopVisibility = this.options.manager.observeMiniAppVisibility(source.page, () => {
            const permissionReads = new Map();
            for (const subscription of page.subscriptions.values())
                void this.deliver(page, subscription, permissionReads);
        });
        page.dispose = () => {
            stopDocument();
            stopVisibility();
        };
        return page;
    }
    ownerCurrent(owner) {
        try {
            return (this.owners.get(owner.host) === owner &&
                !owner.host.isDestroyed() &&
                owner.host.mainFrame === owner.frame &&
                !owner.frame.detached);
        }
        catch {
            return false;
        }
    }
    ownerFor(page) {
        const owner = this.owners.get(page.source.owner);
        return page.source.isCurrent() &&
            owner &&
            owner.frame === page.source.ownerFrame &&
            this.ownerCurrent(owner)
            ? owner
            : null;
    }
    snapshot(page, module) {
        const owner = this.ownerFor(page);
        if (!owner?.state)
            return fail('host_unavailable');
        if (module === 'ui')
            return { success: true, state: { ...owner.state.ui } };
        if (!owner.state.navigation)
            return fail('host_unavailable');
        if (!page.source.isVisible())
            return fail('not_permitted');
        if (page.navigationRevision !== owner.navigationRevision) {
            page.key = randomUUID();
            page.navigationRevision = owner.navigationRevision;
        }
        const { view, overlay } = owner.state.navigation;
        return {
            success: true,
            state: { key: page.key, view, overlay: overlay ? { type: 'settings' } : null },
        };
    }
    async authorizeNavigation(page, allowHidden = false, permissionReads) {
        const epoch = this.permissionEpochs.get(page.source.pluginId) ?? 0;
        if (!page.source.isCurrent())
            return 'host_unavailable';
        if (this.options.isNavigationRevoking(page.source.pluginId))
            return 'not_permitted';
        if (!allowHidden && !page.source.isVisible())
            return 'not_permitted';
        let enabled = false;
        let unavailable = false;
        try {
            const pluginId = page.source.pluginId;
            let read = permissionReads?.get(pluginId);
            if (!read || read.epoch !== epoch) {
                read = { epoch, result: this.options.isNavigationEnabled(pluginId) };
                permissionReads?.set(pluginId, read);
            }
            enabled = await read.result;
        }
        catch {
            unavailable = true;
        }
        if (!page.source.isCurrent() || this.pages.get(page.source.page) !== page)
            return 'host_unavailable';
        if (this.options.isNavigationRevoking(page.source.pluginId) ||
            epoch !== (this.permissionEpochs.get(page.source.pluginId) ?? 0) ||
            (!allowHidden && !page.source.isVisible()))
            return 'not_permitted';
        if (unavailable)
            return 'host_unavailable';
        return enabled ? null : 'not_permitted';
    }
    async deliver(page, subscription, permissionReads) {
        const revision = ++subscription.pendingRevision;
        // Hidden navigation observers stay registered but receive no hidden history.
        if (subscription.module === 'navigation' && !page.source.isVisible())
            return;
        const permission = subscription.module === 'navigation'
            ? await this.authorizeNavigation(page, false, permissionReads)
            : null;
        if (page.subscriptions.get(subscription.id) !== subscription ||
            revision !== subscription.pendingRevision)
            return;
        if (permission) {
            // Visibility changed during the asynchronous gate: pause rather than revoke the subscription.
            if (permission === 'not_permitted' && !page.source.isVisible())
                return;
            this.endSubscription(page, subscription, permission);
            return;
        }
        // A route/presentation transition invalidates only navigation, not the live UI stream.
        if (subscription.module === 'navigation' && this.ownerFor(page)?.state?.navigation === null)
            return;
        const snapshot = this.snapshot(page, subscription.module);
        if (!snapshot.success)
            this.endSubscription(page, subscription, snapshot.code);
        else
            this.sendState(page, subscription, snapshot);
    }
    sendState(page, subscription, response) {
        if (!page.source.isCurrent() || page.subscriptions.get(subscription.id) !== subscription)
            return;
        const json = JSON.stringify(response.state);
        if (json === subscription.delivered)
            return;
        subscription.delivered = json;
        try {
            this.options.sendEvent(page.source.frame, {
                subscriptionId: subscription.id,
                revision: ++subscription.revision,
                state: response.state,
            });
        }
        catch {
            this.endPage(page);
        }
    }
    endSubscription(page, subscription, code) {
        if (page.subscriptions.get(subscription.id) !== subscription)
            return;
        page.subscriptions.delete(subscription.id);
        try {
            this.options.sendEvent(page.source.frame, {
                subscriptionId: subscription.id,
                error: { code },
            });
        }
        catch {
            /* Page teardown requires no reply. */
        }
    }
    endPage(page) {
        if (this.pages.get(page.source.page) !== page)
            return;
        this.pages.delete(page.source.page);
        page.dispose();
        for (const subscription of [...page.subscriptions.values()])
            this.endSubscription(page, subscription, 'host_unavailable');
        for (const pending of [...this.opens.values()])
            if (pending.page === page)
                pending.settle(fail('result_unknown'), true);
    }
    endOwner(host, expected) {
        const owner = this.owners.get(host);
        if (!owner || (expected && expected !== owner))
            return;
        this.owners.delete(host);
        owner.dispose();
        for (const page of this.pages.values())
            if (page.source.owner === host) {
                for (const subscription of [...page.subscriptions.values()])
                    this.endSubscription(page, subscription, 'host_unavailable');
                page.navigationRevision = -1;
            }
        for (const pending of [...this.opens.values()])
            if (pending.owner === owner)
                pending.settle(fail('result_unknown'), true);
    }
}

