/**
 * 所有宿主都会挂载的基础探针；这不是完整的 v2 迁移清单。
 * 业务路由由下方各 capability 集合按宿主实际组装情况动态加入，未被接管的请求继续回落到 v1。
 * 单位为契约 `tsName`，参见设计 D3。
 */
const ALWAYS_MOUNTED_METHODS = new Set([
    'ping',
    'getEcho',
    'getPathEcho',
    'streamEcho',
]);
const AGENT_OWNER_METHODS = new Set([
    'listAgents',
    'createAgent',
    'getAgent',
    'updateAgent',
    'deleteAgent',
    'getAgentConfig',
    'getAgentLegacyHistoryNotice',
    'putAgentConfig',
    'readClaudeCodeAgentImport',
    'readCodexAgentImport',
    'createImportedAgent',
]);
const CANVAS_OWNER_METHODS = new Set([
    'readCanvas',
    'prepareCanvasFiles',
    'applyCanvasOperation',
]);
const GLOBAL_EVENTS_METHODS = new Set(['subscribeGlobalEvents']);
const GLOBAL_INSTRUCTIONS_METHODS = new Set([
    'getGlobalInstructions',
    'putGlobalInstructions',
]);
const WORKSPACE_INDEXING_METHODS = new Set([
    'getWorkspaceIndexingPreference',
    'putWorkspaceIndexingPreference',
    'prewarmWorkspaceIndexing',
]);
/**
 * 依赖 owner services 的路由只在 service 已完成组装和恢复的宿主上挂载，生产环境中该宿主为
 * Electron。嵌入式 CLI 和其他宿主继续回落到 v1。`deliverCron` 位于 Session 契约中，但仍由
 * 同一个 Cron service 提供能力。
 */
const CRON_OWNER_METHODS = new Set([
    'listCronDefinitions',
    'getCronDefinition',
    'createCronDefinition',
    'updateCronDefinition',
    'deleteCronDefinition',
    'triggerCronRun',
    'listCronRuns',
    'deliverCron',
]);
const PREFERENCE_OWNER_METHODS = new Set([
    'getComputerUseDefaultPreference',
    'putComputerUseDefaultPreference',
    'getComposerSendBehavior',
    'putComposerSendBehavior',
    'getComposerEnterBehavior',
    'putComposerEnterBehavior',
]);
const SESSION_TURN_METHODS = new Set([
    'sendMessage',
    'resumeSession',
    'inspectTurnContinuation',
    'continueTurn',
    'abortSession',
    'enqueueMessage',
    'requestCompaction',
    'steerSession',
    'cancelPromptSuggestion',
    'getPromptSuggestion',
]);
/** Desktop Plugin Marketplace and standalone Skill management. */
const PLUGIN_SERVICE_METHODS = new Set([
    'listMarketplacePlugins',
    'getMarketplacePlugin',
    'listInstalledPlugins',
    'listEnabledPlugins',
    'listRuntimeSkills',
    'getSkillEvolveUsage',
    'reportSkillEvolveSignal',
    'cancelSkillEvolveSignal',
    'listSkillEvolveSignals',
    'reportSkillEvolveProposal',
    'cancelSkillEvolveProposal',
    'markSkillEvolveProposalActed',
    'listSkillEvolveProposals',
    'getSkillEvolveProposal',
    'getSkillEvolveHistory',
    'triggerSkillEvolve',
    'requestSkillEvolveScan',
    'revertSkillEvolve',
    'mutateSkillEvolveLifecycle',
    'listSkills',
    'listSkillHub',
    'installSkill',
    'previewSkill',
    'createSkill',
    'getSkill',
    'listSkillFiles',
    'getSkillFile',
    'deleteSkill',
    'installPlugin',
    'uninstallPlugin',
    'enablePlugin',
    'disablePlugin',
    'refreshPlugins',
    'previewGithubPlugin',
    'importGithubPlugin',
    'setSkillEnabled',
]);
const MODEL_PROVIDER_METHODS = new Set([
    'listModels',
    'selectModel',
    'listModelProviders',
    'listUserModelProviders',
    'revealModelProviderApiKey',
    'listByokProviderPresets',
    'getMiniMaxApiKeyStatus',
    'upsertMiniMaxApiKey',
    'createUserModelProvider',
    'updateUserModelProvider',
    'duplicateUserModelProvider',
    'deleteUserModelProvider',
    'testUserModelProvider',
    'testUserModel',
    'updateUserModelParameters',
    'testUserModelCandidate',
    'discoverUserModelsCandidate',
    'saveUserModelProviderCandidate',
    'discoverUserModels',
    'updateMinimaxModelContext',
    'getMinimaxModelSource',
    'setMinimaxModelSource',
]);
const WORKSPACE_GIT_METHODS = new Set([
    'suggestCommitMessage',
    'getWorkspaceFileDiff',
    'listWorkspaceFileDiffs',
    'getWorkspaceDiffContext',
    'getWorkspaceFileStatus',
    'listWorkspaceReviewCommits',
    'getWorkspaceGitGraph',
    'getWorkspaceReviewSummary',
    'listWorkspaceReviewFileDiffs',
    'getWorkspaceReviewFileContent',
    'searchWorkspaceReviewDiffs',
    'probeWorkspaceGit',
    'getWorkspaceGitChanges',
    'getWorkspaceGitMetadata',
    'getWorkspaceGitBranches',
    'listWorkspaceRecentBranches',
    'searchWorkspaceGitBranches',
    'getWorkspaceGitBranchPicker',
    'getWorkspaceGitDefaultBranch',
    'checkoutWorkspaceGitBranch',
    'createWorkspaceGitBranch',
    'commitWorkspaceGit',
    'commitAndPushWorkspaceGit',
    'pushWorkspaceGit',
    'applyWorkspaceGitChangeAction',
    'invalidateWorkspaceGitSnapshot',
    'invalidateAllWorkspaceGitSnapshots',
    'listWorkspaceGitWorktrees',
]);
/**
 * Runtime-owned filesystem surface used by Remote Control and Desktop.
 * `previewWorkspaceFile`, `listFsDirs`, and `getFsGitInfo` are host-scope by
 * design (attachment previews and the workspace picker predate any workspace
 * root); the caller is the authenticated same-user client behind SSH.
 */
