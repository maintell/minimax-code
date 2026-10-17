import { CUSTOM_PROVIDER_ID_PREFIX, formatModelKey } from '../config/model-key.js';
import { generateProviderKey } from './provider-key.js';
import { LocalModelProviderError } from './service-contract.js';
import { nextDuplicateProviderName, removeLegacyCustomProviderNpm, resetUnavailableCustomDefaultModel, } from './service-helpers.js';
import { assertValidRawApiKey, mergeModelsFromInputs, modelsFromInputs, normalizeApiFormat, normalizeProviderCredentialUpdate, normalizeHeaderNames, normalizeHeaders, removeHeaderCaseInsensitive, } from './service-input.js';
export async function createUserProvider(context, input) {
    if (input.saveAndUse) {
        throw new LocalModelProviderError(409, 'Test the saved provider configuration before activating it', 'TEST_REQUIRED');
    }
    const apiKey = assertValidRawApiKey(input.apiKey);
    const baseUrl = input.baseUrl?.trim();
    if (!baseUrl) {
        throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
    }
    const apiFormat = normalizeApiFormat(input.apiFormat);
    const headers = normalizeHeaders(input.headers);
    const name = input.name?.trim();
    let providerKey = '';
    await context.deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        providerKey = generateProviderKey({
            displayName: name,
            existingKeys: Object.keys(tree),
            ...(context.deps.randomHex ? { randomHex: context.deps.randomHex } : {}),
        });
        tree[providerKey] = {
            ...(name ? { name } : {}),
            kind: 'custom',
            enabled: true,
            ...(apiFormat ? { api: apiFormat } : {}),
            options: {
                apiKey,
                baseURL: baseUrl,
                authMode: 'api-key',
                ...(headers ? { headers } : {}),
            },
            ...(input.models
                ? {
                    models: modelsFromInputs(input.models, undefined, context.deps.implicitCustomProviderThinking === true),
                }
                : {}),
        };
        draft.custom_provider = tree;
    });
    return context.requireCustomProviderView(providerKey);
}
export async function updateUserProvider(context, input) {
    const providerKey = context.requireExistingProviderKey(input.providerId);
    // Tri-state api_key: absent keeps the stored key, empty string clears it,
    // masked placeholders are rejected so a sanitized read can't be written back.
    const apiKeyUpdate = normalizeProviderCredentialUpdate({ apiKey: input.apiKey });
    const baseUrl = input.baseUrl?.trim();
    if (input.baseUrl !== undefined && !baseUrl) {
        throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
    }
    const apiFormat = input.apiFormat !== undefined ? normalizeApiFormat(input.apiFormat) : undefined;
    const headers = input.headers !== undefined ? normalizeHeaders(input.headers) : undefined;
    const removeHeaders = normalizeHeaderNames(input.removeHeaders);
    await context.deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        const provider = tree[providerKey];
        if (!provider)
            return;
        removeLegacyCustomProviderNpm(provider);
        // provider_key is immutable: renames only change the display name.
        if (input.name !== undefined)
            provider.name = input.name.trim();
        if (input.enabled !== undefined)
            provider.enabled = input.enabled;
        if (apiFormat !== undefined)
            provider.api = apiFormat;
        if (input.models !== undefined) {
            provider.models = mergeModelsFromInputs(provider.models, input.models, context.deps.implicitCustomProviderThinking === true);
        }
        const options = { ...(provider.options ?? {}) };
        if (baseUrl !== undefined)
            options.baseURL = baseUrl;
        if (apiKeyUpdate.kind === 'set')
            options.apiKey = apiKeyUpdate.apiKey;
        if (apiKeyUpdate.kind === 'clear')
            delete options.apiKey;
        if (input.headers !== undefined || removeHeaders.length > 0) {
            const nextHeaders = { ...(options.headers ?? {}) };
            for (const name of removeHeaders)
                removeHeaderCaseInsensitive(nextHeaders, name);
            for (const [name, value] of Object.entries(headers ?? {})) {
                removeHeaderCaseInsensitive(nextHeaders, name);
                nextHeaders[name] = value;
            }
            if (Object.keys(nextHeaders).length > 0)
                options.headers = nextHeaders;
            else
                delete options.headers;
        }
        provider.options = options;
        draft.custom_provider = tree;
        resetUnavailableCustomDefaultModel(draft);
    });
    if (input.saveAndUse) {
        const provider = context.deps.configGetter().custom_provider?.[providerKey];
        const firstModelId = Object.keys(provider?.models ?? {})[0];
        if (firstModelId) {
            const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
            context.resolveTestTarget(providerId, firstModelId);
            await context.deps.selectModel(formatModelKey(providerId, firstModelId));
        }
    }
    return context.requireCustomProviderView(providerKey);
}
export async function duplicateUserProvider(context, input) {
    const sourceProviderKey = context.requireExistingProviderKey(input.providerId);
    let duplicateProviderKey = '';
    await context.deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        const source = tree[sourceProviderKey];
        if (!source) {
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        }
        const duplicateName = nextDuplicateProviderName({
            requestedName: input.name,
            sourceName: source.name,
            sourceProviderKey,
            providers: tree,
        });
        duplicateProviderKey = generateProviderKey({
            displayName: duplicateName,
            existingKeys: Object.keys(tree),
            ...(context.deps.randomHex ? { randomHex: context.deps.randomHex } : {}),
        });
        const duplicate = structuredClone(source);
        removeLegacyCustomProviderNpm(duplicate);
        tree[duplicateProviderKey] = { ...duplicate, name: duplicateName };
        draft.custom_provider = tree;
    });
    return context.requireCustomProviderView(duplicateProviderKey);
}
export async function deleteUserProvider(context, input) {
    const providerKey = context.requireExistingProviderKey(input.providerId);
    await context.deps.updateByokConfig((draft) => {
        const tree = (draft.custom_provider ?? {});
        delete tree[providerKey];
        draft.custom_provider =
            Object.keys(tree).length > 0 ? tree : undefined;
        resetUnavailableCustomDefaultModel(draft);
    });
    await context.deps.cache.removeProvider(`${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`);
}
//# sourceMappingURL=service-custom-provider-operations.js.map