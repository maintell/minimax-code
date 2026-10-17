import { isLegacyManagedMinimaxProvider } from '@mavis/config';
import { annotateModelFavorites, modelFavoriteRefs, } from '../../service/model-system/index.js';
import { watchGlobalEvents, watchProcessEvents } from '../events.js';
/** Composes peripheral product capabilities for process-local delivery. */
export function createProcessLocalApplication(options) {
    const sessionReports = options.sessionReports;
    return {
        events: {
            watch: (signal) => watchGlobalEvents((subscriber) => options.eventBus.subscribe({ next: subscriber }), signal),
        },
        ...(options.usageCommits
            ? {
                usage: {
                    watchCommits: (signal) => watchProcessEvents((subscriber) => options.usageCommits?.subscribe(subscriber) ?? (() => undefined), signal),
                },
            }
            : {}),
        skills: {
            listSkills: (input) => options.skills.listSkills(input),
            listRuntimeSkills: (input) => options.skills.listRuntimeSkills(input),
        },
        plugins: options.plugins,
        ...(options.miniApps ? { miniApps: options.miniApps } : {}),
        mcp: options.peripherals.mcp,
        goals: options.peripherals.goals,
        questionnaires: options.peripherals.questionnaires,
        plan: options.plan,
        backgroundTasks: options.peripherals.backgroundTasks,
        permissions: options.peripherals.permissions,
        account: {
            getStatus: async (input) => {
                let status = await options.peripherals.account.getStatus(input);
                if (isLegacyManagedMinimaxProvider(selectedProviderId(status) ?? '')) {
                    const selected = (await options.modelProvider.application.list(input)).find((model) => model.selected);
                    if (selected?.providerId === 'minimax') {
                        status = {
                            ...status,
                            selection: {
                                defaultModel: `minimax/${selected.modelId}`,
                                providerId: selected.providerId,
                                modelId: selected.modelId,
                            },
                            provider: {
                                id: selected.providerId,
                                authMode: selected.providerKind === 'minimax-managed' ? 'managed-login' : 'api-key',
                            },
                        };
                    }
                }
                if (selectedProviderId(status) !== 'minimax')
                    return status;
                const source = options.modelProvider.providers.getMinimaxModelSource();
                return {
                    ...status,
                    modelSource: source === 'minimax_api_key' ? 'byok' : 'token-plan',
                };
            },
        },
        diagnostics: {
            getRuntimeSnapshot: () => options.peripherals.diagnostics.getRuntimeSnapshot(),
            ...(sessionReports
                ? {
                    collectSessionReport: (sessionId) => sessionReports.collect(sessionId),
                }
                : {}),
        },
        ...(options.instructions ? { instructions: options.instructions } : {}),
        configuration: options.peripherals.configuration,
        models: createModelsApplication(options.modelProvider),
        modelProviders: {
            listProviderPresets: () => options.modelProvider.listProviderPresets(),
            getCodexOAuthStatus: async () => options.modelProvider.oauth.getStatus(),
            startCodexOAuthLogin: (input) => options.modelProvider.oauth.startLogin(input),
            cancelCodexOAuthLogin: async (loginId) => options.modelProvider.oauth.cancelLogin(loginId),
            listUser: async () => options.modelProvider.providers.listUserProviders().map(toProviderRecord),
            getMiniMaxApiKeyStatus: async () => options.modelProvider.providers.getMinimaxApiKeyStatus(),
            getMiniMaxModelSource: async () => options.modelProvider.providers.getMinimaxModelSource(),
            setMiniMaxModelSource: async ({ source }) => {
                await options.modelProvider.providers.setMinimaxModelSource(source);
                return source;
            },
            upsertMiniMaxApiKey: async (request) => options.modelProvider.providers.upsertMinimaxApiKey(request),
            create: async ({ models, ...request }) => options.modelProvider.providers.createUserProvider({
                ...request,
                ...(models ? { models: toUserModelInputs(models) } : {}),
            }),
            discoverCandidate: (candidate) => options.modelProvider.providers.discoverUserModelsCandidate(candidate),
            saveCandidate: async ({ candidate: { models, ...candidate }, ...request }) => {
                const outcome = await options.modelProvider.providers.saveUserModelProviderCandidate({
                    ...request,
                    candidate: {
                        ...candidate,
                        ...(models ? { models: toUserModelInputs(models) } : {}),
                    },
                });
                return {
                    success: outcome.ok,
                    ...(outcome.status ? { status: { ...outcome.status } } : {}),
                    ...(outcome.provider ? { provider: toProviderRecord(outcome.provider) } : {}),
                };
            },
            update: async ({ models, ...request }) => options.modelProvider.providers.updateUserProvider({
                ...request,
                ...(models ? { models: toUserModelInputs(models) } : {}),
            }),
            delete: ({ providerId }) => options.modelProvider.providers.deleteUserProvider({ providerId }),
            testProvider: async ({ providerId }) => {
                const outcome = await options.modelProvider.providers.testProvider(providerId);
                return { success: outcome.ok, status: outcome.status };
            },
            testModel: async ({ providerId, modelId }) => {
                const outcome = await options.modelProvider.providers.testModel(providerId, modelId);
                return { success: outcome.ok, status: outcome.status };
            },
        },
        workspace: options.workspace,
    };
}
function selectedProviderId(status) {
    const selection = asRecord(status.selection);
    const provider = asRecord(status.provider);
    if (typeof selection?.providerId === 'string') {
        return selection.providerId;
    }
    return typeof provider?.id === 'string' ? provider.id : undefined;
}
function asRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function toProviderRecord(provider) {
    return { ...provider };
}
function toUserModelInputs(models) {
    return models.map(({ modalities, ...model }) => ({
        ...model,
        ...(modalities
            ? {
                modalities: {
                    ...(modalities.input ? { input: [...modalities.input] } : {}),
                    ...(modalities.output ? { output: [...modalities.output] } : {}),
                },
            }
            : {}),
    }));
}
function createModelsApplication(modelProvider) {
    const favorites = modelProvider.favorites;
    const list = (request = {}) => modelProvider.application.list(request);
    if (!favorites) {
        return { list, select: (request) => modelProvider.application.select(request) };
    }
    return {
        list: async (request = {}) => {
            const models = await list(request);
            // A broken preference row must never hide the catalog.
            let saved = [];
            try {
                saved = favorites.list();
            }
            catch {
                saved = [];
            }
            return annotateModelFavorites(models, saved);
        },
        select: (request) => modelProvider.application.select(request),
        setFavorite: async (request) => {
            // Prune stale favorites only against a catalog we actually read.
            let catalog;
            try {
                catalog = modelFavoriteRefs(await list({}));
            }
            catch {
                catalog = undefined;
            }
            if (catalog && catalog.length === 0)
                catalog = undefined;
            favorites.set(request, catalog);
            return true;
        },
    };
}
//# sourceMappingURL=process-local-application.js.map