const WORKSPACE_FILE_METHODS = new Set([
    'getWorkspaceFileMetadata',
    'listWorkspaceFileTree',
    'readWorkspaceFile',
    'saveWorkspaceFile',
    'searchWorkspaceFiles',
    'previewWorkspaceFile',
    'createWorkspaceGitWorktree',
    'removeWorkspaceGitWorktree',
    'listFsDirs',
    'getFsGitInfo',
]);
/** Actions whose side effect targets the caller's desktop rather than the remote workspace. */
const WORKSPACE_LOCAL_ACTION_METHODS = new Set([
    'openWorkspaceApp',
    'listIdeApps',
    'openWorkspaceFile',
    'revealWorkspaceFile',
    'openWorkspaceFileInIde',
]);
/** Permission and AskUser request/response routes. */
const INTERACTION_METHODS = new Set([
    'beginQuestionnaire',
    'replyQuestionnaire',
    'dismissQuestionnaire',
    'getPendingQuestionnaire',
    'getQuestionnaire',
    'getLatestPlanReview',
    'getPermissionMode',
    'setPermissionMode',
    'replyPermission',
    'replyQuestion',
    'rejectQuestion',
    'listPendingPermissions',
    'dismissPermission',
    'batchReplyPermissions',
]);
/**
 * Inspector 读取面与设置。挂载条件是宿主真的组装了 Inspector service，因此不会
 * 在不支持该能力的构建上暴露路由。
 */
