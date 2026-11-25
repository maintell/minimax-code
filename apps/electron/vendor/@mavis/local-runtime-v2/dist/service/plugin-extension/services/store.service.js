import { logger } from '../../../infra/logging/logger.js';
import { settleInBackground } from '../../../infra/async/settle.js';
import { ExtensionKvStore, } from '../storage/extension-store.js';
/**
 * The one place an activation's store is chosen: a preview reads and writes its session
 * overlay, any other tier the installed data.
 */
function storeViewOf(origin) {
    return origin.tier === 'preview'
        ? { pluginId: origin.pluginId, overlaySessionId: origin.sessionId }
        : { pluginId: origin.pluginId };
}
/** `ctx.store`: namespace and view come from the host-stamped origin, never from arguments. */
export class ExtensionStoreService {
    boundary;
    invocations;
    kv;
    subscriptions = new Map();
    nextSubscriptionId = 0;
    constructor(boundary, invocations, options) {
        this.boundary = boundary;
        this.invocations = invocations;
        this.kv = new ExtensionKvStore(options.root, {
            ...(options.limits ? { limits: options.limits } : {}),
            onChange: (change) => settleInBackground(this.fanOut(change)),
        });
    }
    async get(callId, key) {
        return this.boundary.run({ callId, domain: 'store', method: 'get' }, async (invocation) => this.kv.get(storeViewOf(invocation.origin), key));
    }
    async set(callId, key, value) {
        await this.boundary.run({ callId, domain: 'store', method: 'set' }, async (invocation) => this.kv.set(storeViewOf(invocation.origin), key, value));
    }
    async delete(callId, key) {
        await this.boundary.run({ callId, domain: 'store', method: 'delete' }, async (invocation) => this.kv.delete(storeViewOf(invocation.origin), key));
    }
    async keys(callId) {
        return this.boundary.run({ callId, domain: 'store', method: 'keys' }, async (invocation) => this.kv.keys(storeViewOf(invocation.origin)));
    }
    onDidChange(callId, handle) {
        return this.boundary.runSync({ callId, domain: 'store', method: 'onDidChange' }, (invocation) => {
            this.nextSubscriptionId += 1;
            this.subscriptions.set(this.nextSubscriptionId, { origin: invocation.origin, handle });
            return this.nextSubscriptionId;
        });
    }
    unsubscribe(activationId, subscriptionId) {
        if (this.subscriptions.get(subscriptionId)?.origin.activationId === activationId) {
            this.subscriptions.delete(subscriptionId);
        }
    }
    disposeActivation(activationId) {
        for (const [id, subscription] of this.subscriptions) {
            if (subscription.origin.activationId === activationId)
                this.subscriptions.delete(id);
        }
    }
    /**
     * A write reaches listeners whose view sees it: an overlay write only its own session's
     * preview listeners; an installed write every installed listener plus preview listeners whose
     * overlay does not hide the key. Each listener gets the value of its own view.
     */
    async fanOut(change) {
        for (const subscription of [...this.subscriptions.values()]) {
            try {
                if (!(await this.reaches(subscription.origin, change)))
                    continue;
                const value = await this.kv.get(storeViewOf(subscription.origin), change.key);
                this.invocations.launch({
                    origin: subscription.origin,
                    handle: subscription.handle,
                    change: { key: change.key, value },
                });
            }
            catch (error) {
                logger.warn({ plugin_id: change.pluginId, error: error instanceof Error ? error.name : 'unknown' }, 'plugin-extension.store.change_delivery_failed');
            }
        }
    }
    async reaches(origin, change) {
        if (origin.pluginId !== change.pluginId)
            return false;
        const { overlaySessionId } = storeViewOf(origin);
        if (change.overlaySessionId !== undefined)
            return overlaySessionId === change.overlaySessionId;
        return (overlaySessionId === undefined ||
            !(await this.kv.shadows(origin.pluginId, overlaySessionId, change.key)));
    }
}
//# sourceMappingURL=store.service.js.map