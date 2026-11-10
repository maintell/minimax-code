/** Main-only revocation intent while the Runtime permission write is still awaiting a result. */
const pendingRevocations = new Map();
/** Each write owns one token: an earlier result cannot release a later revocation's gate. */
export function beginMiniAppNavigationRevocation(pluginId) {
    const token = Symbol('navigation-revocation');
    const pending = pendingRevocations.get(pluginId) ?? new Set();
    pending.add(token);
    pendingRevocations.set(pluginId, pending);
    return () => {
        pending.delete(token);
        if (pending.size === 0 && pendingRevocations.get(pluginId) === pending)
            pendingRevocations.delete(pluginId);
    };
}
/** This is only an in-flight gate; after release every authorization reads the Runtime again. */
export function isMiniAppNavigationRevoking(pluginId) {
    return (pendingRevocations.get(pluginId)?.size ?? 0) > 0;
}
