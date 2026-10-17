import { probeProviderCredential } from '@mavis/config';
import { MINIMAX_API_PROVIDER_ID, parseProviderId } from '../resolution/model-key.js';
import { minimaxApiBaseUrl, minimaxApiModels } from './minimax-api.js';
import { modelCacheStatusFor, modelConfigFingerprint, } from './model-cache.js';
import { mergeProviderHeaders, normalizeProviderBaseUrl, } from '../connectivity/provider-request.js';
export function byokModelTestStatus(config, cache, providerId, modelId) {
    const parsed = parseProviderId(providerId);
    if (parsed?.source === 'minimax_api') {
        return minimaxModelTestStatus(config, cache, modelId);
    }
    if (parsed?.source !== 'custom_provider')
        return undefined;
    return customModelTestStatus({
        config,
        cache,
        providerId,
        providerKey: parsed.providerKey,
        modelId,
    });
}
function minimaxModelTestStatus(config, cache, modelId) {
    const apiKey = probeProviderCredential({
        field: 'minimax_api.apiKey',
        provider: 'minimax_api',
        value: config.minimax_api?.apiKey,
    }).secret;
    const model = minimaxApiModels(config)[modelId];
    if (!apiKey || !model)
        return undefined;
    const fingerprint = modelConnectionTestFingerprint({
        api: 'anthropic-messages',
        baseUrl: normalizeProviderBaseUrl('anthropic-messages', minimaxApiBaseUrl(config)),
        apiKey,
        modelId,
    }, model);
    return modelCacheStatusFor(cache, MINIMAX_API_PROVIDER_ID, modelId, fingerprint);
}
function customModelTestStatus(input) {
    const { config, cache, providerId, modelId } = input;
    const provider = config.custom_provider?.[input.providerKey];
    const apiKey = probeProviderCredential({
        field: 'options.apiKey',
        provider: providerId,
        value: provider?.options?.apiKey,
    }).secret;
    const baseUrl = provider?.options?.baseURL?.trim();
    const model = provider?.models?.[modelId];
    if (!provider || provider.enabled === false || !apiKey || !baseUrl || !model)
        return undefined;
    const api = (provider.api?.trim() || 'anthropic-messages');
    const headers = mergeProviderHeaders(provider.options?.headers, model.headers);
    const fingerprint = modelConnectionTestFingerprint({
        api,
        baseUrl: normalizeProviderBaseUrl(api, baseUrl),
        apiKey,
        modelId,
        ...(headers ? { headers } : {}),
    }, model);
    return modelCacheStatusFor(cache, providerId, modelId, fingerprint);
}
/**
 * Fingerprint only fields exercised by the text connectivity probe.
 * Attachment declarations are persisted capabilities and are intentionally
 * excluded because the probe never uploads an attachment.
 */
export function modelConnectionTestFingerprint(target, model) {
    if (!model)
        return modelConfigFingerprint({ target, model });
    const testedModel = { ...model };
    delete testedModel.attachment;
    delete testedModel.configuration_source;
    delete testedModel.modalities;
    return modelConfigFingerprint({ target: withoutProbeOutputLimit(target), model: testedModel });
}
/**
 * `outputLimit` restates `model.limit.output`, which the hashed model already
 * covers. Hashing both would make the fingerprint depend on whether the caller
 * remembered to set a field it does not decide.
 */
function withoutProbeOutputLimit(target) {
    if (!target || typeof target !== 'object' || Array.isArray(target))
        return target;
    const rest = { ...target };
    delete rest.outputLimit;
    return rest;
}
//# sourceMappingURL=config-fingerprint.js.map