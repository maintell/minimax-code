import { HTTPException } from 'hono/http-exception';
import { DesktopHookServiceBase } from './desktop-hook-service-base.js';
import { CronContractError } from '../../service/cron/index.js'; // desktop-service-boundary-skip: anchor=server-cron-contract owner=cron reason=legacy-cron-rpc-glue-before-facade; followup=desktop-service-domain-facades
import { jsonError } from './desktop-service-support.js';
/**
 * v1 宿主不持有 Cron v2。共享生成契约中的 Cron v2 定义和运行方法由
 * local-runtime-v2 前门提供；旧链路返回稳定的不支持错误，避免打开第二个
 * Cron 写入端。
 */
function cronV2Unsupported(method) {
    return new HTTPException(501, {
        res: jsonError(501, `Cron v2 method ${method} is not supported on this runtime host. ` +
            'Use a Desktop host with the Cron scheduler. Do not retry on this host.', 'CRON_V2_UNSUPPORTED_ON_LEGACY_HOST'),
    });
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
/** Preserves stable unavailable responses for methods owned by the V2 front door. */
export class DesktopUnavailableServiceBase extends DesktopHookServiceBase {
    // 后台任务、Session 活动、下一句建议、权限模式与 Goal 都由 local-runtime-v2
    // 前门持有；旧链路保持 fail closed，不再长出第二个 owner。
    async listBackgroundTasks() {
        throw new Error('Background task API requires Runtime V2');
    }
    async getBackgroundTask() {
        throw new Error('Background task API requires Runtime V2');
    }
    async readBackgroundTaskOutput() {
        throw new Error('Background task API requires Runtime V2');
    }
    async stopBackgroundTask() {
        throw new Error('Background task API requires Runtime V2');
    }
    async deleteBackgroundTask() {
        throw new Error('Background task API requires Runtime V2');
    }
    async getSessionActivity() {
        throw new HTTPException(501, {
            res: jsonError(501, 'Session activity requires local-runtime-v2.', 'SESSION_ACTIVITY_UNSUPPORTED'),
        });
    }
    cancelPromptSuggestion = () => this.unimplementedGeneratedMethod('CancelPromptSuggestion');
    getPromptSuggestion = () => this.unimplementedGeneratedMethod('GetPromptSuggestion');
    getPermissionMode(_ctx, _req) {
        return this.unimplementedGeneratedMethod('getPermissionMode');
    }
    setPermissionMode(_ctx, _req) {
        return this.unimplementedGeneratedMethod('setPermissionMode');
    }
    createGoal = () => this.unimplementedGeneratedMethod('createGoal');
    getGoal = () => this.unimplementedGeneratedMethod('getGoal');
    patchGoal = () => this.unimplementedGeneratedMethod('patchGoal');
    deleteGoal = () => this.unimplementedGeneratedMethod('deleteGoal');
    dismissGoal = () => this.unimplementedGeneratedMethod('dismissGoal');
    async readCanvas(_ctx, _req) {
        return this.unimplementedGeneratedMethod('readCanvas');
    }
    async prepareCanvasFiles(_ctx, _req) {
        return this.unimplementedGeneratedMethod('prepareCanvasFiles');
    }
    async applyCanvasOperation(_ctx, _req) {
        return this.unimplementedGeneratedMethod('applyCanvasOperation');
    }
    async removeCanvasImageBackground(_ctx, _req) {
        return this.unimplementedGeneratedMethod('removeCanvasImageBackground');
    }
    async enhanceCanvasImage(_ctx, _req) {
        return this.unimplementedGeneratedMethod('enhanceCanvasImage');
    }
    async recordPluginRecommendationDecline(_ctx, _req) {
        return this.unimplementedGeneratedMethod('recordPluginRecommendationDecline');
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
    createProject(..._args) {
        return this.unimplementedGeneratedMethod('CreateProject');
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
    // Work Share is composed by the v2 front door (!8314); this host keeps it fail closed.
    packShareWork(..._args) {
        return this.unimplementedGeneratedMethod('PackShareWork');
    }
    publishShareWork(..._args) {
        return this.unimplementedGeneratedMethod('PublishShareWork');
    }
    prepareSharedInstall(..._args) {
        return this.unimplementedGeneratedMethod('PrepareSharedInstall');
    }
    commitSharedInstall(..._args) {
        return this.unimplementedGeneratedMethod('CommitSharedInstall');
    }
    discardSharedInstall(..._args) {
        return this.unimplementedGeneratedMethod('DiscardSharedInstall');
    }
    listShareInstallations(..._args) {
        return this.unimplementedGeneratedMethod('ListShareInstallations');
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
    updatePlugin(..._args) {
        return this.unimplementedGeneratedMethod('UpdatePlugin');
    }
    listPluginMarketplaces(..._args) {
        return this.unimplementedGeneratedMethod('ListPluginMarketplaces');
    }
    addPluginMarketplace(..._args) {
        return this.unimplementedGeneratedMethod('AddPluginMarketplace');
    }
    refreshPluginMarketplaces(..._args) {
        return this.unimplementedGeneratedMethod('RefreshPluginMarketplaces');
    }
    setPluginMarketplaceAutoUpdate(..._args) {
        return this.unimplementedGeneratedMethod('SetPluginMarketplaceAutoUpdate');
    }
    removePluginMarketplace(..._args) {
        return this.unimplementedGeneratedMethod('RemovePluginMarketplace');
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
    getComputerUseDefaultPreference(..._args) {
        return this.unimplementedGeneratedMethod('getComputerUseDefaultPreference');
    }
    putComputerUseDefaultPreference(..._args) {
        return this.unimplementedGeneratedMethod('putComputerUseDefaultPreference');
    }
    prewarmWorkspaceIndexing(ctx, req) {
        void ctx;
        void req;
        return this.unimplementedGeneratedMethod('prewarmWorkspaceIndexing');
    }
    // BYOK provider presets are served by Local Runtime v2. Legacy-only hosts
    // expose the generated route and fail closed instead of shipping a second
    // preset catalogue that could drift from the v2 owner.
    listByokProviderPresets(..._args) {
        return this.unimplementedGeneratedMethod('ListByokProviderPresets');
    }
    revealModelProviderApiKey(..._args) {
        return this.unimplementedGeneratedMethod('RevealModelProviderApiKey');
    }
    // SideChat 仅由 Local Runtime v2 实现；旧 host 保持 fail closed。
    createSideChat(..._args) {
        return this.unimplementedGeneratedMethod('CreateSideChat');
    }
    createSideChatFromQueue(..._args) {
        return this.unimplementedGeneratedMethod('CreateSideChatFromQueue');
    }
    promoteSideChat(..._args) {
        return this.unimplementedGeneratedMethod('PromoteSideChat');
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
    // Session file cloud sync records are owned by Local Runtime v2. Until the v2
    // implementation lands, the generated routes stay fail closed with 501.
    getSessionFileSyncs = () => this.unimplementedGeneratedMethod('getSessionFileSyncs');
    recordSessionFileSync = () => this.unimplementedGeneratedMethod('recordSessionFileSync');
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
    getMemoryV2Onboarding(_ctx, _req) {
        return this.unimplementedGeneratedMethod('GetMemoryV2Onboarding');
    }
    completeMemoryV2Onboarding(_ctx, _req) {
        return this.unimplementedGeneratedMethod('CompleteMemoryV2Onboarding');
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
    unimplementedGeneratedMethod(method) {
        throw new HTTPException(501, {
            res: jsonError(501, `DesktopService.${method} is not implemented by local-runtime.`, 'NOT_IMPLEMENTED'),
        });
    }
}
//# sourceMappingURL=desktop-unavailable-service.js.map