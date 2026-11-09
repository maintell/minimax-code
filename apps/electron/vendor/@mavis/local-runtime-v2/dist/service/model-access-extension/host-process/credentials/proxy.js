import { captureHostContext } from '../shim/context.js';
export function hostContextInput(context) {
    context.signal.throwIfAborted();
    return captureHostContext({
        profileId: context.profileId,
        installationId: context.installationId,
        generation: context.generation,
        operationId: context.operationId,
        enabledTargets: context.enabledTargets,
        policyRevision: context.policyRevision,
        dataDir: context.dataDir,
        hostDataDir: context.hostDataDir,
        ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
    });
}
export function createModelAccessHostOwnedHandlers(peer, providerId, methods) {
    const handlers = {};
    for (const method of ['resolveOwned', 'renewOwned', 'forceRenewOwned']) {
        if (!methods.includes(method))
            continue;
        handlers[method] = (context, binding, value) => peer.request(method, { providerId, context: hostContextInput(context), binding, value }, { signal: context.signal, settleOnAbort: method !== 'resolveOwned' });
    }
    if (methods.includes('forget'))
        handlers.forget = async (context, binding, value) => {
            await peer.request('forget', { providerId, context: hostContextInput(context), binding, value }, { signal: context.signal, settleOnAbort: true });
        };
    return Object.freeze(handlers);
}
export function createModelAccessHostBorrowHandlers(peer, sourceId, variant, methods) {
    const resolve = (context, source) => peer.request('borrow.resolve', {
        sourceId,
        variant,
        context: hostContextInput(context),
        source,
    }, { signal: context.signal });
    const handlers = { resolve };
    for (const method of ['renew', 'forceRenew']) {
        if (!methods.includes(method))
            continue;
        handlers[method] = (context, source, value) => peer.request(`borrow.${method}`, {
            sourceId,
            variant,
            context: hostContextInput(context),
            source,
            value,
        }, { signal: context.signal, settleOnAbort: true });
    }
    return Object.freeze(handlers);
}
//# sourceMappingURL=proxy.js.map