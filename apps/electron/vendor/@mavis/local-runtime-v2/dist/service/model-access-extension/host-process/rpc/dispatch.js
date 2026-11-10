import { captureApiCandidates } from '../../api-scan/validation.js';
import { captureBorrowDiscoveries } from '../../borrow/validation.js';
import { captureRequestUsage } from '../../request/catalog-validation.js';
import { captureIdentity, captureSourceRef } from '../../credentials/credential-state.js';
import { captureHostContext } from '../shim/context.js';
export const AUXILIARY_METHODS = new Set([
    'usage',
    'borrow.discover',
    'apiKeyScan.scan',
]);
export async function dispatchAuxiliary(method, value, signal, owner) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        invalid();
    const params = value;
    const captured = captureHostContext(params.context);
    const context = Object.freeze({
        ...captured,
        enabledTargets: Object.freeze([...(captured.enabledTargets ?? [])]),
        policyRevision: captured.policyRevision,
        signal,
    });
    signal.throwIfAborted();
    if (method === 'usage')
        return usage(params, context, owner);
    if (method !== 'apiKeyScan.scan' && method !== 'borrow.discover')
        unavailable();
    return sourceCall(method, params, context, owner);
}
async function usage(params, context, { extension, manifest }) {
    const provider = manifest.providers.find((entry) => entry.id === params.providerId);
    const binding = params.binding;
    if (!provider ||
        !binding ||
        binding.installationId !== context.installationId ||
        binding.providerId !== params.providerId ||
        !provider.credentialKinds.includes(binding.kind))
        invalid();
    validateCredential(params);
    const handler = extension.providers[params.providerId];
    if (!handler?.usage)
        unavailable();
    const result = await handler.usage(context, binding, params.credential);
    context.signal.throwIfAborted();
    return captureRequestUsage(result);
}
function validateCredential(params) {
    if (!params.credential || typeof params.credential !== 'object')
        invalid();
    if (params.binding.kind === 'public') {
        if (!params.credential.identity ||
            !('public' in params.credential.identity) ||
            params.credential.identity.public !== true)
            invalid();
        return;
    }
    captureIdentity(params.credential.identity, params.providerId);
    if (params.binding.kind === 'borrowed-current') {
        const sourceRef = captureSourceRef(params.binding.sourceRef);
        if (sourceRef.installationId !== params.context.installationId)
            invalid();
    }
}
function validateEntry(method, params, context, manifest) {
    const source = manifest.sources.find((entry) => entry.id === params.sourceId);
    const capability = method === 'apiKeyScan.scan' ? 'apiKeyScan' : 'subscriptionBorrow';
    const entries = capability === 'apiKeyScan'
        ? source?.capabilities.apiKeyScan?.readers
        : source?.capabilities.subscriptionBorrow?.variants;
    const entry = entries?.find((item) => item.id === params.entryId);
    if (!entry)
        invalid();
    if (!context.enabledTargets.length ||
        new Set(context.enabledTargets).size !== context.enabledTargets.length ||
        context.enabledTargets.some((target) => !entry.targets.includes(target)))
        invalid();
}
async function sourceCall(method, params, context, { extension, manifest }) {
    validateEntry(method, params, context, manifest);
    const handlers = extension.sources[params.sourceId];
    if (method === 'apiKeyScan.scan') {
        const handler = handlers?.apiKeyScan?.[params.entryId];
        if (!handler)
            unavailable();
        const result = await handler.scan(context);
        context.signal.throwIfAborted();
        return captureApiCandidates(result, context.enabledTargets);
    }
    const handler = handlers?.subscriptionBorrow?.[params.entryId];
    if (!handler)
        unavailable();
    const result = await handler.discover(context);
    context.signal.throwIfAborted();
    if (!Array.isArray(result) || result.length > 256)
        invalid();
    return result.flatMap((item) => {
        if (!item || !context.enabledTargets.includes(item.sourceRef?.target))
            invalid();
        if (!manifest.providers.some((provider) => provider.id === item.providerId))
            invalid();
        return captureBorrowDiscoveries([item], {
            installationId: context.installationId,
            sourceId: params.sourceId,
            variant: params.entryId,
            target: item.sourceRef.target,
            selector: 'current',
        });
    });
}
function invalid() {
    throw Object.assign(new Error('host_rpc_invalid'), { code: 'host_rpc_invalid' });
}
function unavailable() {
    throw Object.assign(new Error('host_method_unavailable'), { code: 'host_method_unavailable' });
}
//# sourceMappingURL=dispatch.js.map