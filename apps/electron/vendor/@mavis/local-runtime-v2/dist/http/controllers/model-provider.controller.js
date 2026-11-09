import { LocalModelProviderError, readPersistedLocalModelThinkingSelection, } from '../../service/model-system/index.js';
import { AppError } from '../errors.js';
import { ModelProviderControllerBase } from '../generated/model-provider-controller-base.gen.js';
import { toApiKeyInfo, toApiKeyProbe, toByokPresetModelInput, toCandidateView, toModelInfo, toModelInputView, toModelStatus, toProviderInfo, } from './model-provider-mappers.js';
export class ModelProviderController extends ModelProviderControllerBase {
    facade;
    constructor(facade) {
        super();
        this.facade = facade;
    }
    listModels(_ctx, req) {
        return this.mapErrors(async () => ({
            models: (await this.require().application.list({
                ...(req.sessionId ? { sessionId: req.sessionId } : {}),
            })).map(toModelInfo),
        }));
    }
    selectModel(_ctx, req) {
        return this.mapErrors(async () => ({
            success: await this.require().application.select({
                ...(req.sessionId ? { sessionId: req.sessionId } : {}),
                providerId: req.providerId,
                modelId: req.modelId,
                ...(req.reasoning != null ? { reasoning: req.reasoning } : {}),
                ...(req.replaceSelection !== undefined ? { replaceSelection: req.replaceSelection } : {}),
                ...(req.variant != null ? { variant: req.variant } : {}),
                ...(req.contextLimit != null ? { contextLimit: Number(req.contextLimit) } : {}),
                ...(req.thinking !== undefined
                    ? {
                        thinking: req.thinking?.effort != null
                            ? {
                                ...readPersistedLocalModelThinkingSelection(req.thinking),
                                effort: req.thinking.effort,
                            }
                            : readPersistedLocalModelThinkingSelection(req.thinking),
                    }
                    : {}),
            }),
        }));
    }
    listModelProviders(_ctx, _req) {
        return this.mapErrors(async () => {
            const facade = this.require();
            await facade.application.refresh();
            return { providers: facade.providers.listEffectiveProviders().map(toProviderInfo) };
        });
    }
    listUserModelProviders(_ctx, _req) {
        return this.mapErrors(async () => ({
            providers: this.require().providers.listVisibleUserProviders().map(toProviderInfo),
        }));
    }
    listByokProviderPresets(_ctx, _req) {
        return this.mapErrors(async () => ({
            presets: (await this.require().listProviderPresets()).map((preset) => ({
                providerId: preset.providerId,
                name: preset.name,
                baseUrl: preset.baseUrl,
                apiFormat: preset.apiFormat,
                ...(preset.iconUrl ? { iconUrl: preset.iconUrl } : {}),
                models: preset.models.map(toByokPresetModelInput),
            })),
        }));
    }
    getMiniMaxApiKeyStatus(_ctx, _req) {
        return this.mapErrors(async () => {
            const status = this.require().providers.getMinimaxApiKeyStatus();
            return {
                valid: status.hasApiKey,
                ...(status.maskedApiKey ? { maskedApiKey: status.maskedApiKey } : {}),
                ...(status.cachedStatus ? { cachedStatus: toModelStatus(status.cachedStatus) } : {}),
            };
        });
    }
    upsertMiniMaxApiKey(_ctx, req) {
        return this.mapErrors(async () => ({
            success: true,
            provider: toProviderInfo(await this.require().providers.upsertMinimaxApiKey({
                apiKey: req.apiKey,
                ...(req.saveAndUse !== undefined ? { saveAndUse: req.saveAndUse } : {}),
            })),
        }));
    }
    createUserModelProvider(_ctx, req) {
        return this.mapErrors(async () => ({
            success: true,
            provider: toProviderInfo(await this.require().providers.createUserProvider({
                ...(req.name !== undefined ? { name: req.name } : {}),
                baseUrl: req.baseUrl,
                apiKey: req.apiKey,
                ...(req.apiFormat !== undefined ? { apiFormat: req.apiFormat } : {}),
                ...(req.headers !== undefined ? { headers: req.headers } : {}),
                ...(req.models ? { models: req.models.map(toModelInputView) } : {}),
                ...(req.saveAndUse !== undefined ? { saveAndUse: req.saveAndUse } : {}),
            })),
        }));
    }
    updateUserModelProvider(_ctx, req) {
        return this.mapErrors(async () => ({
            success: true,
            provider: toProviderInfo(await this.require().providers.updateUserProvider({
                providerId: req.providerId,
                ...(req.name !== undefined ? { name: req.name } : {}),
                ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
                ...(req.apiKey !== undefined ? { apiKey: req.apiKey } : {}),
                ...(req.apiFormat !== undefined ? { apiFormat: req.apiFormat } : {}),
                ...(req.headers !== undefined ? { headers: req.headers } : {}),
                ...(req.removeHeaders !== undefined ? { removeHeaders: req.removeHeaders } : {}),
                ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
                ...(req.models ? { models: req.models.map(toModelInputView) } : {}),
                ...(req.saveAndUse !== undefined ? { saveAndUse: req.saveAndUse } : {}),
            })),
        }));
    }
    duplicateUserModelProvider(_ctx, req) {
        return this.mapErrors(async () => ({
            success: true,
            provider: toProviderInfo(await this.require().providers.duplicateUserProvider({
                providerId: req.providerId,
                ...(req.name !== undefined ? { name: req.name } : {}),
            })),
        }));
    }
    deleteUserModelProvider(_ctx, req) {
        return this.mapErrors(async () => {
            await this.require().providers.deleteUserProvider({ providerId: req.providerId });
            return { success: true };
        });
    }
    revealModelProviderApiKey(_ctx, req) {
        return this.mapErrors(async () => ({
            apiKey: this.require().providers.revealModelProviderApiKey({
                providerId: req.providerId,
                ...(req.keyId ? { keyId: req.keyId } : {}),
            }),
        }));
    }
    testUserModelProvider(ctx, req) {
        return this.mapErrors(async () => {
            const outcome = await this.require().providers.testProvider(req.providerId, {
                apiKeyOverride: req.apiKey,
                modelAccess: { signal: ctx.signal },
            });
            return toTestResp(outcome);
        });
    }
    testUserModel(ctx, req) {
        return this.mapErrors(async () => {
            const outcome = await this.require().providers.testModel(req.providerId, req.modelId, {
                modelAccess: { signal: ctx.signal },
            });
            return toTestResp(outcome);
        });
    }
    updateUserModelParameters(_ctx, req) {
        return this.mapErrors(async () => {
            const outcome = await this.require().providers.updateUserModelParameters({
                providerId: req.providerId,
                modelId: req.modelId,
                contextLimit: Number(req.contextLimit),
                maxOutputTokens: Number(req.maxOutputTokens),
                expectedContextLimit: Number(req.expectedContextLimit),
                expectedMaxOutputTokens: Number(req.expectedMaxOutputTokens),
            });
            return { success: outcome.ok, status: toModelStatus(outcome.status) };
        });
    }
    testUserModelCandidate(_ctx, req) {
        return this.mapErrors(async () => {
            const outcome = await this.require().providers.testUserModelCandidate(toCandidateView(req.candidate), req.modelId);
            return toTestResp(outcome);
        });
    }
    testUserModelApiKey(_ctx, req) {
        return this.mapErrors(async () => ({
            probe: toApiKeyProbe(await this.require().providers.testUserModelApiKey({
                candidate: toCandidateView(req.candidate),
                keyIndex: req.keyIndex,
                ...(req.modelId !== undefined ? { modelId: req.modelId } : {}),
            })),
        }));
    }
    unrestUserModelApiKey(_ctx, req) {
        return this.mapErrors(async () => ({
            key: toApiKeyInfo(this.require().providers.unrestUserModelApiKey({
                providerId: req.providerId,
                keyId: req.keyId,
            })),
        }));
    }
    discoverUserModelsCandidate(_ctx, req) {
        return this.mapErrors(async () => ({
            models: (await this.require().providers.discoverUserModelsCandidate(toCandidateView(req.candidate))).map(toDiscoveredModel),
        }));
    }
    saveUserModelProviderCandidate(_ctx, req) {
        return this.mapErrors(async () => {
            const outcome = await this.require().providers.saveUserModelProviderCandidate({
                candidate: toCandidateView(req.candidate),
                modelId: req.modelId,
                ...(req.saveAndUse !== undefined ? { saveAndUse: req.saveAndUse } : {}),
                ...(req.skipConnectionTest !== undefined
                    ? { skipConnectionTest: req.skipConnectionTest }
                    : {}),
            });
            return {
                success: outcome.ok,
                ...(outcome.status ? { status: toModelStatus(outcome.status) } : {}),
                ...(outcome.provider ? { provider: toProviderInfo(outcome.provider) } : {}),
                ...(outcome.skippedTest ? { skippedTest: true } : {}),
            };
        });
    }
    discoverUserModels(ctx, req) {
        return this.mapErrors(async () => ({
            models: (await this.require().providers.discoverModels(req.providerId, {
                modelAccess: { signal: ctx.signal },
            })).map(toDiscoveredModel),
        }));
    }
    updateMinimaxModelContext(_ctx, req) {
        return this.mapErrors(async () => {
            const outcome = await this.require().providers.updateMinimaxModelContext({
                modelId: req.modelId,
                contextLimit: Number(req.contextLimit),
                expectedContextLimit: Number(req.expectedContextLimit),
            });
            return {
                success: outcome.ok,
                ...(outcome.status ? { status: toModelStatus(outcome.status) } : {}),
            };
        });
    }
    getMinimaxModelSource(_ctx, _req) {
        return this.mapErrors(async () => ({
            activeSource: this.require().providers.getMinimaxModelSource(),
        }));
    }
    setMinimaxModelSource(_ctx, req) {
        return this.mapErrors(async () => ({
            success: true,
            activeSource: (await this.require().providers.setMinimaxModelSource(req.source)),
        }));
    }
    require() {
        if (!this.facade) {
            throw new AppError(503, 'MODEL_PROVIDER_UNAVAILABLE', 'Desktop model provider service is not configured');
        }
        return this.facade;
    }
    async mapErrors(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            if (error instanceof LocalModelProviderError) {
                throw new AppError(error.status, error.code, error.message);
            }
            throw error;
        }
    }
}
export function createModelProviderController(facade) {
    return new ModelProviderController(facade);
}
export const modelProviderController = createModelProviderController();
function toTestResp(outcome) {
    return {
        success: outcome.ok,
        status: toModelStatus(outcome.status),
        ...(outcome.keyLabel ? { keyLabel: outcome.keyLabel } : {}),
    };
}
function toDiscoveredModel(model) {
    return {
        modelId: model.modelId,
        ...(model.displayName ? { displayName: model.displayName } : {}),
    };
}
//# sourceMappingURL=model-provider.controller.js.map