const LLM_CONTEXT_INSPECTOR_METHODS = new Set([
    'getLlmContextCapture',
    'putLlmContextCapture',
    'getLlmContextSessions',
    'getSessionLlmContextOverview',
    'getSessionLlmContextCall',
    'clearSessionLlmContextHistory',
]);
const SANDBOX_METHODS = new Set([
    'getSandboxStatus',
    'putSandboxConfig',
    'getSandboxViolations',
]);
/** Proposal §7.1: the 15 generated channel methods move as one group. */
const CHANNEL_OWNER_METHODS = new Set([
    'listChannelBindings',
    'listChannelConnections',
    'prepareChannelConnection',
    'disconnectChannelConnection',
    'deleteChannelConnection',
    'cancelChannelAuthorization',
    'unbindChannel',
    'updateChannelBindingTarget',
    'bindTelegram',
    'startWechatBind',
    'getWechatBindStatus',
    'bindFeishu',
    'startLarkOnboard',
    'getLarkOnboardStatus',
    'cancelLarkOnboard',
]);
/** Memory V2 管理面（memory-v2-design.md §5.15）；仅在装配出 memoryV2 application 时接管。 */
const MEMORY_V2_METHODS = new Set([
    'getMemoryV2Status',
    'listMemoryV2Sessions',
    'getMemoryV2SessionDoc',
    'forgetMemoryV2Content',
    'resetMemoryV2Scope',
    'prepareLegacyMemoryMigration',
    'acceptLegacyMemoryMigration',
    'discardLegacyMemoryMigration',
    'getMemoryV2Onboarding',
    'completeMemoryV2Onboarding',
]);
const GOAL_OWNER_METHODS = new Set([
    'createGoal',
    'getGoal',
    'patchGoal',
    'deleteGoal',
    'dismissGoal',
]);
const OWNER_METHOD_GROUPS = {
    agent: AGENT_OWNER_METHODS,
    canvas: CANVAS_OWNER_METHODS,
    globalEvents: GLOBAL_EVENTS_METHODS,
    cron: CRON_OWNER_METHODS,
    modelProvider: MODEL_PROVIDER_METHODS,
    session: SESSION_TURN_METHODS,
    plugin: PLUGIN_SERVICE_METHODS,
    workspaceGit: WORKSPACE_GIT_METHODS,
    workspaceFile: WORKSPACE_FILE_METHODS,
    workspaceLocalActions: WORKSPACE_LOCAL_ACTION_METHODS,
    workspaceIndexing: WORKSPACE_INDEXING_METHODS,
    interaction: INTERACTION_METHODS,
    llmContextInspector: LLM_CONTEXT_INSPECTOR_METHODS,
    preference: PREFERENCE_OWNER_METHODS,
    agentShell: new Set(['getAgentShellStatus', 'putAgentShellPreference']),
    sandbox: SANDBOX_METHODS,
    globalInstructions: GLOBAL_INSTRUCTIONS_METHODS,
    channel: CHANNEL_OWNER_METHODS,
    memoryV2: MEMORY_V2_METHODS,
    goal: GOAL_OWNER_METHODS,
};
/** Worktree routes are always owned by the V2 front door and never fall through. */
const WORKTREE_METHODS = new Set([
    'listManagedWorkspaceGitWorktrees',
    'removeManagedWorkspaceGitWorktree',
    'removeManagedWorkspaceGitWorktreesBatch',
]);
const MCP_METHODS = new Set([
    'listLocalMcpServers',
    'getLocalMcpServer',
    'createLocalMcpServer',
    'updateLocalMcpServer',
    'deleteLocalMcpServer',
    'setLocalMcpServerEnabled',
    'testLocalMcpServer',
    'listLocalMcpRuntimeServers',
    'getLocalMcpRuntimeServer',
    'upsertLocalMcpRuntimeServer',
    'disableLocalMcpRuntimeServer',
    'listLocalMcpRuntimeTools',
    'getLocalMcpRuntimeTool',
    'listLocalMcpRuntimeNativeTools',
    'getLocalMcpRuntimeAuthStatus',
    'startLocalMcpRuntimeAuth',
    'syncLocalMcpRuntimeServers',
    'getLocalMcpRuntimeSyncStatus',
    'callLocalMcpRuntimeTool',
]);
/** User/project hooks.json settings have no v1 owner; absent services answer 503. */
const HOOK_METHODS = new Set([
    'listLocalHooks',
    'createLocalHook',
    'updateLocalHook',
    'deleteLocalHook',
    'setLocalHookEnabled',
    'setLocalHookScopeEnabled',
]);
/**
 * 只有生产组装提供完整 Application 依赖图时，Session/Application 路由才会启用。
 * 该能力与 Cron/event owner 分开判断，避免依赖不完整的 host 在此次整体切换中声明这些方法。
 */
