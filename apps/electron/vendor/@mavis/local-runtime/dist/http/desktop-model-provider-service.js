// DesktopService model-provider thrift adapter. Pure contract glue between
// the generated model/model-provider methods and the BYOK domain service
// (`model-provider/service.ts`): thrift request → domain input, domain view →
// thrift DTO, `LocalModelProviderError` → HTTPException. Session/effective
// model plumbing is injected by the host; no domain state lives here. See
// `.harness/docs/adr/desktop-service-ownership.md`.
import { HTTPException } from 'hono/http-exception';
import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import { modelSelectionFromSession } from '../api/host-model-helpers.js';
import { listLocalRuntimeModels } from '../api/host-support.js';
import { formatModelKey } from '../config/model-key.js';
import { LocalModelProviderError, } from '../model-provider/service.js';
import { toCandidateView, toModelInfo, toModelInputView, toModelStatus, toProviderInfo, } from './desktop-model-provider-mappers.js';
import { jsonError } from './desktop-service-support.js';
import { readPersistedLocalModelThinkingSelection } from '../model-provider/model-selection.js';
import { modelConfigForRef } from '../model-provider/list-models.js';
export class DesktopModelProviderService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async listModels(ctx, req) {
        void ctx;
        const deps = this.require();
        return this.mapErrors(async () => {
            await deps.refreshOfficialModels?.().catch(() => undefined);
            const session = req.sessionId ? await deps.getSessionById(req.sessionId) : undefined;
            const models = listLocalRuntimeModels(deps.configGetter(), modelSelectionFromSession(session), {
                cache: deps.service.loadCacheData(),
            });
            return { models: models.map(toModelInfo) };
        });
    }
    async selectModel(ctx, req) {
        void ctx;
        const deps = this.require();
        return this.mapErrors(async () => {
            if (!req.providerId?.trim() || !req.modelId?.trim()) {
                throw new LocalModelProviderError(400, 'provider_id and model_id are required', 'VALIDATION_ERROR');
            }
            if (req.contextLimit !== undefined) {
                const config = deps.configGetter();
                await deps.service.updateMinimaxModelContext({
                    modelId: req.modelId,
                    contextLimit: Number(req.contextLimit),
                    expectedContextLimit: modelConfigForRef(config, req.providerId, req.modelId)?.limit?.context ?? 0,
                });
            }
            const modelKey = formatModelKey(req.providerId.trim(), req.modelId.trim());
            this.assertModelAvailableForRoute(req.providerId.trim(), req.modelId.trim());
            deps.service.assertModelSelectable(req.providerId.trim(), req.modelId.trim());
            if (req.sessionId) {
                const session = await deps.getSessionById(req.sessionId);
                if (!session) {
                    throw new LocalModelProviderError(404, 'Session not found', 'SESSION_NOT_FOUND');
                }
                await deps.updateSession(req.sessionId, {
                    effectiveModel: modelKey,
                    effectiveModelVariant: req.variant ?? null,
                    ...(req.thinking !== undefined
                        ? { effectiveModelThinking: readPersistedLocalModelThinkingSelection(req.thinking) }
                        : session.effectiveModel === modelKey
                            ? {}
                            : { effectiveModelThinking: null }),
                });
                return { success: true };
            }
            try {
                await deps.setDefaultModel(modelKey, req.variant);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new LocalModelProviderError(400, message, 'CONFIG_WRITE_FAILED');
            }
            return { success: true };
        });
    }
    listModelProviders(ctx, req) {
        void ctx;
        void req;
        return this.mapErrors(async () => {
            const deps = this.require();
            await deps.refreshOfficialModels?.().catch(() => undefined);
            return { providers: deps.service.listEffectiveProviders().map(toProviderInfo) };
        });
    }
    listUserModelProviders(ctx, req) {
        void ctx;
        void req;
        return this.mapErrors(async () => ({
            providers: this.require().service.listUserProviders().map(toProviderInfo),
        }));
    }
    getMiniMaxApiKeyStatus(ctx, req) {
        void ctx;
        void req;
        return this.mapErrors(async () => {
            // `valid` means "a key is saved locally" — no remote verification here.
            // `cachedStatus` includes the latest connectivity test result from
            // model-cache.json so the UI can render the status dot on mount.
            const status = this.require().service.getMinimaxApiKeyStatus();
            return {
                valid: status.hasApiKey,
                ...(status.maskedApiKey ? { maskedApiKey: status.maskedApiKey } : {}),
                ...(status.cachedStatus ? { cachedStatus: toModelStatus(status.cachedStatus) } : {}),
            };
        });
    }
    upsertMiniMaxApiKey(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const provider = await this.require().service.upsertMinimaxApiKey({
                apiKey: req.apiKey,
                ...(req.saveAndUse !== undefined ? { saveAndUse: req.saveAndUse } : {}),
            });
            return { success: true, provider: toProviderInfo(provider) };
        });
    }
    createUserModelProvider(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const provider = await this.require().service.createUserProvider({
                ...(req.name !== undefined ? { name: req.name } : {}),
                baseUrl: req.baseUrl,
                apiKey: req.apiKey,
                ...(req.apiFormat !== undefined ? { apiFormat: req.apiFormat } : {}),
                ...(req.headers !== undefined ? { headers: req.headers } : {}),
                ...(req.models ? { models: req.models.map(toModelInputView) } : {}),
                ...(req.saveAndUse !== undefined ? { saveAndUse: req.saveAndUse } : {}),
            });
            return { success: true, provider: toProviderInfo(provider) };
        });
    }
    updateUserModelProvider(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const provider = await this.require().service.updateUserProvider({
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
            });
            return { success: true, provider: toProviderInfo(provider) };
        });
    }
    duplicateUserModelProvider(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const provider = await this.require().service.duplicateUserProvider({
                providerId: req.providerId,
                ...(req.name !== undefined ? { name: req.name } : {}),
            });
            return { success: true, provider: toProviderInfo(provider) };
        });
    }
    deleteUserModelProvider(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            await this.require().service.deleteUserProvider({ providerId: req.providerId });
            return { success: true };
        });
    }
    testUserModelProvider(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const outcome = await this.require().service.testProvider(req.providerId, {
                apiKeyOverride: req.apiKey,
            });
            return { success: outcome.ok, status: toModelStatus(outcome.status) };
        });
    }
    testUserModel(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const outcome = await this.require().service.testModel(req.providerId, req.modelId);
            return { success: outcome.ok, status: toModelStatus(outcome.status) };
        });
    }
    updateUserModelParameters(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const outcome = await this.require().service.updateUserModelParameters({
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
    testUserModelCandidate(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const outcome = await this.require().service.testUserModelCandidate(toCandidateView(req.candidate), req.modelId);
            return { success: outcome.ok, status: toModelStatus(outcome.status) };
        });
    }
    discoverUserModelsCandidate(ctx, req) {
        void ctx;
        return this.mapErrors(async () => ({
            models: (await this.require().service.discoverUserModelsCandidate(toCandidateView(req.candidate))).map((model) => ({
                modelId: model.modelId,
                ...(model.displayName ? { displayName: model.displayName } : {}),
            })),
        }));
    }
    saveUserModelProviderCandidate(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const outcome = await this.require().service.saveUserModelProviderCandidate({
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
        void ctx;
        return this.mapErrors(async () => ({
            models: (await this.require().service.discoverModels(req.providerId)).map((model) => ({
                modelId: model.modelId,
                ...(model.displayName ? { displayName: model.displayName } : {}),
            })),
        }));
    }
    updateMinimaxModelContext(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const outcome = await this.require().service.updateMinimaxModelContext({
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
    async getMinimaxModelSource(ctx, _req) {
        void ctx;
        return this.mapErrors(async () => {
            const source = this.require().service.getMinimaxModelSource();
            return { activeSource: source };
        });
    }
    async setMinimaxModelSource(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const source = await this.require().service.setMinimaxModelSource(req.source);
            return { success: true, activeSource: source };
        });
    }
    /**
     * Save-entry trust boundary: the same route-aware availability the model
     * list and the Turn gate use, so a persisted selection can never point at a
     * model the current route would reject only at call time.
     */
    assertModelAvailableForRoute(providerId, modelId) {
        const availability = resolveModelAvailability({
            config: this.require().configGetter(),
            providerId,
            modelId,
            preset: getRuntimePresetKey(),
            source: 'explicit_request',
        });
        if (availability.available)
            return;
        throw new LocalModelProviderError(400, availability.message, availability.code);
    }
    require() {
        if (!this.deps) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop model provider service is not configured', 'MODEL_PROVIDER_UNAVAILABLE'),
            });
        }
        return this.deps;
    }
    async mapErrors(fn) {
        try {
            return await fn();
        }
        catch (err) {
            if (err instanceof HTTPException)
                throw err;
            if (err instanceof LocalModelProviderError) {
                throw new HTTPException(err.status, {
                    res: jsonError(err.status, err.message, err.code),
                });
            }
            throw err;
        }
    }
}
//# sourceMappingURL=desktop-model-provider-service.js.map