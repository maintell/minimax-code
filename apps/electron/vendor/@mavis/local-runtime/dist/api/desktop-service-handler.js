import { getRuntimeBuildEnv, getRuntimeRegion, isManagedRuntime, replaceLocalManagedMinimaxProvider, } from '@mavis/config';
import { DesktopService } from '../http/server.js';
import { createDesktopServiceRequestHandler, } from '../http/routes.js';
import { compareAndSetLocalModelContext, updateLocalByokConfig } from '../config/update.js';
import { managedBackendRoutingHeaders, } from '../runtime/routing-headers.js';
import { LocalModelCache } from '../model-provider/model-cache.js';
import { LocalModelProviderService } from '../model-provider/service.js';
import { ModelConnectionTester } from '../model-provider/test-connection.js';
import { ModelDiscoveryClient } from '../model-provider/discover-models.js';
import { isThreadGoalEnabled } from '../thread-goal/gate.js';
import { createSessionMutationEventPublisher } from '../http/desktop-session-mutation-events.js';
import { isReadOnlyLegacySession } from './host-legacy-helpers.js';
import { logger } from '../common/logger.js';
import { fetchOfficialModelConfig, OfficialModelConfigFetchError, OfficialModelConfigSync, resolveOfficialModelConfigUrl, } from '../model-provider/official-model-config-sync.js';
export function buildHostDesktopHandler(host, threadGoal, legacyMigrator) {
    return buildDesktopServiceHandler(host, {
        store: threadGoal.store,
        createGoal: (input) => threadGoal.createGoal(input),
        patchGoal: (sessionId, patch) => threadGoal.patchGoal(sessionId, patch),
        pauseGoalByUser: (sessionId) => threadGoal.pauseGoalByUser(sessionId),
        deleteGoal: (sessionId) => threadGoal.deleteGoal(sessionId),
        isReadOnlyLegacySession: async (sessionId) => {
            const session = await host.getSessionById(sessionId);
            return isReadOnlyLegacySession(legacyMigrator, session ?? sessionId);
        },
    });
}
/**
 * Build the DesktopService request handler with cron + goal dependencies
 * injected, so generated DesktopService routes resolve against real
 * local-runtime engines instead of the dependency-free echo handler.
 * Skill methods are retired here and served by the v2 generated front door.
 */
export function buildDesktopServiceHandler(host, goalDeps) {
    host.threadGoal.bindConfigGetter(host.configGetter);
    const gatedGoalDeps = {
        ...goalDeps,
        getBySessionForResponse: (sessionId, persisted) => host.threadGoal.getGoalForResponse(sessionId, persisted),
        isEnabled: () => goalDeps.isEnabled?.() ?? isThreadGoalEnabled(host.configGetter),
    };
    const setDefaultModel = async (modelKey, variant) => {
        await host.updateConfig({
            defaultModel: modelKey,
            defaultModelVariant: variant ?? null,
        });
    };
    if (isManagedRuntime()) {
        const officialModelConfigSync = new OfficialModelConfigSync({
            fetchSnapshot: async () => {
                const managedBaseUrl = host.configGetter().provider?.minimax?.options?.baseURL;
                if (typeof managedBaseUrl !== 'string' || !managedBaseUrl.trim()) {
                    throw new Error('Managed MiniMax base URL is unavailable');
                }
                const url = resolveOfficialModelConfigUrl(managedBaseUrl, getRuntimeRegion(), getRuntimeBuildEnv());
                const routingHeaders = managedBackendRoutingHeaders(host.routingContextGetter?.(), getRuntimeBuildEnv());
                const accessToken = host.authContextGetter?.()?.accessToken?.trim();
                try {
                    return await fetchOfficialModelConfig(url, host.fetchImpl, accessToken, routingHeaders);
                }
                catch (error) {
                    if (!(error instanceof OfficialModelConfigFetchError) ||
                        (error.status !== 401 && error.status !== 403) ||
                        !accessToken) {
                        throw error;
                    }
                    return fetchOfficialModelConfig(url, host.fetchImpl, undefined, routingHeaders);
                }
            },
            writeProvider: async (provider) => {
                await replaceLocalManagedMinimaxProvider(provider);
            },
            nowMs: host.nowMs,
            ...(host.metricsClient ? { metrics: host.metricsClient } : {}),
            logger: {
                warn: (fields, message) => logger.warn(fields, message),
            },
        });
        host.bindOfficialModelConfigRefresh(() => officialModelConfigSync.refreshIfStale());
    }
    const updateSession = async (sessionId, fields) => {
        if (!host.runtimeConversation) {
            throw new Error('Runtime Conversation is unavailable for Desktop Session mutation');
        }
        const ownedFields = {
            ...(fields.archived !== undefined ? { archived: fields.archived } : {}),
            ...(fields.effectiveModel !== undefined ? { effectiveModel: fields.effectiveModel } : {}),
            ...(fields.effectiveModelVariant !== undefined
                ? { effectiveModelVariant: fields.effectiveModelVariant }
                : {}),
        };
        return host.runtimeConversation.lifecycle.updateSession(sessionId, ownedFields);
    };
    const modelProviderService = new LocalModelProviderService({
        configGetter: host.configGetter,
        updateByokConfig: updateLocalByokConfig,
        cache: new LocalModelCache(() => host.configGetter().dataDir),
        tester: new ModelConnectionTester({ fetchImpl: host.fetchImpl }),
        discoverer: new ModelDiscoveryClient(host.fetchImpl),
        compareAndSetModelContext: async (input, beforeCommit) => (await compareAndSetLocalModelContext(input, beforeCommit)).updated,
        selectModel: (modelKey) => setDefaultModel(modelKey),
    });
    return createDesktopServiceRequestHandler(new DesktopService({
        runtime: host.cronRuntime,
        reviewContent: host.contentSafetyChecker,
        routeLocalApiRequest: (request) => host.routeLocalApiRequest(request),
        resolveCronKey: (cronId) => host.cronStore.resolveKeyByCronId?.(cronId) ?? Promise.resolve(undefined),
        getSessionById: (sessionId) => host.getSessionById(sessionId),
        listAllSessions: (agentName, options) => host.listAllSessions(agentName, options),
        agentExists: (agentName) => host.agentRuntimePort.agentExists(agentName),
        nowMs: host.nowMs,
    }, gatedGoalDeps, {
        resolveSessionScope: async (sessionId) => {
            const session = await host.getSessionById(sessionId);
            if (!session)
                return undefined;
            return { agentName: session.agentName, workspaceDir: session.workspaceDir };
        },
    }, host.memoryFacade, { service: host.agentRuntimePort }, { routeContext: () => host.permissionRouteContext() }, undefined, undefined, { serviceDeps: () => host.questionnaireServiceDeps() }, {
        service: modelProviderService,
        refreshOfficialModels: () => host.refreshOfficialModels(),
        configGetter: host.configGetter,
        getSessionById: (sessionId) => host.getSessionById(sessionId),
        updateSession,
        setDefaultModel,
    }, host.metricsClient, createSessionMutationEventPublisher((event) => host.publishGlobalEvent(event), {
        publishLifecycleEvents: false,
    }), {
        dataDir: host.configGetter().dataDir,
        getSessionById: (sessionId) => host.getSessionById(sessionId),
    }, undefined, {
        subscribe: (subscriber) => host.subscribeGlobalEvents(subscriber),
        nowMs: host.nowMs,
    }, undefined, undefined));
}
//# sourceMappingURL=desktop-service-handler.js.map