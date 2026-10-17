import { HTTPException } from 'hono/http-exception';
import { DesktopWorkspaceFileServiceBase } from './desktop-workspace-file-service.js';
import { getSessionFilesService } from '../session-assets/session-files-service.js';
import { getSessionInputSummaryService, SessionInputSummaryNotFoundError, SessionInputSummaryValidationError, } from '../session-navigation/service.js';
import { getConfig } from '@mavis/config';
import { CronContractError, assertCronName, assertSchedulable, createCronReqToConfig, cronStateToCronTask, toCronContractError, updateCronReqToConfigUpdate, } from '../cron/contract.js'; // desktop-service-boundary-skip: anchor=server-cron-contract owner=cron reason=legacy-cron-rpc-glue-before-facade; followup=desktop-service-domain-facades
import { createStoredCronTask, deleteStoredCronTask, getStoredCronTask, listStoredCronTasks, updateStoredCronTask, } from '../cron/index.js';
import { ThreadGoalContractError, createGoalReqToCreateInput, goalStateToGoalState, patchGoalReqToPatchInput, toThreadGoalContractError, } from '../thread-goal/contract.js'; // desktop-service-boundary-skip: anchor=server-goal-contract owner=thread-goal reason=legacy-goal-rpc-glue-before-facade; followup=desktop-service-domain-facades
import { LocalAgentContractError } from '../agent/contract.js';
import { LocalProjectContractError } from '../project/index.js';
import { cronReviewBlocks } from '../content-safety/cron-fields.js';
import { jsonError, requireSessionId, toCronSessionStatusLabel, } from './desktop-service-support.js';
import { DesktopEchoService } from './desktop-echo-service.js';
import { DesktopPinService } from './desktop-pin-service.js';
import { DesktopModelProviderService, } from './desktop-model-provider-service.js';
import { DesktopSessionService } from './desktop-session-service.js';
import { DesktopPermissionService, } from './desktop-permission-service.js';
import { logger } from '../common/logger.js';
import { DesktopReviewService } from './desktop-review-service.js';
import { DesktopGlobalEventsService, } from './desktop-global-events-service.js';
/**
 * v1 宿主不持有 Cron v2。共享生成契约中的 Cron v2 定义和运行方法由
 * local-runtime-v2 前门提供；旧链路返回稳定的不支持错误，避免打开第二个
 * Cron 写入端。
 */
function cronV2Unsupported(method) {
    return new CronContractError(501, `Cron v2 method ${method} is served by the local-runtime-v2 front door`, 'CRON_V2_UNSUPPORTED_ON_LEGACY_HOST');
}
/**
 * v1 宿主不持有 LLM Context Inspector。capture、Session 文件历史与全局设置都属于
 * local-runtime-v2；旧链路 fail closed，避免在 v1 上重新长出第二个 capture 与读取实现。
 */
