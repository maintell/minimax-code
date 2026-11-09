import { enabledCustomProviders } from '../catalog/list-models.js';
import { MINIMAX_API_PROVIDER_ID } from '../identity.js';
import { LocalModelProviderError } from '../contracts.js';
import { discoverUserModelsCandidate as discoverUserModelsCandidateOperation, saveUserModelProviderCandidate as saveUserModelProviderCandidateOperation, testUserModelCandidate as testUserModelCandidateOperation, updateUserModelParameters as updateUserModelParametersOperation, } from './service-candidate-operations.js';
import { assertModelSelectable as assertModelSelectableOperation, discoverModels as discoverModelsOperation, testModel as testModelOperation, testProvider as testProviderOperation, } from './service-connection-operations.js';
import { ModelProviderServiceContext } from './service-context.js';
import { testUserModelApiKey as testUserModelApiKeyOperation, unrestUserModelApiKey as unrestUserModelApiKeyOperation, } from '../byok-keys/operations.js';
import { readApiKeys } from '../byok-keys/key-list.js';
import { customProviderViewOptions, modelAccessBindingMissingError } from './service-helpers.js';
import { modelAccessCatalogCurrent as modelAccessCatalogCurrentOperation, queryModelAccessUsage as queryModelAccessUsageOperation, upsertModelAccessProvider as upsertModelAccessProviderOperation, adoptModelAccessInstallations, } from '../model-access/operations.js';
import { isModelAccessProvider, readModelAccessMetadata, } from '../model-access/projection.js';
import { getModelAccessFailover as getModelAccessFailoverOperation, setModelAccessFailover as setModelAccessFailoverOperation, } from '../failover/failover-operations.js';
import { parseProviderId } from '../resolution/model-key.js';
import { createUserProvider as createUserProviderOperation, deleteUserProvider as deleteUserProviderOperation, duplicateUserProvider as duplicateUserProviderOperation, updateUserProvider as updateUserProviderOperation, } from './service-custom-provider-operations.js';
import { deleteMinimaxApiKey as deleteMinimaxApiKeyOperation, getMinimaxApiKeyStatus as getMinimaxApiKeyStatusOperation, getMinimaxModelSource as getMinimaxModelSourceOperation, setMinimaxModelSource as setMinimaxModelSourceOperation, updateMinimaxModelContext as updateMinimaxModelContextOperation, upsertMinimaxApiKey as upsertMinimaxApiKeyOperation, } from './service-minimax-operations.js';
import {} from '../contracts.js';
import { buildBuiltinProviderView, buildCustomProviderView, } from '../catalog/provider-views.js';
export { LocalModelProviderError } from '../contracts.js';
/** Stable public facade for local model-provider operations. */
export class LocalModelProviderService {
    context;
    constructor(deps) {
        this.context = new ModelProviderServiceContext(deps);
    }
    /**
     * The config every catalog, selection and replacement read uses: agent model access
     * providers carry their committed catalog, and withdrawn ones are marked `withdrawn` so
     * they list no models and their references are replaced (never persisted).
     */
    modelCatalogConfig() {
        const config = this.context.deps.configGetter();
        const catalog = this.context.deps.modelAccess?.catalog;
        if (!catalog && !Object.values(config.custom_provider ?? {}).some(isModelAccessProvider))
            return config;
        return {
            ...config,
            custom_provider: Object.fromEntries(Object.entries(config.custom_provider ?? {}).map(([key, provider]) => {
                if (!isModelAccessProvider(provider))
                    return [key, provider];
                if (this.modelAccessWithdrawn(provider))
                    return [key, { ...provider, withdrawn: true }];
                return [key, catalog ? { ...provider, models: catalog(key) } : provider];
            })),
        };
    }
    /**
     * An agent model access provider this build or the server no longer offers: the build
     * does not ship model access (no owner), or the server turned the service or this
     * provider off. A missing sign-in is not withdrawal; the user can sign in again.
     */
    modelAccessWithdrawn(provider) {
        const access = this.context.deps.modelAccess;
        if (!access)
            return true;
        const meta = readModelAccessMetadata(provider);
        return access.withdrawn?.(meta?.providerId ?? '', meta?.installationId) === true;
    }
    loadCacheData() {
        return this.context.deps.cache.load();
    }
    listEffectiveProviders() {
        const config = this.context.deps.configGetter();
        const cache = this.context.deps.cache.load();
        // minimax_api models share the builtin MiniMax catalog. Source routing is
        // resolved at inference time, so only custom providers are appended here.
        const providers = Object.entries(config.provider ?? {}).map(([providerId, provider]) => buildBuiltinProviderView(config, cache, providerId, provider));
        const viewOptions = customProviderViewOptions(this.context.deps);
        for (const [providerKey, provider] of enabledCustomProviders(config)) {
            providers.push(buildCustomProviderView(config, cache, { providerKey, provider }, viewOptions));
        }
        return providers;
    }
    listVisibleUserProviders() {
        const config = this.modelCatalogConfig();
        const all = this.listUserProviders();
        const views = all.map((view) => {
            const key = parseProviderId(view.providerId)?.providerKey;
            if (!key || !view.modelAccess || view.modelAccess.groupProviderId !== view.providerId)
                return view;
            const provider = config.custom_provider?.[key];
            const grouped = provider
                ? buildCustomProviderView(config, this.context.deps.cache.load(), { providerKey: key, provider }, customProviderViewOptions(this.context.deps))
                : view;
            // The group row stands for its accounts: the anchor key is a stable route, not an account,
            // so it reads ready while any account of the group is ready.
            const accountReady = all.some((item) => item.modelAccess?.groupProviderId === view.providerId &&
                item.modelAccess.status === 'ready');
            return grouped.modelAccess && accountReady
                ? { ...grouped, modelAccess: { ...grouped.modelAccess, status: 'ready' } }
                : grouped;
        });
        return views.filter((p) => {
            if (!p.modelAccess)
                return true;
            const key = parseProviderId(p.providerId)?.providerKey ?? p.providerId;
            const provider = config.custom_provider?.[key];
            if (provider?.withdrawn === true)
                return false;
            return this.context.deps.modelAccess?.subscriptionAllowed?.(key) !== false;
        });
    }
    listUserProviders() {
        const config = this.context.deps.configGetter();
        const cache = this.context.deps.cache.load();
        const viewOptions = customProviderViewOptions(this.context.deps);
        return Object.entries(config.custom_provider ?? {}).map(([providerKey, provider]) => buildCustomProviderView(config, cache, { providerKey, provider }, viewOptions));
    }
    revealModelProviderApiKey(input) {
        const config = this.context.deps.configGetter();
        if (input.providerId === MINIMAX_API_PROVIDER_ID) {
            const apiKey = config.minimax_api?.apiKey;
            if (!apiKey?.trim()) {
                throw new LocalModelProviderError(400, 'MiniMax API key is not configured', 'NO_API_KEY');
            }
            return apiKey;
        }
        const identity = parseProviderId(input.providerId);
        const provider = identity?.source === 'custom_provider'
            ? config.custom_provider?.[identity.providerKey]
            : undefined;
        if (!provider) {
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        }
        assertProviderKeyRevealable(provider);
        const apiKey = input.keyId
            ? readApiKeys(provider).find((key) => key.id === input.keyId)?.key
            : provider.options?.apiKey;
        if (input.keyId && !apiKey) {
            throw new LocalModelProviderError(404, 'API key not found', 'API_KEY_NOT_FOUND');
        }
        if (!apiKey?.trim()) {
            throw new LocalModelProviderError(400, 'Provider API key is not configured', 'NO_API_KEY');
        }
        return apiKey;
    }
    getMinimaxApiKeyStatus() {
        return getMinimaxApiKeyStatusOperation(this.context);
    }
    getMinimaxModelSource() {
        return getMinimaxModelSourceOperation(this.context);
    }
    async setMinimaxModelSource(source) {
        return setMinimaxModelSourceOperation(this.context, source);
    }
    async updateMinimaxModelContext(input) {
        return updateMinimaxModelContextOperation(this.context, input);
    }
    async upsertMinimaxApiKey(input) {
        return upsertMinimaxApiKeyOperation(this.context, input);
    }
    async createUserProvider(input) {
        return createUserProviderOperation(this.context, input);
    }
    async updateUserProvider(input) {
        return updateUserProviderOperation(this.context, input);
    }
    async duplicateUserProvider(input) {
        return duplicateUserProviderOperation(this.context, input);
    }
    async testUserModelCandidate(candidate, modelId) {
        return testUserModelCandidateOperation(this.context, candidate, modelId);
    }
    async discoverUserModelsCandidate(candidate) {
        return discoverUserModelsCandidateOperation(this.context, candidate);
    }
    /** One key of a draft; remembers only its latest result (no rest, no reorder). */
    async testUserModelApiKey(input) {
        return testUserModelApiKeyOperation(this.context, input);
    }
    unrestUserModelApiKey(input) {
        return unrestUserModelApiKeyOperation(this.context, input);
    }
    async saveUserModelProviderCandidate(input) {
        return saveUserModelProviderCandidateOperation(this.context, input);
    }
    async updateUserModelParameters(input) {
        return updateUserModelParametersOperation(this.context, input);
    }
    async deleteUserProvider(input) {
        if (input.providerId === MINIMAX_API_PROVIDER_ID) {
            return deleteMinimaxApiKeyOperation(this.context);
        }
        return deleteUserProviderOperation(this.context, input);
    }
    async testProvider(providerId, opts) {
        return testProviderOperation(this.context, providerId, opts);
    }
    async testModel(providerId, modelId, options) {
        return testModelOperation(this.context, providerId, modelId, options);
    }
    /**
     * Commit the provider entry for a binding that login/borrow already wrote.
     * Called by the host after a completed login or an explicit "use current".
     */
    async upsertModelAccessProvider(providerKey, input, options) {
        const access = this.requireModelAccess();
        await upsertModelAccessProviderOperation({
            access,
            updateByokConfig: this.context.deps.updateByokConfig,
            rankModelsByRecency: this.context.deps.rankModelsByRecency,
        }, providerKey, input, options?.modelAccess);
        return this.context.requireCustomProviderView(providerKey);
    }
    /** Re-points provider entries whose bindings official delivery moved to a new installation. */
    async adoptModelAccessInstallations(providerKeys) {
        const access = this.context.deps.modelAccess;
        if (!access)
            return [];
        return adoptModelAccessInstallations({ access, updateByokConfig: this.context.deps.updateByokConfig }, providerKeys);
    }
    /** The primary's backup accounts and their in-memory state (never a credential). */
    getModelAccessFailover(providerId) {
        return getModelAccessFailoverOperation(this.failoverDeps(), this.context.deps.modelAccess?.failover, providerId);
    }
    /** Validates the pool against the member rules and stores provider keys on the primary. */
    setModelAccessFailover(input) {
        return setModelAccessFailoverOperation({ ...this.failoverDeps(), updateByokConfig: this.context.deps.updateByokConfig }, this.context.deps.modelAccess?.failover, input);
    }
    failoverDeps() {
        const access = this.context.deps.modelAccess;
        return {
            config: this.context.deps.configGetter,
            binding: (providerKey) => access?.bindings?.peek(providerKey),
            ...(access?.installationActive ? { installationActive: access.installationActive } : {}),
        };
    }
    /** Explicit usage lookup for an extension-owned provider; never persisted. */
    async queryModelAccessUsage(providerId, options) {
        const access = this.requireModelAccess();
        const providerKey = parseProviderId(providerId)?.providerKey;
        const provider = providerKey
            ? this.context.deps.configGetter().custom_provider?.[providerKey]
            : undefined;
        if (!providerKey || !provider || !isModelAccessProvider(provider)) {
            throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
        }
        if (provider.enabled === false)
            throw new LocalModelProviderError(400, 'Model provider is disabled', 'PROVIDER_DISABLED');
        if (!access.requests.owns(providerKey))
            throw modelAccessBindingMissingError();
        return queryModelAccessUsageOperation(access, providerKey, options?.modelAccess);
    }
    /**
     * Providers whose models cannot run now: extension providers whose committed catalog
     * is not usable (binding missing, mismatched or from an earlier account). The picker hides
     * their models; the settings view still lists the provider with its status.
     */
    unavailableModelAccessProviderIds() {
        const access = this.context.deps.modelAccess;
        const result = new Set();
        for (const [providerKey, provider] of Object.entries(this.context.deps.configGetter().custom_provider ?? {})) {
            if (!provider)
                continue;
            if (!isModelAccessProvider(provider))
                continue;
            const group = readModelAccessMetadata(provider)?.groupEntryKey;
            if (group && group !== providerKey) {
                result.add(`custom_provider:${providerKey}`);
                continue;
            }
            if (!modelAccessCatalogCurrentOperation(access, providerKey, provider))
                result.add(`custom_provider:${providerKey}`);
        }
        return result;
    }
    requireModelAccess() {
        const access = this.context.deps.modelAccess;
        if (!access)
            throw new LocalModelProviderError(503, 'Model access unavailable', 'MODEL_ACCESS_UNAVAILABLE');
        return access;
    }
    async discoverModels(providerId, options) {
        return discoverModelsOperation(this.context, providerId, options);
    }
    assertModelSelectable(providerId, modelId) {
        assertModelSelectableOperation(this.context, providerId, modelId);
    }
}
/** Only a stored BYOK key can be revealed; extension and OAuth credentials cannot. */
function assertProviderKeyRevealable(provider) {
    if (isModelAccessProvider(provider)) {
        throw new LocalModelProviderError(400, 'Extension credentials cannot be revealed', 'MODEL_ACCESS_READ_ONLY');
    }
    if (provider.kind === 'oauth' ||
        provider.options?.authMode === 'oauth' ||
        provider.api === 'openai-codex-responses') {
        throw new LocalModelProviderError(400, 'OAuth credentials cannot be revealed', 'VALIDATION_ERROR');
    }
}
//# sourceMappingURL=service.js.map