import { PermissionReply, QuestionnairePurpose, QuestionnaireReopenReason, QuestionnaireSelectionMode, QuestionnaireStatus, } from '@mavis/thrift-gen/generated/desktop-service/types';
/** Process-local entrypoint that reuses generated wire contracts and existing Applications. */
export class CliService {
    options;
    constructor(options) {
        this.options = options;
    }
    listSessions(req, ctx = {}) {
        return this.options.applications.session.query.listSessions(ctx, req);
    }
    createSession(req, ctx = {}) {
        if (req.workspaceDir?.trim()) {
            return this.options.applications.session.lifecycle.createExplicitWorkspaceSession(ctx, req);
        }
        return this.options.applications.session.lifecycle.createSession(ctx, req);
    }
    configureSessionMcpServers(req) {
        return this.requireCapability('mcp', 'MCP').configureSessionServers(req);
    }
    async inspectProjectMcp(sessionId) {
        return this.requireCapability('mcp', 'MCP').inspectProjectMcp(await this.projectMcpContext(sessionId));
    }
    async projectMcpContext(sessionId) {
        const result = await this.getSession({ id: sessionId });
        const workspaceRoot = result.session?.workspaceDir;
        if (!workspaceRoot)
            throw new Error('Session has no workspace for project MCP.');
        return { sessionId, workspaceRoot };
    }
    clearSessionMcpServers(sessionId) {
        return this.requireCapability('mcp', 'MCP').clearSessionServers(sessionId);
    }
    getSession(req, ctx = {}) {
        return this.options.applications.session.query.getSession(ctx, req);
    }
    getSessionTree(req, ctx = {}) {
        return this.options.applications.session.query.getSessionTree(ctx, req);
    }
    updateSession(req, ctx = {}) {
        return this.options.applications.session.lifecycle.updateSession(ctx, req);
    }
    archiveSession(req, ctx = {}) {
        return this.options.applications.session.lifecycle.archiveSession(ctx, req);
    }
    async deleteSession(req, ctx = {}) {
        return this.options.applications.session.lifecycle.deleteSession(ctx, req);
    }
    getMessages(req, ctx = {}) {
        return this.options.applications.session.content.getMessages(ctx, req);
    }
    listSessionInputSummaries(req, ctx = {}) {
        return this.options.applications.session.content.listSessionInputSummaries(ctx, req);
    }
    getSessionForkOptions(req, ctx = {}) {
        return this.options.applications.session.conversationMutation.getSessionForkOptions(ctx, req);
    }
    forkSession(req, ctx = {}) {
        return this.options.applications.session.conversationMutation.forkSession(ctx, req);
    }
    getSessionRewindPreview(req, ctx = {}) {
        return this.options.applications.session.conversationMutation.getSessionRewindPreview(ctx, req);
    }
    rewindSession(req, ctx = {}) {
        return this.options.applications.session.conversationMutation.rewindSession(ctx, req);
    }
    editSessionMessage(req, ctx = {}) {
        return this.options.applications.session.conversationMutation.editSessionMessage(ctx, req);
    }
    getSessionUsage(req, ctx = {}) {
        return this.options.applications.session.content.getSessionUsage(ctx, req);
    }
    getSessionUsageSummary(req, ctx = {}) {
        return this.options.applications.session.content.getSessionUsageSummary(ctx, req);
    }
    getPeekContext(req, ctx = {}) {
        return this.options.applications.session.content.getPeekContext(ctx, req);
    }
    sendMessage(req, ctx = {}, options) {
        return options
            ? this.options.conversation.sendMessage(ctx, req, options)
            : this.options.conversation.sendMessage(ctx, req);
    }
    resumeSession(req, ctx = {}) {
        return this.options.conversation.resumeSession(ctx, req);
    }
    abortSession(req, ctx = {}) {
        return this.options.conversation.abortSession(ctx, req);
    }
    steerSession(req, ctx = {}) {
        return this.options.conversation.steerSession(ctx, req);
    }
    enqueueMessage(req, ctx = {}) {
        return this.options.conversation.enqueueMessage(ctx, req);
    }
    requestCompaction(req, ctx = {}) {
        return this.options.conversation.requestCompaction(ctx, req);
    }
    async getPendingQuestionnaire(req, ctx = {}) {
        void ctx;
        const questionnaires = this.requireQuestionnaires();
        const scope = { agentName: req.name, sessionId: req.sessionId };
        let unanswered;
        if (req.includeUnanswered) {
            if (!questionnaires.listUnanswered) {
                throw new Error('Runtime does not expose unanswered Questionnaire recovery.');
            }
            unanswered = await questionnaires.listUnanswered(scope);
        }
        const request = await questionnaires.getPending(scope);
        return {
            ...(request ? { request: toQuestionnaireRequestView(request) } : {}),
            ...(unanswered ? { unansweredRequests: unanswered.map(toQuestionnaireRequestView) } : {}),
        };
    }
    async getLatestPlanReview(req, ctx = {}) {
        void ctx;
        const record = await this.requireQuestionnaires().getLatestPlanReview({
            agentName: req.name,
            sessionId: req.sessionId,
        });
        if (!record)
            return {};
        return {
            request: toQuestionnaireRequestView(record.request),
            status: toQuestionnaireStatus(record.status),
            sessionId: record.sessionId,
            ...(record.agentName ? { agentName: record.agentName } : {}),
            createdAt: record.createdAt,
            ...(record.answeredAt !== undefined ? { answeredAt: record.answeredAt } : {}),
            ...(record.dismissedAt !== undefined ? { dismissedAt: record.dismissedAt } : {}),
        };
    }
    getPlanModeCapabilities() {
        return { entryEnabled: this.requireCapability('plan', 'Plan').isEntryEnabled() };
    }
    async replyQuestionnaire(req, ctx = {}) {
        void ctx;
        const result = await this.requireQuestionnaires().reply({
            agentName: req.name,
            requestId: req.requestId,
            answers: req.answers.map((answer) => ({
                stepId: answer.stepId,
                selectedOptionIds: answer.selectedOptionIds ?? [],
                selectedOther: answer.selectedOther === true,
                ...(answer.otherText ? { otherText: answer.otherText } : {}),
                ...(answer.skipped === true ? { skipped: true } : {}),
                ...(answer.contextImages?.length ? { contextImages: answer.contextImages } : {}),
            })),
            submittedAt: req.submittedAt ?? Date.now(),
        });
        return {
            ...result,
            state: result.state
                ? { ...result.state, status: toQuestionnaireStatus(result.state.status) }
                : undefined,
        };
    }
    dismissQuestionnaire(req, ctx = {}) {
        void ctx;
        return this.requireQuestionnaires().dismiss({
            agentName: req.name,
            requestId: req.requestId,
        });
    }
    async listPendingPermissions(req, ctx = {}) {
        void req;
        void ctx;
        const requests = await this.requirePermissions().listPending();
        return {
            requests: requests.map((request) => ({
                requestId: request.requestId,
                sessionId: request.sessionId,
                agentName: request.agentName,
                toolName: request.toolName,
                ruleContents: [...request.ruleContents],
                ...(request.toolInput !== undefined ? { toolInput: request.toolInput } : {}),
                ...(request.toolDescription !== undefined
                    ? { toolDescription: request.toolDescription }
                    : {}),
                reason: request.reason,
                allowAlwaysSupported: request.allowAlwaysSupported,
                createdAt: request.createdAt,
            })),
        };
    }
    async replyPermission(req, ctx = {}) {
        void ctx;
        const result = await this.requirePermissions().reply({
            requestIds: [req.requestId],
            decision: toPermissionDecision(req.reply),
        });
        return { success: result.processed.includes(req.requestId) };
    }
    listQueueMessages(req, ctx = {}) {
        return this.options.applications.queue.listQueueMessages(ctx, req);
    }
    getQueueItem(req, ctx = {}) {
        return this.options.applications.queue.getQueueItem(ctx, req);
    }
    updateQueueItem(req, ctx = {}) {
        return this.options.applications.queue.updateQueueItem(ctx, req);
    }
    reorderQueue(req, ctx = {}) {
        return this.options.applications.queue.reorderQueue(ctx, req);
    }
    deleteQueueItem(req, ctx = {}) {
        return this.options.applications.queue.deleteQueueItem(ctx, req);
    }
    steer(input) {
        return this.options.conversation.steer(input);
    }
    getActiveTurn(sessionId) {
        return this.options.conversation.getActiveTurn(sessionId);
    }
    beginProcessDrain() {
        const drain = this.options.processLifecycle.beginDrain();
        return { accepted: true, ...drain };
    }
    tryBeginProcessDrainIfIdle() {
        const result = this.options.processLifecycle.tryBeginDrainIfIdle();
        if (!result.acquired) {
            return {
                accepted: false,
                activeTurnCount: result.activeTurnCount,
                pendingAdmissionCount: result.pendingAdmissionCount,
            };
        }
        return { accepted: true, ...result.drain };
    }
    watchEvents(signal) {
        return this.options.application.events.watch(signal);
    }
    watchSessionUsageCommits(signal) {
        return this.requireCapability('usage', 'Usage').watchCommits(signal);
    }
    isGoalEnabled() {
        return this.requireCapability('goals', 'Goal').isEnabled();
    }
    getGoal(sessionId) {
        return this.requireCapability('goals', 'Goal').get(sessionId);
    }
    createGoal(input) {
        return this.requireCapability('goals', 'Goal').create(input);
    }
    patchGoal(sessionId, patch) {
        return this.requireCapability('goals', 'Goal').patch(sessionId, patch);
    }
    resumeGoal(sessionId) {
        return this.requireCapability('goals', 'Goal').resume(sessionId);
    }
    clearGoal(sessionId) {
        return this.requireCapability('goals', 'Goal').clear(sessionId);
    }
    getRunningGoalTurnId(sessionId) {
        return this.requireCapability('goals', 'Goal').runningTurnId(sessionId);
    }
    getWorkspaceGitMetadata(workspaceDir) {
        return this.requireCapability('workspace', 'Workspace').git.getMetadata(workspaceDir);
    }
    /**
     * Reads the review link recorded for a workspace branch.
     *
     * Resolves to `undefined` when the runtime predates the capability, so a
     * caller can treat "not supported" and "nothing recorded" alike — both mean
     * there is no review to show.
     */
    getWorkspaceReviewLink(workspaceDir, branch) {
        const git = this.requireCapability('workspace', 'Workspace').git;
        if (!git.getReviewLink)
            return Promise.resolve(undefined);
        return git.getReviewLink(workspaceDir, branch);
    }
    listWorkspaceFileTree(input) {
        const listFileTree = this.requireCapability('workspace', 'Workspace').listFileTree;
        if (!listFileTree)
            throw new Error('Runtime does not expose Workspace file-tree reads.');
        return listFileTree(input);
    }
    searchWorkspaceFiles(input) {
        const searchFiles = this.requireCapability('workspace', 'Workspace').searchFiles;
        if (!searchFiles)
            throw new Error('Runtime does not expose Workspace file search.');
        return searchFiles(input);
    }
    getAccountStatus(input) {
        return this.requireCapability('account', 'Account').getStatus(input);
    }
    getRuntimeDiagnostics() {
        return this.requireCapability('diagnostics', 'Diagnostics').getRuntimeSnapshot();
    }
    collectSessionReport(sessionId) {
        const diagnostics = this.requireCapability('diagnostics', 'Diagnostics');
        if (!diagnostics.collectSessionReport) {
            throw new Error('Runtime does not expose Session report diagnostics.');
        }
        return diagnostics.collectSessionReport(sessionId);
    }
    getInstructionSources(input) {
        return this.requireCapability('instructions', 'Instructions').listSources(input);
    }
    refreshPlugins() {
        return this.options.application.plugins.refresh();
    }
    listMarketplacePlugins(req) {
        return this.options.application.plugins.listMarketplacePlugins(req);
    }
    listInstalledPlugins(req) {
        return this.options.application.plugins.listInstalledPlugins(req);
    }
    installPlugin(req) {
        return this.options.application.plugins.installPlugin(req);
    }
    enablePlugin(req) {
        return this.options.application.plugins.enablePlugin(req);
    }
    disablePlugin(req) {
        return this.options.application.plugins.disablePlugin(req);
    }
    uninstallPlugin(req) {
        return this.options.application.plugins.uninstallPlugin(req);
    }
    getPermissionMode() {
        return this.requireCapability('configuration', 'Configuration').getPermissionMode();
    }
    setPermissionMode(input) {
        return this.requireCapability('configuration', 'Configuration').setPermissionMode(input);
    }
    /** Undefined when this host cannot read the next-message suggestion switch. */
    getPromptSuggestionEnabled() {
        return this.options.application.configuration?.getPromptSuggestionEnabled?.();
    }
    /** Undefined when this host cannot persist the next-message suggestion switch. */
    setPromptSuggestionEnabled(enabled) {
        return this.options.application.configuration?.setPromptSuggestionEnabled?.({ enabled });
    }
    listModels(input) {
        return this.requireCapability('models', 'Model').list(input);
    }
    selectModel(input) {
        return this.requireCapability('models', 'Model').select(input);
    }
    /** Resolves false when the host has no model-favorite store. */
    async setModelFavorite(input) {
        const models = this.requireCapability('models', 'Model');
        if (!models.setFavorite)
            return false;
        return models.setFavorite(input);
    }
    listUserModelProviders() {
        return this.requireCapability('modelProviders', 'Model Provider').listUser();
    }
    listProviderPresets() {
        return this.requireCapability('modelProviders', 'Model Provider').listProviderPresets();
    }
    getCodexOAuthStatus() {
        return this.requireCapability('modelProviders', 'Model Provider').getCodexOAuthStatus();
    }
    startCodexOAuthLogin(options) {
        return this.requireCapability('modelProviders', 'Model Provider').startCodexOAuthLogin(options);
    }
    cancelCodexOAuthLogin(loginId) {
        return this.requireCapability('modelProviders', 'Model Provider').cancelCodexOAuthLogin(loginId);
    }
    getMiniMaxApiKeyStatus() {
        return this.requireCapability('modelProviders', 'Model Provider').getMiniMaxApiKeyStatus();
    }
    getMiniMaxModelSource() {
        return this.requireCapability('modelProviders', 'Model Provider').getMiniMaxModelSource();
    }
    setMiniMaxModelSource(input) {
        return this.requireCapability('modelProviders', 'Model Provider').setMiniMaxModelSource(input);
    }
    upsertMiniMaxApiKey(input) {
        return this.requireCapability('modelProviders', 'Model Provider').upsertMiniMaxApiKey(input);
    }
    createUserModelProvider(input) {
        return this.requireCapability('modelProviders', 'Model Provider').create(input);
    }
    discoverUserModelsCandidate(input) {
        return this.requireCapability('modelProviders', 'Model Provider').discoverCandidate(input);
    }
    saveUserModelProviderCandidate(input) {
        return this.requireCapability('modelProviders', 'Model Provider').saveCandidate(input);
    }
    updateUserModelProvider(input) {
        return this.requireCapability('modelProviders', 'Model Provider').update(input);
    }
    deleteUserModelProvider(input) {
        return this.requireCapability('modelProviders', 'Model Provider').delete(input);
    }
    testUserModelProvider(input) {
        return this.requireCapability('modelProviders', 'Model Provider').testProvider(input);
    }
    testUserModel(input) {
        return this.requireCapability('modelProviders', 'Model Provider').testModel(input);
    }
    listSkills(input) {
        return this.options.application.skills.listSkills(input);
    }
    listRuntimeSkills(input) {
        return this.options.application.skills.listRuntimeSkills(input);
    }
    listBackgroundTasks(input) {
        return this.requireCapability('backgroundTasks', 'Background Task').list(input);
    }
    async listMcpServers(input) {
        const mcp = this.requireCapability('mcp', 'MCP');
        const context = input.sessionId ? await this.projectMcpContext(input.sessionId) : undefined;
        return mcp.listMcpCapabilities
            ? mcp.listMcpCapabilities({ keyword: input.keyword, context })
            : mcp.listLocalMcpServers(input);
    }
    requireQuestionnaires() {
        const questionnaires = this.options.application.questionnaires;
        if (!questionnaires)
            throw new Error('Runtime does not expose Questionnaire Application.');
        return questionnaires;
    }
    requirePermissions() {
        const permissions = this.options.application.permissions;
        if (!permissions)
            throw new Error('Runtime does not expose Permission Application.');
        return permissions;
    }
    requireCapability(key, label) {
        const capability = this.options.application[key];
        if (!capability)
            throw new Error(`Runtime does not expose ${label} Application.`);
        return capability;
    }
}
function toPermissionDecision(reply) {
    switch (reply) {
        case PermissionReply.AllowOnce:
            return 'allowOnce';
        case PermissionReply.AllowAlways:
            return 'allowAlways';
        case PermissionReply.Deny:
            return 'deny';
        default:
            throw new Error(`Unsupported permission reply: ${String(reply)}`);
    }
}
function toQuestionnaireRequestView(request) {
    return {
        schemaVersion: request.schemaVersion,
        id: request.id,
        ...(request.title ? { title: request.title } : {}),
        ...(request.tool
            ? {
                tool: {
                    messageId: request.tool.message_id,
                    callId: request.tool.call_id,
                },
            }
            : {}),
        ...(request.requester ? { requester: { ...request.requester } } : {}),
        presentation: { ...request.presentation },
        steps: request.steps.map(toQuestionnaireStepView),
        ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
        ...(request.purpose === 'goal' ? { purpose: QuestionnairePurpose.Goal } : {}),
        ...(request.status ? { status: toQuestionnaireStatus(request.status) } : {}),
        ...(request.createdAt !== undefined ? { createdAt: request.createdAt } : {}),
        mode: request.mode ?? 'questionnaire',
        ...(request.modePayload
            ? { modePayload: toQuestionnaireModePayloadView(request.modePayload) }
            : {}),
        ...toQuestionnaireLifecycleView(request),
    };
}
function toQuestionnaireLifecycleView(request) {
    return {
        ...(request.responseMode ? { responseMode: request.responseMode } : {}),
        ...(request.countdownSeconds !== undefined
            ? { countdownSeconds: request.countdownSeconds }
            : {}),
        ...(request.syncWaiting !== undefined ? { syncWaiting: request.syncWaiting } : {}),
        ...(request.originTurnRunning !== undefined
            ? { originTurnRunning: request.originTurnRunning }
            : {}),
        ...(request.answeredAt !== undefined ? { answeredAt: request.answeredAt } : {}),
        ...(request.injectedAt !== undefined ? { injectedAt: request.injectedAt } : {}),
        ...(request.reopenReason === 'content_recall'
            ? { reopenReason: QuestionnaireReopenReason.ContentRecall }
            : {}),
        ...(request.prefillAnswers ? { prefillAnswers: request.prefillAnswers } : {}),
    };
}
function toQuestionnaireStepView(step) {
    return {
        ...step,
        selectionMode: step.selectionMode === 'multiple'
            ? QuestionnaireSelectionMode.Multiple
            : QuestionnaireSelectionMode.Single,
        options: step.options.map((option) => ({
            ...option,
            ...(option.image ? { image: { ...option.image } } : {}),
        })),
        ...(step.image ? { image: { ...step.image } } : {}),
    };
}
function toQuestionnaireModePayloadView(modePayload) {
    return {
        ...modePayload,
        ...(modePayload.planReview ? { planReview: { ...modePayload.planReview } } : {}),
    };
}
function toQuestionnaireStatus(status) {
    switch (status) {
        case 'pending':
            return QuestionnaireStatus.Pending;
        case 'answered':
            return QuestionnaireStatus.Answered;
        case 'expired':
            return QuestionnaireStatus.Expired;
        case 'superseded':
            return QuestionnaireStatus.Superseded;
        case 'dismissed':
            return QuestionnaireStatus.Dismissed;
    }
}
//# sourceMappingURL=cli-service.js.map