function llmContextInspectorUnsupported(method) {
    return new CronContractError(501, `LLM Context Inspector method ${method} is served by the local-runtime-v2 front door`, 'LLM_CONTEXT_INSPECTOR_UNSUPPORTED_ON_LEGACY_HOST');
}
/** v1 宿主不持有 Sandbox；读写运行态只由 local-runtime-v2 前门提供。 */
function sandboxUnsupported(method) {
    return async () => {
        throw new HTTPException(501, {
            res: jsonError(501, `Sandbox method ${method} is served by the local-runtime-v2 front door`, 'SANDBOX_UNSUPPORTED_ON_LEGACY_HOST'),
        });
    };
}
function pageCronSessions(items, cursor, limit) {
    const start = cursor === undefined
        ? 0
        : Math.max(0, items.findIndex((item) => item.sessionId === cursor) + 1);
    const remaining = items.slice(start);
    if (limit === undefined || limit <= 0)
        return { items: remaining, hasMore: false };
    const page = remaining.slice(0, limit);
    const hasMore = remaining.length > limit;
    return {
        items: page,
        hasMore,
    };
}
function safeSessionMutationError(error) {
    return { name: error instanceof Error ? error.name : 'UnknownError' };
}
export class DesktopService extends DesktopWorkspaceFileServiceBase {
    cron;
    goal;
    skills;
    agents;
    project;
    metricsClient;
    sessionMutationEvents;
    echoService = new DesktopEchoService();
    sessionService;
    permissionService;
    pinService;
    modelProviderService;
    reviewService;
    globalEventsService;
    constructor(cron, goal, skills, memory, agents, permission, pin, project, questionnaire, modelProvider, metricsClient, sessionMutationEvents, review, _reservedV2GlobalInstructionsSlot, globalEvents, _retiredMcp, _reservedV2WorkspaceIndexingSlot) {
        void _reservedV2GlobalInstructionsSlot;
        void _reservedV2WorkspaceIndexingSlot;
        // Desktop transport stays a consumer of the explicitly injected V2 agent
        // port.  Channel, memory, and questionnaire adapters only need the
        // resolver slice; they must never reconstruct a legacy AgentService.
        super(memory, questionnaire, agents?.service);
        this.cron = cron;
        this.goal = goal;
        this.skills = skills;
        this.agents = agents;
        this.project = project;
        this.metricsClient = metricsClient;
        this.sessionMutationEvents = sessionMutationEvents;
        this.sessionService = new DesktopSessionService(this.localApiJson.bind(this), this.localApiResponse.bind(this), metricsClient);
        this.permissionService = permission ? new DesktopPermissionService(permission) : undefined;
        this.pinService = new DesktopPinService(pin);
        this.modelProviderService = new DesktopModelProviderService(modelProvider);
        this.reviewService = review ? new DesktopReviewService(review) : undefined;
        this.globalEventsService = new DesktopGlobalEventsService(globalEvents);
    }
    ping(...args) {
        return this.echoService.ping(...args);
    }
    getEcho(...args) {
        return this.echoService.getEcho(...args);
    }
    getHeaderEcho(...args) {
        return this.echoService.getHeaderEcho(...args);
    }
    async readCanvas(_ctx, _req) {
        return this.unimplementedGeneratedMethod('readCanvas');
    }
    async prepareCanvasFiles(_ctx, _req) {
        return this.unimplementedGeneratedMethod('prepareCanvasFiles');
    }
    async applyCanvasOperation(_ctx, _req) {
        return this.unimplementedGeneratedMethod('applyCanvasOperation');
    }
    getPathEcho(...args) {
        return this.echoService.getPathEcho(...args);
    }
    getQueryBindingEcho(...args) {
        return this.echoService.getQueryBindingEcho(...args);
    }
    getNestedQueryBindingEcho(...args) {
        return this.echoService.getNestedQueryBindingEcho(...args);
    }
    submitFieldEcho(...args) {
        return this.echoService.submitFieldEcho(...args);
    }
    submitNestedFieldEcho(...args) {
        return this.echoService.submitNestedFieldEcho(...args);
    }
    streamEcho(...args) {
        return this.echoService.streamEcho(...args);
    }
    getReviewPreferences(ctx, req) {
        return this.requireReviewService().getReviewPreferences(ctx, req);
    }
    updateReviewPreferences(ctx, req) {
        return this.requireReviewService().updateReviewPreferences(ctx, req);
    }
    resolveAnnotationTarget(ctx, req) {
        return this.requireReviewService().resolveAnnotationTarget(ctx, req);
    }
    subscribeGlobalEvents(...args) {
        return this.globalEventsService.subscribeGlobalEvents(...args);
    }
    // Session handoff state, cloud transport, and native file transfer are owned by
    // Local Runtime v2. Legacy hosts fail closed instead of creating a second owner.
    approveLocalSessionHandoff(..._args) {
        return this.unimplementedGeneratedMethod('ApproveLocalSessionHandoff');
    }
    getLocalSessionHandoffEligibility(..._args) {
        return this.unimplementedGeneratedMethod('GetLocalSessionHandoffEligibility');
    }
    getSessionHandoffSummary(..._args) {
        return this.unimplementedGeneratedMethod('GetSessionHandoffSummary');
    }
    downloadSessionResult(..._args) {
        return this.unimplementedGeneratedMethod('DownloadSessionResult');
    }
    overwriteSessionResult(..._args) {
        return this.unimplementedGeneratedMethod('OverwriteSessionResult');
    }
    updateProject(..._args) {
        return this.unimplementedGeneratedMethod('UpdateProject');
    }
    // Shared IDL already declares sidebar queries; their domain cutover is separate.
    // Keep the legacy contract explicit and fail closed until that owner is wired.
    querySidebarProjects(..._args) {
        return this.unimplementedGeneratedMethod('QuerySidebarProjects');
    }
    querySidebarProjectSessions(..._args) {
        return this.unimplementedGeneratedMethod('QuerySidebarProjectSessions');
    }
    querySidebarAgents(..._args) {
        return this.unimplementedGeneratedMethod('QuerySidebarAgents');
    }
    getSidebarSession(..._args) {
        return this.unimplementedGeneratedMethod('GetSidebarSession');
    }
    listManagedWorkspaceGitWorktrees(..._args) {
        return this.unimplementedGeneratedMethod('ListManagedWorkspaceGitWorktrees');
    }
    removeManagedWorkspaceGitWorktree(..._args) {
        return this.unimplementedGeneratedMethod('RemoveManagedWorkspaceGitWorktree');
    }
    removeManagedWorkspaceGitWorktreesBatch(..._args) {
        return this.unimplementedGeneratedMethod('RemoveManagedWorkspaceGitWorktreesBatch');
    }
    // Workspace Git Snapshot ownership lives in Local Runtime v2. These methods
    // only satisfy the generated DesktopService shape for legacy-only hosts and
    // must never recreate a second v1 Snapshot owner.
    commitAndPushWorkspaceGit(..._args) {
        return this.unimplementedGeneratedMethod('CommitAndPushWorkspaceGit');
    }
    invalidateWorkspaceGitSnapshot(..._args) {
        return this.unimplementedGeneratedMethod('InvalidateWorkspaceGitSnapshot');
    }
    invalidateAllWorkspaceGitSnapshots(..._args) {
        return this.unimplementedGeneratedMethod('InvalidateAllWorkspaceGitSnapshots');
    }
    // Website management is contract-first in the current IDL. Legacy hosts
    // keep the routes explicit and fail-closed until the owning implementation lands.
    listDeployedWebsites(..._args) {
        return this.unimplementedGeneratedMethod('ListDeployedWebsites');
    }
    getWebsiteTrafficStats(..._args) {
        return this.unimplementedGeneratedMethod('GetWebsiteTrafficStats');
    }
    getWebsiteState(..._args) {
        return this.unimplementedGeneratedMethod('GetWebsiteState');
    }
    cancelWebsiteDeployment(..._args) {
        return this.unimplementedGeneratedMethod('CancelWebsiteDeployment');
    }
    unpublishWebsiteDeployment(..._args) {
        return this.unimplementedGeneratedMethod('UnpublishWebsiteDeployment');
    }
    republishWebsiteDeployment(..._args) {
        return this.unimplementedGeneratedMethod('RepublishWebsiteDeployment');
    }
    updateWebsiteWatermark(..._args) {
        return this.unimplementedGeneratedMethod('UpdateWebsiteWatermark');
    }
    updateWebsiteDisplayName(..._args) {
        return this.unimplementedGeneratedMethod('UpdateWebsiteDisplayName');
    }
    setWebsiteAlias(..._args) {
        return this.unimplementedGeneratedMethod('SetWebsiteAlias');
    }
    checkWebsiteAliasAvailability(..._args) {
        return this.unimplementedGeneratedMethod('CheckWebsiteAliasAvailability');
    }
    unbindWebsiteAlias(..._args) {
        return this.unimplementedGeneratedMethod('UnbindWebsiteAlias');
    }
    removeWebsiteAlias(..._args) {
        return this.unimplementedGeneratedMethod('RemoveWebsiteAlias');
    }
    getWebsiteProjectSourceDownloadURL(..._args) {
        return this.unimplementedGeneratedMethod('GetWebsiteProjectSourceDownloadURL');
    }
    listMarketplacePlugins(..._args) {
        return this.unimplementedGeneratedMethod('ListMarketplacePlugins');
    }
    getMarketplacePlugin(..._args) {
        return this.unimplementedGeneratedMethod('GetMarketplacePlugin');
    }
    previewGithubPlugin(..._args) {
        return this.unimplementedGeneratedMethod('PreviewGithubPlugin');
    }
    importGithubPlugin(..._args) {
        return this.unimplementedGeneratedMethod('ImportGithubPlugin');
    }
    listInstalledPlugins(..._args) {
        return this.unimplementedGeneratedMethod('ListInstalledPlugins');
    }
    listEnabledPlugins(..._args) {
        return this.unimplementedGeneratedMethod('ListEnabledPlugins');
    }
    installPlugin(..._args) {
        return this.unimplementedGeneratedMethod('InstallPlugin');
    }
    uninstallPlugin(..._args) {
        return this.unimplementedGeneratedMethod('UninstallPlugin');
    }
    enablePlugin(..._args) {
        return this.unimplementedGeneratedMethod('EnablePlugin');
    }
    disablePlugin(..._args) {
        return this.unimplementedGeneratedMethod('DisablePlugin');
    }
    refreshPlugins(..._args) {
        return this.unimplementedGeneratedMethod('RefreshPlugins');
    }
    listLocalMcpServers(..._args) {
        return this.unimplementedGeneratedMethod('listLocalMcpServers');
    }
    getLocalMcpServer(..._args) {
        return this.unimplementedGeneratedMethod('getLocalMcpServer');
    }
    createLocalMcpServer(..._args) {
        return this.unimplementedGeneratedMethod('createLocalMcpServer');
    }
    updateLocalMcpServer(..._args) {
        return this.unimplementedGeneratedMethod('updateLocalMcpServer');
    }
    deleteLocalMcpServer(..._args) {
        return this.unimplementedGeneratedMethod('deleteLocalMcpServer');
    }
    setLocalMcpServerEnabled(..._args) {
        return this.unimplementedGeneratedMethod('setLocalMcpServerEnabled');
    }
    listLocalMcpRuntimeServers(..._args) {
        return this.unimplementedGeneratedMethod('listLocalMcpRuntimeServers');
    }
    getLocalMcpRuntimeServer(..._args) {
        return this.unimplementedGeneratedMethod('getLocalMcpRuntimeServer');
    }
    upsertLocalMcpRuntimeServer(..._args) {
        return this.unimplementedGeneratedMethod('upsertLocalMcpRuntimeServer');
    }
    disableLocalMcpRuntimeServer(..._args) {
        return this.unimplementedGeneratedMethod('disableLocalMcpRuntimeServer');
    }
    listLocalMcpRuntimeTools(..._args) {
        return this.unimplementedGeneratedMethod('listLocalMcpRuntimeTools');
    }
    getLocalMcpRuntimeTool(..._args) {
        return this.unimplementedGeneratedMethod('getLocalMcpRuntimeTool');
    }
    listLocalMcpRuntimeNativeTools(..._args) {
        return this.unimplementedGeneratedMethod('listLocalMcpRuntimeNativeTools');
    }
    getLocalMcpRuntimeAuthStatus(..._args) {
        return this.unimplementedGeneratedMethod('getLocalMcpRuntimeAuthStatus');
    }
    startLocalMcpRuntimeAuth(..._args) {
        return this.unimplementedGeneratedMethod('startLocalMcpRuntimeAuth');
    }
    syncLocalMcpRuntimeServers(..._args) {
        return this.unimplementedGeneratedMethod('syncLocalMcpRuntimeServers');
    }
    getLocalMcpRuntimeSyncStatus(..._args) {
        return this.unimplementedGeneratedMethod('getLocalMcpRuntimeSyncStatus');
    }
    callLocalMcpRuntimeTool(..._args) {
        return this.unimplementedGeneratedMethod('callLocalMcpRuntimeTool');
    }
    testLocalMcpServer(..._args) {
        return this.unimplementedGeneratedMethod('testLocalMcpServer');
    }
    setSkillEnabled(..._args) {
        return this.unimplementedGeneratedMethod('SetSkillEnabled');
    }
    // ─── agent (contract generated; storage-backed implementation follows) ────
    listAgents(ctx, req) {
        void ctx;
        return this.mapAgentErrors(() => this.requireAgents().service.listAgents(req));
    }
    createAgent(ctx, req) {
        void ctx;
        return this.mapAgentErrors(() => this.requireAgents().service.createAgent(req));
    }
    getAgent(ctx, req) {
        void ctx;
        return this.mapAgentErrors(() => this.requireAgents().service.getAgent(req));
    }
    updateAgent(ctx, req) {
        void ctx;
        return this.mapAgentErrors(() => this.requireAgents().service.updateAgent(req));
    }
    deleteAgent(ctx, req) {
        void ctx;
        return this.mapAgentErrors(() => this.requireAgents().service.deleteAgent(req));
    }
    getAgentLegacyHistoryNotice(..._args) {
        return this.unimplementedGeneratedMethod('GetAgentLegacyHistoryNotice');
    }
    getAgentConfig(..._args) {
        return this.unimplementedGeneratedMethod('GetAgentConfig');
    }
    putAgentConfig(..._args) {
        return this.unimplementedGeneratedMethod('PutAgentConfig');
    }
    readClaudeCodeAgentImport(..._args) {
        return this.unimplementedGeneratedMethod('ReadClaudeCodeAgentImport');
    }
    readCodexAgentImport(..._args) {
        return this.unimplementedGeneratedMethod('ReadCodexAgentImport');
    }
    createImportedAgent(..._args) {
        return this.unimplementedGeneratedMethod('CreateImportedAgent');
    }
    pinAgent(...args) {
        return this.pinService.pinAgent(...args);
    }
    async pinSession(...args) {
        const req = args[1];
        const operation = req.pinned ? 'pin' : 'unpin';
        return this.runSessionMutation(operation, req.sessionId, 'session.pinned_updated', async (startedAt) => {
            const resp = await this.pinService.pinSession(...args);
            this.publishSessionMutationEvent(operation, req.sessionId, 'session.pinned_updated', startedAt, () => this.sessionMutationEvents?.pinnedUpdated({
                sessionId: req.sessionId,
                ...(resp.item?.session?.agentName ? { agentName: resp.item.session.agentName } : {}),
                pinned: req.pinned,
            }));
            return resp;
        });
    }
    getPinnedItemsOrder(...args) {
        return this.pinService.getPinnedItemsOrder(...args);
    }
    putPinnedItemsOrder(...args) {
        return this.pinService.putPinnedItemsOrder(...args);
    }
    // ─── V2-owned generated compatibility methods ───────────────────────────
    getGlobalInstructions(ctx, _req) {
        void ctx;
        return this.unimplementedGeneratedMethod('getGlobalInstructions');
    }
    putGlobalInstructions(ctx, req) {
        void ctx;
        void req;
        return this.unimplementedGeneratedMethod('putGlobalInstructions');
    }
    getWorkspaceIndexingPreference(ctx, _req) {
        void ctx;
        return this.unimplementedGeneratedMethod('getWorkspaceIndexingPreference');
    }
    putWorkspaceIndexingPreference(ctx, req) {
        void ctx;
        void req;
        return this.unimplementedGeneratedMethod('putWorkspaceIndexingPreference');
    }
    prewarmWorkspaceIndexing(ctx, req) {
        void ctx;
        void req;
        return this.unimplementedGeneratedMethod('prewarmWorkspaceIndexing');
    }
    // ─── models / model providers (BYOK; contract glue in dedicated adapter) ──
    listModels = (ctx, req) => this.modelProviderService.listModels(ctx, req);
    selectModel = (ctx, req) => this.modelProviderService.selectModel(ctx, req);
    listModelProviders = (ctx, req) => this.modelProviderService.listModelProviders(ctx, req);
    listUserModelProviders = (ctx, req) => this.modelProviderService.listUserModelProviders(ctx, req);
    // BYOK provider presets are served by Local Runtime v2. Legacy-only hosts
    // expose the generated route and fail closed instead of shipping a second
    // preset catalogue that could drift from the v2 owner.
    listByokProviderPresets(..._args) {
        return this.unimplementedGeneratedMethod('ListByokProviderPresets');
    }
    getMiniMaxApiKeyStatus = (ctx, req) => this.modelProviderService.getMiniMaxApiKeyStatus(ctx, req);
    upsertMiniMaxApiKey = (ctx, req) => this.modelProviderService.upsertMiniMaxApiKey(ctx, req);
    createUserModelProvider = (ctx, req) => this.modelProviderService.createUserModelProvider(ctx, req);
    updateUserModelProvider = (ctx, req) => this.modelProviderService.updateUserModelProvider(ctx, req);
    duplicateUserModelProvider = (ctx, req) => this.modelProviderService.duplicateUserModelProvider(ctx, req);
    deleteUserModelProvider = (ctx, req) => this.modelProviderService.deleteUserModelProvider(ctx, req);
    revealModelProviderApiKey(..._args) {
        return this.unimplementedGeneratedMethod('RevealModelProviderApiKey');
    }
    testUserModelProvider = (ctx, req) => this.modelProviderService.testUserModelProvider(ctx, req);
    testUserModel = (ctx, req) => this.modelProviderService.testUserModel(ctx, req);
    updateUserModelParameters = (ctx, req) => this.modelProviderService.updateUserModelParameters(ctx, req);
    testUserModelCandidate = (ctx, req) => this.modelProviderService.testUserModelCandidate(ctx, req);
    discoverUserModelsCandidate = (ctx, req) => this.modelProviderService.discoverUserModelsCandidate(ctx, req);
    saveUserModelProviderCandidate = (ctx, req) => this.modelProviderService.saveUserModelProviderCandidate(ctx, req);
    discoverUserModels = (ctx, req) => this.modelProviderService.discoverUserModels(ctx, req);
    updateMinimaxModelContext = (ctx, req) => this.modelProviderService.updateMinimaxModelContext(ctx, req);
    getMinimaxModelSource = (ctx, req) => this.modelProviderService.getMinimaxModelSource(ctx, req);
    setMinimaxModelSource = (ctx, req) => this.modelProviderService.setMinimaxModelSource(ctx, req);
    // ─── session-domain routes ────────────────────────────────────────────────
    // ─── project (contract generated; domain-backed implementation) ───────────
    listProjects(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.listProjects(req));
    }
    listProjectSessions(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.listProjectSessions(req));
    }
    setProjectPinned(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.setProjectPinned(req));
    }
    setProjectHidden(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.setProjectHidden(req));
    }
    putProjectsOrder(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.putProjectsOrder(req));
    }
    archiveProjectSessions(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.archiveProjectSessions(req));
    }
    listRecentProjects(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.listRecentProjects(req));
    }
    touchRecentProject(ctx, req) {
        void ctx;
        return this.mapProjectErrors(() => this.requireProject().service.touchRecentProject(req));
    }
    // ─── session (generated DesktopService -> existing local-runtime API) ────
    // ─── session (generated DesktopService -> existing local-runtime API) ────
    searchSessions(...args) {
        return this.sessionService.searchSessions(...args);
    }
    getRootSession(...args) {
        return this.sessionService.getRootSession(...args);
    }
    replaceRootSession(...args) {
        return this.sessionService.replaceRootSession(...args);
    }
    listSessions(...args) {
        return this.sessionService.listSessions(...args);
    }
    createSession(...args) {
        return this.sessionService.createSession(...args);
    }
    getSessionTree(...args) {
        return this.sessionService.getSessionTree(...args);
    }
    getSidebarSessionTree(...args) {
        return this.sessionService.getSidebarSessionTree(...args);
    }
    getSession(...args) {
        return this.sessionService.getSession(...args);
    }
    async updateSession(...args) {
        const req = args[1];
        const title = req.title;
        const publishTitleUpdated = this.sessionMutationEvents?.titleUpdated;
        if (!publishTitleUpdated)
            return this.sessionService.updateSession(...args);
        return this.runSessionMutation('rename', req.id, title !== undefined ? 'session.title_updated' : undefined, async (startedAt) => {
            const resp = await this.sessionService.updateSession(...args);
            if (title !== undefined) {
                this.publishSessionMutationEvent('rename', req.id, 'session.title_updated', startedAt, () => publishTitleUpdated({
                    sessionId: req.id,
                    ...(resp.session?.agentName ? { agentName: resp.session.agentName } : {}),
                    title,
                }));
            }
            return resp;
        });
    }
    getSessionUsage(...args) {
        return this.sessionService.getSessionUsage(...args);
    }
    getPeekContext(...args) {
        return this.sessionService.getPeekContext(...args);
    }
    // Served by the session-files domain facade over the session asset index
    // (no legacy /mavis/api route exists for this endpoint; the product path is
    // DesktopService only). Contract glue per the desktop-service ownership ADR.
    listSessionFiles(ctx, req) {
        void ctx;
        let service;
        try {
            service = getSessionFilesService();
        }
        catch {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop session-files service is not configured', 'SESSION_FILES_UNAVAILABLE'),
            });
        }
        return service.list(req.id, {
            ...(req.limit !== undefined ? { limit: req.limit } : {}),
            ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
        });
    }
    getSessionDiff(...args) {
        return this.sessionService.getSessionDiff(...args);
    }
    async deleteSession(...args) {
        const sessionId = args[1].id;
        const publishDeleted = this.sessionMutationEvents?.deleted;
        if (!publishDeleted) {
            const resp = await this.sessionService.deleteSession(...args);
            await this.pinService.removePinnedSession(sessionId);
            return resp;
        }
        return this.runSessionMutation('delete', sessionId, 'session.deleted', async (startedAt) => {
            const resp = await this.sessionService.deleteSession(...args);
            await this.pinService.removePinnedSession(sessionId);
            this.publishSessionMutationEvent('delete', sessionId, 'session.deleted', startedAt, () => publishDeleted({ sessionId }));
            return resp;
        });
    }
    async archiveSession(...args) {
        const resp = await this.sessionService.archiveSession(...args);
        if (args[1].archived !== false) {
            await this.pinService.removePinnedSession(args[1].id);
        }
        return resp;
    }
    async compressSession(...args) {
        const resp = await this.sessionService.compressSession(...args);
        if (args[1].archived !== false) {
            await this.pinService.removePinnedSession(args[1].id);
        }
        return resp;
    }
    getMessages(...args) {
        return this.sessionService.getMessages(...args);
    }
    // Session fork, rewind, and message editing are owned by Local Runtime v2.
    // Legacy-only hosts expose the generated routes and fail closed here rather
    // than recreating a second mutation owner in v1.
    getSessionForkOptions(..._args) {
        return this.unimplementedGeneratedMethod('GetSessionForkOptions');
    }
    forkSession(..._args) {
        return this.unimplementedGeneratedMethod('ForkSession');
    }
    getSessionRewindPreview(..._args) {
        return this.unimplementedGeneratedMethod('GetSessionRewindPreview');
    }
    rewindSession(..._args) {
        return this.unimplementedGeneratedMethod('RewindSession');
    }
    editSessionMessage(..._args) {
        return this.unimplementedGeneratedMethod('EditSessionMessage');
    }
    steerSession(..._args) {
        return this.unimplementedGeneratedMethod('SteerSession');
    }
    // Composer send behavior and session source history are owned by Local
    // Runtime v2; legacy-only hosts expose the generated routes fail closed.
    getComposerSendBehavior = () => this.unimplementedGeneratedMethod('GetComposerSendBehavior');
    putComposerSendBehavior = () => this.unimplementedGeneratedMethod('PutComposerSendBehavior');
    getComposerEnterBehavior = () => this.unimplementedGeneratedMethod('GetComposerEnterBehavior');
    putComposerEnterBehavior = () => this.unimplementedGeneratedMethod('PutComposerEnterBehavior');
    listSessionSourceHistory = () => this.unimplementedGeneratedMethod('ListSessionSourceHistory');
    getSessionSourceDetail = () => this.unimplementedGeneratedMethod('GetSessionSourceDetail');
    async listSessionInputSummaries(ctx, req) {
        void ctx;
        let service;
        try {
            service = getSessionInputSummaryService();
        }
        catch {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop session-input-summary service is not configured', 'SESSION_INPUT_SUMMARIES_UNAVAILABLE'),
            });
        }
        try {
            return await service.list(req.id, {
                ...(req.limit !== undefined ? { limit: req.limit } : {}),
                ...(req.before !== undefined ? { before: req.before } : {}),
            });
        }
        catch (error) {
            if (error instanceof SessionInputSummaryValidationError) {
                throw new HTTPException(400, {
                    res: jsonError(400, error.message, 'INVALID_SESSION_INPUT_SUMMARY_PAGINATION'),
                });
            }
            if (error instanceof SessionInputSummaryNotFoundError) {
                throw new HTTPException(404, {
                    res: jsonError(404, error.message, 'SESSION_NOT_FOUND'),
                });
            }
            throw error;
        }
    }
    sendMessage(...args) {
        return this.sessionService.sendMessage(...args);
    }
    resumeSession(...args) {
        return this.sessionService.resumeSession(...args);
    }
    async inspectTurnContinuation() {
        throw new HTTPException(501, {
            res: jsonError(501, 'Turn continuation requires local-runtime-v2.', 'TURN_CONTINUATION_UNSUPPORTED'),
        });
    }
    async continueTurn() {
        throw new HTTPException(501, {
            res: jsonError(501, 'Turn continuation requires local-runtime-v2.', 'TURN_CONTINUATION_UNSUPPORTED'),
        });
    }
    abortSession(...args) {
        return this.sessionService.abortSession(...args);
    }
    listQueueMessages(...args) {
        return this.sessionService.listQueueMessages(...args);
    }
    getQueueItem(...args) {
        return this.sessionService.getQueueItem(...args);
    }
    enqueueMessage(...args) {
        return this.sessionService.enqueueMessage(...args);
    }
    updateQueueItem(...args) {
        return this.sessionService.updateQueueItem(...args);
    }
    reorderQueue(...args) {
        return this.sessionService.reorderQueue(...args);
    }
    deleteQueueItem(...args) {
        return this.sessionService.deleteQueueItem(...args);
    }
    getTurnDiff(...args) {
        return this.sessionService.getTurnDiff(...args);
    }
    requestCompaction(...args) {
        return this.sessionService.requestCompaction(...args);
    }
    requestRotation(...args) {
        return this.sessionService.requestRotation(...args);
    }
    revertTurnDiff(...args) {
        return this.sessionService.revertTurnDiff(...args);
    }
    reapplyTurnDiff(...args) {
        return this.sessionService.reapplyTurnDiff(...args);
    }
    // ─── permission (local ask-UI bus; thin adapter over the legacy routes) ──
    replyPermission(ctx, req) {
        return this.requirePermission().replyPermission(ctx, req);
    }
    replyQuestion(ctx, req) {
        return this.requirePermission().replyQuestion(ctx, req);
    }
    rejectQuestion(ctx, req) {
        return this.requirePermission().rejectQuestion(ctx, req);
    }
    listPendingPermissions(ctx, req) {
        return this.requirePermission().listPendingPermissions(ctx, req);
    }
    dismissPermission(ctx, req) {
        return this.requirePermission().dismissPermission(ctx, req);
    }
    batchReplyPermissions(ctx, req) {
        return this.requirePermission().batchReplyPermissions(ctx, req);
    }
    // ─── cron (unified contract, addressed by cron_id) ─────────────────────
    async listCrons(ctx, req) {
        void ctx;
        void req;
        const cron = this.requireCron();
        await cron.runtime.ensureStarted('desktop_service:list_crons');
        const taskStates = this.isCronConsumerEnabled(cron)
            ? cron.runtime.registry.listAllTasks()
            : await listStoredCronTasks(cron.runtime.cronStore);
        const tasks = taskStates.map(cronStateToCronTask);
        return { tasks, count: tasks.length, hasMore: false };
    }
    async createCron(ctx, req) {
        void ctx;
        const cron = this.requireCron();
        await cron.runtime.ensureStarted('desktop_service:create_cron');
        return this.mapCronErrors(async () => {
            assertCronName(req.cronName);
            if (!(await cron.agentExists(req.name))) {
                throw new CronContractError(404, 'Agent not found', 'AGENT_NOT_FOUND');
            }
            const config = createCronReqToConfig(req);
            assertSchedulable(config);
            await this.assertCronContentSafe(cron, req.cronName, config.prompt);
            const state = this.isCronConsumerEnabled(cron)
                ? await cron.runtime.registry.createTask(req.name, req.cronName, config, {
                    mutationSource: 'ui',
                })
                : await createStoredCronTask(cron.runtime.cronStore, req.name, req.cronName, config);
            return { task: cronStateToCronTask(state) };
        });
    }
    async updateCron(ctx, req) {
        void ctx;
        const cron = this.requireCron();
        await cron.runtime.ensureStarted('desktop_service:update_cron');
        return this.mapCronErrors(async () => {
            const key = await this.resolveKeyOr404(req.cronId);
            const update = updateCronReqToConfigUpdate(req);
            if (Object.keys(update).length === 0) {
                throw new CronContractError(400, 'At least one field must be provided', 'VALIDATION_ERROR');
            }
            const existing = this.isCronConsumerEnabled(cron)
                ? cron.runtime.registry.getTask(key.agentName, key.cronName)
                : await getStoredCronTask(cron.runtime.cronStore, key.agentName, key.cronName);
            if (!existing)
                throw this.cronNotFound(req.cronId);
            await this.assertCronContentSafe(cron, undefined, update.prompt);
            if (update.schedule !== undefined || update.timezone !== undefined) {
                assertSchedulable({
                    schedule: update.schedule ?? existing.config.schedule,
                    timezone: update.timezone === null ? undefined : (update.timezone ?? existing.config.timezone),
                });
            }
            const updated = this.isCronConsumerEnabled(cron)
                ? await cron.runtime.registry.updateConfig(key.agentName, key.cronName, update, {
                    mutationSource: 'ui',
                })
                : await updateStoredCronTask(cron.runtime.cronStore, key.agentName, key.cronName, update);
            if (!updated)
                throw this.cronNotFound(req.cronId);
            return { task: cronStateToCronTask(updated) };
        });
    }
    async deleteCron(ctx, req) {
        void ctx;
        const cron = this.requireCron();
        await cron.runtime.ensureStarted('desktop_service:delete_cron');
        return this.mapCronErrors(async () => {
            const key = await this.resolveKeyOr404(req.cronId);
            const deleted = this.isCronConsumerEnabled(cron)
                ? await cron.runtime.registry.deleteTask(key.agentName, key.cronName, {
                    mutationSource: 'ui',
                })
                : await deleteStoredCronTask(cron.runtime.cronStore, key.agentName, key.cronName);
            if (!deleted)
                throw this.cronNotFound(req.cronId);
            return { success: true };
        });
    }
    async triggerCron(ctx, req) {
        void ctx;
        const cron = this.requireCron();
        await cron.runtime.ensureStarted('desktop_service:trigger_cron');
        return this.mapCronErrors(async () => {
            if (!this.isCronConsumerEnabled(cron)) {
                throw new CronContractError(409, 'Cron consumer is disabled for this runtime', 'CRON_CONSUMER_DISABLED');
            }
            const key = await this.resolveKeyOr404(req.cronId);
            const task = cron.runtime.registry.getTask(key.agentName, key.cronName);
            if (!task)
                throw this.cronNotFound(req.cronId);
            const result = await cron.runtime.registry.triggerTask(key.agentName, key.cronName, {
                triggerSource: 'ui',
            });
            const accepted = result.executed || result.reason === 'enqueued';
            return {
                success: accepted,
                triggeredAt: String(cron.nowMs()),
                ...(result.reason ? { reason: result.reason } : {}),
                ...(result.sessionId ? { sessionId: result.sessionId } : {}),
            };
        });
    }
    async listCronSessions(ctx, req) {
        void ctx;
        const cron = this.requireCron();
        await cron.runtime.ensureStarted('desktop_service:list_cron_sessions');
        return this.mapCronErrors(async () => {
            const key = await this.resolveKeyOr404(req.cronId);
            const task = this.isCronConsumerEnabled(cron)
                ? cron.runtime.registry.getTask(key.agentName, key.cronName)
                : await getStoredCronTask(cron.runtime.cronStore, key.agentName, key.cronName);
            if (!task)
                throw this.cronNotFound(req.cronId);
            const history = await cron.runtime.registry.getSessionHistory(key.agentName, key.cronName);
            const page = pageCronSessions(history.slice().reverse(), req.cursor, req.limit);
            const sessions = await Promise.all(page.items.map(async (record) => {
                const session = await cron.getSessionById(record.sessionId).catch(() => undefined);
                return {
                    sessionId: record.sessionId,
                    createdAt: record.createdAt,
                    ...(session?.title ? { title: session.title } : {}),
                    ...(session ? { status: toCronSessionStatusLabel(session.status) } : {}),
                };
            }));
            return {
                sessions,
                total: history.length,
                hasMore: page.hasMore,
            };
        });
    }
    // Cron v2 定义和运行契约由 local-runtime-v2 前门持有。
    // 旧 v1 DesktopService 不持有 Cron v2。这些生成方法存在于共享契约基类中，
    // Cron v2 写入端和执行器只由 local-runtime-v2 宿主组合，参见
    // packages/local-runtime-v2/src/runtime.ts。在此提供服务会打开第二个
    // Cron 写入端，因此 v1 返回稳定的不支持错误。v2 前门挂载的路由会覆盖这里。
    async listCronDefinitions(ctx, req) {
        void ctx;
        void req;
        throw cronV2Unsupported('listCronDefinitions');
    }
    async getCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw cronV2Unsupported('getCronDefinition');
    }
    async createCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw cronV2Unsupported('createCronDefinition');
    }
    async updateCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw cronV2Unsupported('updateCronDefinition');
    }
    async deleteCronDefinition(ctx, req) {
        void ctx;
        void req;
        throw cronV2Unsupported('deleteCronDefinition');
    }
    async triggerCronRun(ctx, req) {
        void ctx;
        void req;
        throw cronV2Unsupported('triggerCronRun');
    }
    async listCronRuns(ctx, req) {
        void ctx;
        void req;
        throw cronV2Unsupported('listCronRuns');
    }
    // LLM Context Inspector 只存在于 local-runtime-v2：capture、Session 文件历史
    // 与全局设置都由 v2 前门持有。v1 宿主返回稳定的不支持错误，避免打开第二个
    // Inspector 读取端。
    async getSessionLlmContextOverview(ctx, req) {
        void ctx;
        void req;
        throw llmContextInspectorUnsupported('getSessionLlmContextOverview');
    }
    async getSessionLlmContextCall(ctx, req) {
        void ctx;
        void req;
        throw llmContextInspectorUnsupported('getSessionLlmContextCall');
    }
    async putLlmContextCapture(ctx, req) {
        void ctx;
        void req;
        throw llmContextInspectorUnsupported('putLlmContextCapture');
    }
    async getLlmContextCapture(ctx, req) {
        void ctx;
        void req;
        throw llmContextInspectorUnsupported('getLlmContextCapture');
    }
    async getLlmContextSessions(ctx, req) {
        void ctx;
        void req;
        throw llmContextInspectorUnsupported('getLlmContextSessions');
    }
    async clearSessionLlmContextHistory(ctx, req) {
        void ctx;
        void req;
        throw llmContextInspectorUnsupported('clearSessionLlmContextHistory');
    }
    getAgentShellStatus = sandboxUnsupported('getAgentShellStatus');
    putAgentShellPreference = sandboxUnsupported('putAgentShellPreference');
    // Memory v2 与 legacy 记忆迁移不由 v1 兼容宿主持有；共享生成契约在此保持显式拒绝。
    getMemoryV2Status(_ctx, _req) {
        return this.unimplementedGeneratedMethod('GetMemoryV2Status');
    }
    listMemoryV2Sessions(_ctx, _req) {
        return this.unimplementedGeneratedMethod('ListMemoryV2Sessions');
    }
    getMemoryV2SessionDoc(_ctx, _req) {
        return this.unimplementedGeneratedMethod('GetMemoryV2SessionDoc');
    }
    forgetMemoryV2Content(_ctx, _req) {
        return this.unimplementedGeneratedMethod('ForgetMemoryV2Content');
    }
    resetMemoryV2Scope(_ctx, _req) {
        return this.unimplementedGeneratedMethod('ResetMemoryV2Scope');
    }
    prepareLegacyMemoryMigration(_ctx, _req) {
        return this.unimplementedGeneratedMethod('PrepareLegacyMemoryMigration');
    }
    acceptLegacyMemoryMigration(_ctx, _req) {
        return this.unimplementedGeneratedMethod('AcceptLegacyMemoryMigration');
    }
    discardLegacyMemoryMigration(_ctx, _req) {
        return this.unimplementedGeneratedMethod('DiscardLegacyMemoryMigration');
    }
    getSandboxStatus = sandboxUnsupported('getSandboxStatus');
    putSandboxConfig = sandboxUnsupported('putSandboxConfig');
    getSandboxViolations = sandboxUnsupported('getSandboxViolations');
    async deliverCron(ctx, req) {
        void ctx;
        void req;
        // 明确拒绝请求，严禁通过旧 daemon 投递 Cron。
        return {
            delivered: false,
            errorCode: 'CRON_DELIVERY_UNAVAILABLE',
            error: 'Cron delivery is served by the local-runtime-v2 front door',
        };
    }
    async createGoal(ctx, req) {
        void ctx;
        return this.mapGoalErrors(async () => {
            const goal = this.requireGoal();
            await this.assertGoalSessionMutable(req.sessionId);
            const goalConfig = getConfig().goal;
            const input = createGoalReqToCreateInput(req, goalConfig.objectiveMaxChars === undefined
                ? {}
                : { objectiveMaxChars: goalConfig.objectiveMaxChars });
            const created = await goal.createGoal(input);
            return { goal: goalStateToGoalState(created) };
        });
    }
    async getGoal(ctx, req) {
        void ctx;
        const goal = this.requireGoal();
        return this.mapGoalErrors(async () => {
            const sessionId = requireSessionId(req.sessionId);
            // Keep HTTP glue free of timing arithmetic: Thread Goal owns how a
            // persisted row is projected while the local-runtime turn is live.
            const state = goal.getBySessionForResponse
                ? await goal.getBySessionForResponse(sessionId)
                : await goal.store.getBySession(sessionId);
            return state ? { goal: goalStateToGoalState(state) } : {};
        });
    }
    async patchGoal(ctx, req) {
        void ctx;
        const goal = this.requireGoal();
        return this.mapGoalErrors(async () => {
            const sessionId = requireSessionId(req.sessionId);
            const existing = await goal.store.getBySession(sessionId);
            if (!existing)
                throw this.goalNotFound(sessionId);
            await this.assertGoalSessionMutable(sessionId);
            const goalConfig = getConfig().goal;
            const { patch, hasChange, isUserPause } = patchGoalReqToPatchInput(req, goalConfig.objectiveMaxChars === undefined
                ? {}
                : { objectiveMaxChars: goalConfig.objectiveMaxChars });
            if (!hasChange) {
                throw new ThreadGoalContractError(400, 'PATCH body must include status, objective, or token_budget.', 'VALIDATION_ERROR');
            }
            // Route on the caller's intent, not on the patch's field shape: an
            // explicit user pause is an atomic lifecycle transition, not a field
            // update that happens to set `status`.
            const goalForResponse = isUserPause
                ? await goal.pauseGoalByUser(sessionId)
                : await goal.patchGoal(sessionId, patch);
            if (!goalForResponse)
                throw this.goalNotFound(sessionId);
            return { goal: goalStateToGoalState(goalForResponse) };
        });
    }
    async deleteGoal(ctx, req) {
        void ctx;
        const goal = this.requireGoal();
        return this.mapGoalErrors(async () => {
            const sessionId = requireSessionId(req.sessionId);
            const existing = await goal.store.getBySession(sessionId);
            if (!existing)
                return { success: true };
            await this.assertGoalSessionMutable(sessionId);
            await goal.deleteGoal(sessionId);
            return { success: true };
        });
    }
    // ─── channel (desktop/local-runtime only) ────────────────────────────────
    // The channel handlers + their local-API dispatch helpers live in
    // DesktopChannelServiceBase (./desktop-channel-service.js). This concrete
    // service only supplies the host's local-API route.
    getLocalApiRoute() {
        return this.cron?.routeLocalApiRequest;
    }
    listSkills = () => this.unimplementedGeneratedMethod('listSkills');
    listSkillHub = () => this.unimplementedGeneratedMethod('listSkillHub');
    installSkill = () => this.unimplementedGeneratedMethod('installSkill');
    previewSkill = () => this.unimplementedGeneratedMethod('previewSkill');
    createSkill = () => this.unimplementedGeneratedMethod('createSkill');
    getSkill = () => this.unimplementedGeneratedMethod('getSkill');
    listSkillFiles = () => this.unimplementedGeneratedMethod('listSkillFiles');
    getSkillFile = () => this.unimplementedGeneratedMethod('getSkillFile');
    deleteSkill = () => this.unimplementedGeneratedMethod('deleteSkill');
    listRuntimeSkills = () => this.unimplementedGeneratedMethod('listRuntimeSkills');
    getSkillEvolveUsage = () => this.unimplementedGeneratedMethod('getSkillEvolveUsage');
    reportSkillEvolveSignal = () => this.unimplementedGeneratedMethod('reportSkillEvolveSignal');
    cancelSkillEvolveSignal = () => this.unimplementedGeneratedMethod('cancelSkillEvolveSignal');
    listSkillEvolveSignals = () => this.unimplementedGeneratedMethod('listSkillEvolveSignals');
    reportSkillEvolveProposal = () => this.unimplementedGeneratedMethod('reportSkillEvolveProposal');
    cancelSkillEvolveProposal = () => this.unimplementedGeneratedMethod('cancelSkillEvolveProposal');
    markSkillEvolveProposalActed = () => this.unimplementedGeneratedMethod('markSkillEvolveProposalActed');
    listSkillEvolveProposals = () => this.unimplementedGeneratedMethod('listSkillEvolveProposals');
    getSkillEvolveProposal = () => this.unimplementedGeneratedMethod('getSkillEvolveProposal');
    getSkillEvolveHistory = () => this.unimplementedGeneratedMethod('getSkillEvolveHistory');
    triggerSkillEvolve = () => this.unimplementedGeneratedMethod('triggerSkillEvolve');
    requestSkillEvolveScan = () => this.unimplementedGeneratedMethod('requestSkillEvolveScan');
    revertSkillEvolve = () => this.unimplementedGeneratedMethod('revertSkillEvolve');
    mutateSkillEvolveLifecycle = () => this.unimplementedGeneratedMethod('mutateSkillEvolveLifecycle');
    requireGoal() {
        if (!this.goal) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Thread goal store is not available', 'GOAL_UNAVAILABLE'),
            });
        }
        if (this.goal.isEnabled?.() === false) {
            throw new HTTPException(403, {
                res: jsonError(403, 'Thread Goal is disabled', 'GOAL_DISABLED'),
            });
        }
        return this.goal;
    }
    async assertGoalSessionMutable(sessionId) {
        const hook = this.goal?.isReadOnlyLegacySession;
        if (hook && (await hook(sessionId))) {
            throw new HTTPException(409, {
                res: jsonError(409, 'Legacy opencode sessions are read-only in clean local-runtime mode.', 'read_only_legacy_session'),
            });
        }
    }
    goalNotFound(sessionId) {
        return new HTTPException(404, {
            res: jsonError(404, `Goal not found for session: ${sessionId}`, 'GOAL_NOT_FOUND'),
        });
    }
    async mapGoalErrors(fn) {
        try {
            return await fn();
        }
        catch (err) {
            if (err instanceof HTTPException)
                throw err;
            const mapped = toThreadGoalContractError(err);
            throw new HTTPException(mapped.status, {
                res: jsonError(mapped.status, mapped.message, mapped.code),
            });
        }
    }
    requireCron() {
        if (!this.cron) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Cron runtime is not available', 'CRON_UNAVAILABLE'),
            });
        }
        return this.cron;
    }
    isCronConsumerEnabled(cron) {
        // Older unit-test/runtime mocks predate `cronConsumerEnabled`; preserve the
        // historical registry-backed path unless the runtime explicitly disables
        // the consumer for CLI/embedded hosts.
        return cron.runtime.cronConsumerEnabled !== false;
    }
    offline() {
        return (_ctx, _req) => this.rejectChannel();
    }
    requireAgents() {
        if (!this.agents) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop agent service is not configured', 'AGENT_UNAVAILABLE'),
            });
        }
        return this.agents;
    }
    requirePermission() {
        if (!this.permissionService) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop permission service is not configured', 'PERMISSION_UNAVAILABLE'),
            });
        }
        return this.permissionService;
    }
    async mapAgentErrors(fn) {
        try {
            return await fn();
        }
        catch (err) {
            if (err instanceof HTTPException)
                throw err;
            if (err instanceof LocalAgentContractError) {
                throw new HTTPException(err.status, {
                    res: jsonError(err.status, err.message, err.code),
                });
            }
            throw err;
        }
    }
    requireProject() {
        if (!this.project) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop project service is not configured', 'PROJECT_UNAVAILABLE'),
            });
        }
        return this.project;
    }
    async mapProjectErrors(fn) {
        try {
            return await fn();
        }
        catch (err) {
            if (err instanceof HTTPException)
                throw err;
            if (err instanceof LocalProjectContractError) {
                throw new HTTPException(err.status, {
                    res: jsonError(err.status, err.message, err.code),
                });
            }
            throw err;
        }
    }
    async runSessionMutation(operation, sessionId, eventType, run) {
        const startedAt = Date.now();
        try {
            const result = await run(startedAt);
            if (eventType === undefined && this.sessionMutationEvents) {
                logger.info({
                    component: 'desktop_session_mutation',
                    operation,
                    session_id: sessionId,
                    status: 'ok',
                    event_type: 'none',
                    event_status: 'skipped',
                    duration_ms: Date.now() - startedAt,
                    reason: 'no_title',
                }, 'desktop session mutation committed without an event');
                this.metricsClient?.counter('session_mutation_event_total', 1, {
                    operation,
                    status: 'skipped',
                });
            }
            return result;
        }
        catch (error) {
            logger.warn({
                component: 'desktop_session_mutation',
                operation,
                session_id: sessionId,
                status: 'error',
                event_type: eventType ?? 'none',
                event_status: 'not_emitted',
                duration_ms: Date.now() - startedAt,
                error_code: 'SESSION_MUTATION_FAILED',
                err: safeSessionMutationError(error),
            }, 'desktop session mutation failed before event publication');
            this.metricsClient?.counter('session_mutation_event_total', 1, {
                operation,
                status: 'mutation_failed',
            });
            throw error;
        }
    }
    publishSessionMutationEvent(operation, sessionId, eventType, mutationStartedAt, publish) {
        if (!this.sessionMutationEvents)
            return;
        try {
            publish();
            this.metricsClient?.counter('session_mutation_event_total', 1, {
                operation,
                status: 'emitted',
            });
            logger.info({
                component: 'desktop_session_mutation',
                operation,
                session_id: sessionId,
                status: 'ok',
                event_type: eventType,
                event_status: 'emitted',
                duration_ms: Date.now() - mutationStartedAt,
            }, 'desktop session mutation event emitted');
        }
        catch (error) {
            this.metricsClient?.counter('session_mutation_event_total', 1, {
                operation,
                status: 'emit_failed',
            });
            logger.warn({
                component: 'desktop_session_mutation',
                operation,
                session_id: sessionId,
                status: 'ok',
                event_type: eventType,
                event_status: 'emit_failed',
                duration_ms: Date.now() - mutationStartedAt,
                error_code: 'SESSION_MUTATION_EVENT_EMIT_FAILED',
                err: safeSessionMutationError(error),
            }, 'desktop session mutation committed but event publication failed');
        }
    }
    rejectChannel() {
        return Promise.reject(new HTTPException(503, {
            res: jsonError(503, 'Desktop channel service is not configured', 'CHANNEL_UNAVAILABLE'),
        }));
    }
    requireReviewService() {
        if (!this.reviewService) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Desktop review service is not configured', 'REVIEW_UNAVAILABLE'),
            });
        }
        return this.reviewService;
    }
    unimplementedGeneratedMethod(method) {
        throw new HTTPException(501, {
            res: jsonError(501, `DesktopService.${method} is not implemented by local-runtime.`, 'NOT_IMPLEMENTED'),
        });
    }
    async resolveKeyOr404(cronId) {
        const cron = this.requireCron();
        const key = await cron.resolveCronKey(cronId);
        if (!key)
            throw this.cronNotFound(cronId);
        return key;
    }
    cronNotFound(cronId) {
        return new HTTPException(404, {
            res: jsonError(404, `Cron task not found: ${cronId}`, 'CRON_TASK_NOT_FOUND'),
        });
    }
    /** Gate user-authored cron text (prompt / name) on create + update with the
     * shared fail policy (rejected / local_error block, api_error degrade-passes).
     * Reject → generic 422 CONTENT_POLICY_VIOLATION; no review detail leaks. */
    async assertCronContentSafe(cron, name, prompt) {
        if (await cronReviewBlocks(cron.reviewContent, name, prompt)) {
            throw new HTTPException(422, {
                res: jsonError(422, 'Content validation failed', 'CONTENT_POLICY_VIOLATION'),
            });
        }
    }
    async mapCronErrors(fn) {
        try {
            return await fn();
        }
        catch (err) {
            if (err instanceof HTTPException)
                throw err;
            const mapped = toCronContractError(err);
            throw new HTTPException(mapped.status, {
                // Forward the mapped `errorCode` (e.g. 40903 for duplicate cron)
                // so the UI can render the localized `errors.codes.<n>` copy
                // instead of the raw English daemon message.
                res: jsonError(mapped.status, mapped.message, mapped.code, mapped.errorCode),
            });
        }
    }
}
//# sourceMappingURL=server.js.map