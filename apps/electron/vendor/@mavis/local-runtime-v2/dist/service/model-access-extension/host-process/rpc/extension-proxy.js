import { validateHostModelAccessExtension } from '../../core/extension-validation.js';
import { captureRequestModels, captureRequestUsage } from '../../request/catalog-validation.js';
import { captureModuleLimits, noteProviderLimits } from '../../request/admission.js';
import { captureApiCandidates } from '../../api-scan/validation.js';
import { createModelAccessHostBorrowHandlers, createModelAccessHostOwnedHandlers, hostContextInput, } from '../credentials/proxy.js';
import { createModelAccessHostLoginHandler } from '../login-proxy.js';
import { createModelAccessHostClassifier, createModelAccessHostTransport, } from '../proxy.js';
export async function createModelAccessHostExtension(peer, manifest) {
    const description = await peer.request('describe', {});
    validateDescription(description, manifest);
    const providers = Object.create(null);
    for (const provider of manifest.providers) {
        const providerId = provider.id;
        const methods = description.providers[providerId];
        providers[providerId] = {
            ...createModelAccessHostOwnedHandlers(peer, providerId, methods),
            models: async (context, binding, credential) => {
                const result = await peer.request('models', { providerId, context: hostContextInput(context), binding, credential }, { signal: context.signal, settleOnAbort: true });
                context.signal.throwIfAborted();
                return captureRequestModels(result);
            },
            bindTransport: async (context, credential, model) => {
                const metadata = await peer.request('bindTransport', {
                    providerId,
                    context: hostContextInput(context),
                    credential,
                    model,
                }, { signal: context.signal, settleOnAbort: true });
                const transport = createModelAccessHostTransport(peer, metadata);
                if (context.signal.aborted) {
                    await transport.dispose?.();
                    context.signal.throwIfAborted();
                }
                return transport;
            },
            classifyError: createModelAccessHostClassifier(peer, providerId),
            ...(methods.includes('usage')
                ? {
                    usage: async (context, binding, credential) => {
                        const result = await peer.request('usage', { providerId, context: hostContextInput(context), binding, credential }, { signal: context.signal, settleOnAbort: true });
                        context.signal.throwIfAborted();
                        return captureRequestUsage(result);
                    },
                }
                : {}),
        };
    }
    const sources = sourceHandlers(peer, manifest, description);
    const extension = validateHostModelAccessExtension(manifest, { providers, sources });
    noteProviderLimits(extension.providers, captureModuleLimits(description.limits, manifest.providers.map((provider) => provider.id)));
    return extension;
}
function sourceHandlers(peer, manifest, description) {
    const sources = Object.create(null);
    for (const source of manifest.sources) {
        const described = description.sources[source.id];
        const login = Object.create(null);
        for (const method of source.capabilities.login?.methods ?? []) {
            login[method.id] = {
                begin(context, input) {
                    const providerId = input.providerId;
                    if (!providerId ||
                        !manifest.providers.some((item) => item.id === providerId && item.credentialKinds.includes('direct-owned')))
                        throw new Error('host_login_provider_required');
                    return createModelAccessHostLoginHandler(peer, {
                        providerId,
                        sourceId: source.id,
                        methodId: method.id,
                        kind: method.kind,
                    }).begin(context, input);
                },
            };
        }
        const subscriptionBorrow = Object.create(null);
        for (const variant of source.capabilities.subscriptionBorrow?.variants ?? []) {
            subscriptionBorrow[variant.id] = {
                ...createModelAccessHostBorrowHandlers(peer, source.id, variant.id, described.subscriptionBorrow[variant.id]),
                discover: async (context) => {
                    const result = await peer.request('borrow.discover', { sourceId: source.id, entryId: variant.id, context: hostContextInput(context) }, { signal: context.signal, settleOnAbort: true });
                    context.signal.throwIfAborted();
                    return result;
                },
            };
        }
        const apiKeyScan = Object.create(null);
        for (const reader of source.capabilities.apiKeyScan?.readers ?? []) {
            apiKeyScan[reader.id] = {
                async scan(context) {
                    const result = await peer.request('apiKeyScan.scan', { sourceId: source.id, entryId: reader.id, context: hostContextInput(context) }, { signal: context.signal, settleOnAbort: true });
                    context.signal.throwIfAborted();
                    return captureApiCandidates(result, context.enabledTargets);
                },
            };
        }
        sources[source.id] = selectedCapabilities(source, { login, subscriptionBorrow, apiKeyScan });
    }
    return sources;
}
function selectedCapabilities(source, handlers) {
    return {
        ...(source.capabilities.login ? { login: handlers.login } : {}),
        ...(source.capabilities.subscriptionBorrow
            ? { subscriptionBorrow: handlers.subscriptionBorrow }
            : {}),
        ...(source.capabilities.apiKeyScan ? { apiKeyScan: handlers.apiKeyScan } : {}),
    };
}
function validateDescription(value, manifest) {
    const methods = (names) => {
        if (!Array.isArray(names) ||
            names.some((item) => typeof item !== 'string') ||
            new Set(names).size !== names.length)
            throw new Error('host_describe_invalid');
        return Object.fromEntries(names.map((method) => [method, () => { }]));
    };
    try {
        const providers = Object.fromEntries(Object.entries(value.providers).map(([id, entries]) => [id, methods(entries)]));
        const sources = Object.fromEntries(Object.entries(value.sources).map(([id, capabilities]) => [
            id,
            Object.fromEntries(Object.entries(capabilities).map(([capability, entries]) => [
                capability,
                Object.fromEntries(Object.entries(entries).map(([entry, names]) => [entry, methods(names)])),
            ])),
        ]));
        validateHostModelAccessExtension(manifest, { providers, sources });
    }
    catch {
        throw new Error('host_describe_invalid');
    }
}
//# sourceMappingURL=extension-proxy.js.map