const SESSION_APPLICATION_METHODS = new Set([
    'pinAgent',
    'pinSession',
    'listBackgroundTasks',
    'getBackgroundTask',
    'readBackgroundTaskOutput',
    'stopBackgroundTask',
    'deleteBackgroundTask',
    'getPinnedItemsOrder',
    'putPinnedItemsOrder',
    'getRootSession',
    'replaceRootSession',
    'listSessions',
    'createSession',
    'getSidebarSessionTree',
    'getSessionTree',
    'searchSessions',
    'getSession',
    'updateSession',
    'getSessionUsage',
    'getPeekContext',
    'getSessionDiff',
    'deleteSession',
    'archiveSession',
    'compressSession',
    'getMessages',
    'listQueueMessages',
    'getQueueItem',
    'enqueueMessage',
    'updateQueueItem',
    'reorderQueue',
    'deleteQueueItem',
    'getTurnDiff',
    'revertTurnDiff',
    'reapplyTurnDiff',
    'listSessionFiles',
    'listSessionSourceHistory',
    'getSessionSourceDetail',
    'querySidebarProjects',
    'querySidebarProjectSessions',
    'querySidebarAgents',
    'getSidebarSession',
    'listProjects',
    'listProjectSessions',
    'setProjectPinned',
    'setProjectHidden',
    'putProjectsOrder',
    'archiveProjectSessions',
    'listRecentProjects',
    'touchRecentProject',
    'approveLocalSessionHandoff',
    'getSessionHandoffSummary',
    'getLocalSessionHandoffEligibility',
    'downloadSessionResult',
    'overwriteSessionResult',
]);
const SESSION_APPLICATION_MUTATION_METHODS = new Set([
    'createSideChat',
    'createSideChatFromQueue',
    'promoteSideChat',
    'getSessionForkOptions',
    'forkSession',
    'getSessionRewindPreview',
    'rewindSession',
    'editSessionMessage',
]);
/**
 * 已下线的 v1 Cron 契约仍存在于生成代码中。Cron service 挂载这些方法，交给
 * v2 控制器返回稳定的 CRON_LEGACY_UNSUPPORTED，阻止请求回落到旧表入口。
 */
const RETIRED_CRON_METHODS = new Set([
    'listCrons',
    'listCronSessions',
    'createCron',
    'triggerCron',
    'updateCron',
    'deleteCron',
]);
export function migratedMethodsForHost(hasOwnerServices, hasSessionApplications = false) {
    // 每个 host 都挂载始终可用的探针和 worktree 路由；缺失 facade 时明确返回 503。
    const migrated = new Set([
        ...ALWAYS_MOUNTED_METHODS,
        ...WORKTREE_METHODS,
        ...MCP_METHODS,
        ...HOOK_METHODS,
    ]);
    if (typeof hasOwnerServices === 'boolean') {
        if (!hasOwnerServices)
            return migrated;
        addOwnerMethods(migrated, OWNER_METHOD_GROUPS, true);
        addIf(migrated, true, RETIRED_CRON_METHODS);
        addIf(migrated, hasSessionApplications, SESSION_APPLICATION_METHODS);
        addIf(migrated, hasSessionApplications, SESSION_APPLICATION_MUTATION_METHODS);
        return migrated;
    }
    addOwnerMethods(migrated, OWNER_METHOD_GROUPS, hasOwnerServices);
    if (hasOwnerServices.cron)
        addIf(migrated, true, RETIRED_CRON_METHODS);
    addIf(migrated, hasOwnerServices.sessionApplications, SESSION_APPLICATION_METHODS);
    addIf(migrated, hasOwnerServices.sessionApplications, SESSION_APPLICATION_MUTATION_METHODS);
    return migrated;
}
function addOwnerMethods(target, groups, capabilities) {
    for (const capability of Object.keys(groups)) {
        const enabled = capabilities === true || capabilities[capability] === true;
        addIf(target, enabled, groups[capability]);
    }
}
function addIf(target, enabled, source) {
    if (!enabled)
        return;
    for (const method of source)
        target.add(method);
}
export function filterBindings(bindings, migrated) {
    return bindings.filter((b) => migrated.has(b.name));
}
//# sourceMappingURL=allowlist.js.map