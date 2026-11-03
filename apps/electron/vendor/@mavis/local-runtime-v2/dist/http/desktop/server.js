import { HTTPException } from 'hono/http-exception';
import { DesktopUnavailableServiceBase } from './desktop-unavailable-service.js';
import { getSessionFilesService } from '../../infra/legacy-db/session-assets-session-files-service.js';
import { SessionInputSummaryNotFoundError, SessionInputSummaryValidationError, getSessionInputSummaryService, } from '../../infra/legacy-db/session-navigation-service.js';
import { LocalAgentContractError } from '../../infra/legacy-db/agent-contract.js';
import { cronReviewBlocks } from '../../service/content-safety/index.js';
import { CronContractError, assertCronName, assertSchedulable, createCronReqToConfig, createStoredCronTask, cronStateToCronTask, deleteStoredCronTask, getStoredCronTask, listStoredCronTasks, toCronContractError, updateCronReqToConfigUpdate, updateStoredCronTask, } from '../../service/cron/index.js'; // desktop-service-boundary-skip: anchor=server-cron-contract owner=cron reason=legacy-cron-rpc-glue-before-facade; followup=desktop-service-domain-facades
import { LocalProjectContractError } from '../../service/session-system/index.js';
import { DesktopEchoService } from './desktop-echo-service.js';
import { DesktopGlobalEventsService, } from './desktop-global-events-service.js';
import { DesktopModelProviderService, } from './desktop-model-provider-service.js';
import { DesktopPermissionService, } from './desktop-permission-service.js';
import { DesktopPinService } from './desktop-pin-service.js';
import { DesktopReviewService } from './desktop-review-service.js';
import { jsonError, toCronSessionStatusLabel, } from './desktop-service-support.js';
import { SessionMutationTelemetry, } from './desktop-session-mutation-events.js';
import { DesktopSessionService } from './desktop-session-service.js';
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
function resolveUpdatedCronSchedule(update, existing) {
    return {
        schedule: update.schedule ?? existing.schedule,
        timezone: update.timezone === null ? undefined : (update.timezone ?? existing.timezone),
    };
}
async function readCronSession(cron, sessionId) {
    try {
        return await cron.getSessionById(sessionId);
    }
    catch {
        return undefined;
    }
}
export class DesktopService extends DesktopUnavailableServiceBase {
    echoService = new DesktopEchoService();
    sessionService;
    permissionService;
    pinService;
    modelProviderService;
    reviewService;
    globalEventsService;
    cron;
    agents;
    project;
    sessionMutationEvents;
    mutationTelemetry;
    constructor(dependencies = {}) {
        const { cron, memory, agents, permission, pin, project, questionnaire, modelProvider, metricsClient, sessionMutationEvents, review, globalEvents, } = dependencies;
        // Desktop transport stays a consumer of the explicitly injected V2 agent
        // port.  Channel, memory, and questionnaire adapters only need the
        // resolver slice; they must never reconstruct a legacy AgentService.
        super(memory, questionnaire, agents?.service);
        this.cron = cron;
        this.agents = agents;
        this.project = project;
        this.sessionMutationEvents = sessionMutationEvents;
        this.mutationTelemetry = new SessionMutationTelemetry(sessionMutationEvents, metricsClient);
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
    pinAgent(...args) {
        return this.pinService.pinAgent(...args);
    }
    async pinSession(...args) {
        const req = args[1];
        const operation = req.pinned ? 'pin' : 'unpin';
        return this.mutationTelemetry.run(operation, req.sessionId, 'session.pinned_updated', async (startedAt) => {
            const resp = await this.pinService.pinSession(...args);
            this.mutationTelemetry.publish({ operation, sessionId: req.sessionId, eventType: 'session.pinned_updated' }, startedAt, () => this.sessionMutationEvents?.pinnedUpdated({
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
    // ─── models / model providers (BYOK; contract glue in dedicated adapter) ──
    listModels = (ctx, req) => this.modelProviderService.listModels(ctx, req);
    selectModel = (ctx, req) => this.modelProviderService.selectModel(ctx, req);
    listModelProviders = (ctx, req) => this.modelProviderService.listModelProviders(ctx, req);
    listUserModelProviders = (ctx, req) => this.modelProviderService.listUserModelProviders(ctx, req);
    getMiniMaxApiKeyStatus = (ctx, req) => this.modelProviderService.getMiniMaxApiKeyStatus(ctx, req);
    upsertMiniMaxApiKey = (ctx, req) => this.modelProviderService.upsertMiniMaxApiKey(ctx, req);
    createUserModelProvider = (ctx, req) => this.modelProviderService.createUserModelProvider(ctx, req);
    updateUserModelProvider = (ctx, req) => this.modelProviderService.updateUserModelProvider(ctx, req);
    duplicateUserModelProvider = (ctx, req) => this.modelProviderService.duplicateUserModelProvider(ctx, req);
    deleteUserModelProvider = (ctx, req) => this.modelProviderService.deleteUserModelProvider(ctx, req);
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
        return this.mutationTelemetry.run('rename', req.id, title !== undefined ? 'session.title_updated' : undefined, async (startedAt) => {
            const resp = await this.sessionService.updateSession(...args);
            if (title !== undefined) {
                this.mutationTelemetry.publish({ operation: 'rename', sessionId: req.id, eventType: 'session.title_updated' }, startedAt, () => publishTitleUpdated({
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
        return this.mutationTelemetry.run('delete', sessionId, 'session.deleted', async (startedAt) => {
            const resp = await this.sessionService.deleteSession(...args);
            await this.pinService.removePinnedSession(sessionId);
            this.mutationTelemetry.publish({ operation: 'delete', sessionId, eventType: 'session.deleted' }, startedAt, () => publishDeleted({ sessionId }));
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
                assertSchedulable(resolveUpdatedCronSchedule(update, existing.config));
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
                const session = await readCronSession(cron, record.sessionId);
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
    // ─── channel (desktop/local-runtime only) ────────────────────────────────
    // The channel handlers + their local-API dispatch helpers live in
    // DesktopChannelServiceBase (./desktop-channel-service.js). This concrete
    // service only supplies the host's local-API route.
    getLocalApiRoute() {
        return this.cron?.routeLocalApiRequest;
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