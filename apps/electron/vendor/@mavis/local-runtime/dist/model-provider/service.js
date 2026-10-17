import { enabledCustomProviders } from './list-models.js';
import { discoverUserModelsCandidate as discoverUserModelsCandidateOperation, saveUserModelProviderCandidate as saveUserModelProviderCandidateOperation, testUserModelCandidate as testUserModelCandidateOperation, updateUserModelParameters as updateUserModelParametersOperation, } from './service-candidate-operations.js';
import { assertModelSelectable as assertModelSelectableOperation, discoverModels as discoverModelsOperation, testModel as testModelOperation, testProvider as testProviderOperation, } from './service-connection-operations.js';
import { ModelProviderServiceContext } from './service-context.js';
import { createUserProvider as createUserProviderOperation, deleteUserProvider as deleteUserProviderOperation, duplicateUserProvider as duplicateUserProviderOperation, updateUserProvider as updateUserProviderOperation, } from './service-custom-provider-operations.js';
import { getMinimaxApiKeyStatus as getMinimaxApiKeyStatusOperation, getMinimaxModelSource as getMinimaxModelSourceOperation, setMinimaxModelSource as setMinimaxModelSourceOperation, updateMinimaxModelContext as updateMinimaxModelContextOperation, upsertMinimaxApiKey as upsertMinimaxApiKeyOperation, } from './service-minimax-operations.js';
import { buildBuiltinProviderView, buildCustomProviderView, } from './provider-views.js';
export { LocalModelProviderError } from './service-contract.js';
/** Stable public facade for local model-provider operations. */
export class LocalModelProviderService {
    context;
    constructor(deps) {
        this.context = new ModelProviderServiceContext(deps);
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
        for (const [providerKey, provider] of enabledCustomProviders(config)) {
            providers.push(buildCustomProviderView(config, cache, providerKey, provider));
        }
        return providers;
    }
    listUserProviders() {
        const config = this.context.deps.configGetter();
        const cache = this.context.deps.cache.load();
        return Object.entries(config.custom_provider ?? {}).map(([providerKey, provider]) => buildCustomProviderView(config, cache, providerKey, provider));
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
    async saveUserModelProviderCandidate(input) {
        return saveUserModelProviderCandidateOperation(this.context, input);
    }
    async updateUserModelParameters(input) {
        return updateUserModelParametersOperation(this.context, input);
    }
    async deleteUserProvider(input) {
        return deleteUserProviderOperation(this.context, input);
    }
    async testProvider(providerId, opts) {
        return testProviderOperation(this.context, providerId, opts);
    }
    async testModel(providerId, modelId) {
        return testModelOperation(this.context, providerId, modelId);
    }
    async discoverModels(providerId) {
        return discoverModelsOperation(this.context, providerId);
    }
    assertModelSelectable(providerId, modelId) {
        assertModelSelectableOperation(this.context, providerId, modelId);
    }
}
//# sourceMappingURL=service.js.map