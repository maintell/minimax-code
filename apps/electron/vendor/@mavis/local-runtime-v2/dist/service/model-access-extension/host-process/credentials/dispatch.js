import { signInRevoked } from '../../core/context.js';
import { captureHostContext } from '../shim/context.js';
export const CREDENTIAL_METHODS = new Set([
    'resolveOwned',
    'renewOwned',
    'forceRenewOwned',
    'forget',
    'borrow.resolve',
    'borrow.renew',
    'borrow.forceRenew',
]);
export async function dispatchCredential(method, value, signal, extension) {
    if (!value || typeof value !== 'object')
        throw new Error('host_credential_invalid');
    const params = value;
    signal.throwIfAborted();
    const input = captureHostContext(params.context);
    const context = Object.freeze({
        ...input,
        enabledTargets: input.enabledTargets ?? [],
        policyRevision: input.policyRevision ?? 0,
        signal,
    });
    return method.startsWith('borrow.')
        ? dispatchBorrow(method, params, context, extension)
        : dispatchOwned(method, params, context, extension);
}
function dispatchBorrow(method, params, context, extension) {
    const handler = extension.sources[params.sourceId ?? '']?.subscriptionBorrow?.[params.variant ?? ''];
    if (!handler)
        throw new Error('host_credential_invalid');
    validateBorrowSource(params, context);
    if (method === 'borrow.resolve')
        return handler.resolve(context, params.source);
    const renew = method === 'borrow.renew' ? handler.renew : handler.forceRenew;
    if (!renew)
        throw new Error('host_method_unavailable');
    return renew.call(handler, context, params.source, params.value);
}
function validateBorrowSource(params, context) {
    if (params.source?.installationId !== context.installationId ||
        params.source.sourceId !== params.sourceId ||
        params.source.variant !== params.variant ||
        !context.enabledTargets.includes(params.source.target))
        throw new Error('host_credential_invalid');
}
async function dispatchOwned(method, params, context, extension) {
    const handler = extension.providers[params.providerId ?? ''];
    if (!handler)
        throw new Error('host_credential_invalid');
    validateOwnedBinding(params, context);
    if (method === 'resolveOwned' && handler.resolveOwned)
        return handler.resolveOwned(context, params.binding, params.value);
    if (method === 'forget' && handler.forget) {
        await handler.forget(context, params.binding, params.value);
        return null;
    }
    if (method !== 'renewOwned' && method !== 'forceRenewOwned')
        throw new Error('host_method_unavailable');
    const renew = handler[method];
    if (!renew)
        throw new Error('host_method_unavailable');
    return renewOwned(renew.bind(handler), context, params);
}
async function renewOwned(renew, context, params) {
    try {
        return await renew(context, params.binding, params.value);
    }
    catch (error) {
        if (signInRevoked(error))
            throw Object.assign(new Error('auth_revoked'), { code: 'auth_revoked' });
        throw error;
    }
}
function validateOwnedBinding(params, context) {
    if (params.binding?.providerId !== params.providerId ||
        params.binding.installationId !== context.installationId ||
        params.binding.kind !== 'direct-owned')
        throw new Error('host_credential_invalid');
}
//# sourceMappingURL=dispatch.js.map