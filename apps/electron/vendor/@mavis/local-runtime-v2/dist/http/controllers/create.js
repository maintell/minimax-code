import { AgentShellController } from './agent-shell.controller.js';
import { BackgroundTaskController } from './background-task.controller.js';
import { SkillEvolveController, } from './skill-evolve.controller.js';
import { SandboxControllerBase } from '../generated/sandbox-controller-base.gen.js';
import { AgentShellControllerBase } from '../generated/agent-shell-controller-base.gen.js';
import { WebsiteControllerBase } from '../generated/website-controller-base.gen.js';
import { LlmContextInspectorController } from './llm-context-inspector.controller.js';
import { agentController, createAgentController } from './agent.controller.js';
import { CanvasController } from './canvas.controller.js';
import { channelController, createChannelController } from './channel.controller.js';
import { createCronController } from './cron.controller.js';
import { demoController } from './demo.controller.js';
import { createEventsController } from './events.controller.js';
import { GoalController, goalController } from './goal.controller.js';
import { MemoryController } from './memory.controller.js';
import { createMcpController } from './mcp.controller.js';
import { createHookController } from './hook.controller.js';
import { createModelProviderController, modelProviderController, } from './model-provider.controller.js';
import { createPermissionController, permissionController } from './permission.controller.js';
import { PinController } from './pin.controller.js';
import { PreferenceController, } from './preference.controller.js';
import { PluginController, pluginController, } from './plugin.controller.js';
import { ProjectController } from './project.controller.js';
import { createQuestionnaireController, questionnaireController, } from './questionnaire.controller.js';
import { reviewController } from './review.controller.js';
import { SandboxController } from './sandbox.controller.js';
import { createSessionController, sessionController, } from './session.controller.js';
import { SessionDispatchController } from './session-dispatch.controller.js';
import { SkillController, skillController, } from './skill.controller.js';
import { createWorkspaceFileController, workspaceFileController, } from './workspace-file.controller.js';
import { WorkspaceIndexingController } from './workspace-indexing.controller.js';
const CLOSED_GLOBAL_EVENTS = {
    subscribe: (subscriber) => {
        subscriber.complete?.();
        return () => undefined;
    },
};
const websiteController = new WebsiteControllerBase();
const sandboxController = new SandboxControllerBase();
/**
 * 根据具名服务创建 HTTP 适配器，并装配生成的 `DesktopControllers` 映射。
 * `DesktopControllers` 负责通过类型检查保证完整性，具体控制器仍在 HTTP 层构造。
 */
export function createControllers(services) {
    return {
        demo: demoController,
        agentShell: services.agentShell
            ? new AgentShellController(services.agentShell)
            : new AgentShellControllerBase(),
        canvas: new CanvasController(services.canvas),
        events: createEventsController(services.globalEvents ?? CLOSED_GLOBAL_EVENTS),
        plugin: createPluginAdapter(services),
        mcp: createMcpController(services.mcp, services.mcpRuntime),
        hook: createHookController(services.hookConfig),
        modelProvider: createModelProviderAdapter(services),
        agent: createAgentAdapter(services),
        pin: new PinController(services.applications),
        backgroundTask: new BackgroundTaskController(services.applications),
        preference: createPreferenceAdapter(services),
        workspaceIndexing: createWorkspaceIndexingAdapter(services),
        cron: createCronAdapter(services),
        goal: services.goal ? new GoalController(services.goal) : goalController,
        channel: services.channelSystem
            ? createChannelController(services.channelSystem.legacyHttp)
            : channelController,
        questionnaire: createQuestionnaireAdapter(services),
        review: reviewController,
        skill: createSkillAdapter(services),
        skillEvolve: new SkillEvolveController(services.skillEvolve),
        project: new ProjectController(services.applications),
        session: createSessionAdapter(services),
        sandbox: services.sandbox ? new SandboxController(services.sandbox) : sandboxController,
        sessionDispatch: new SessionDispatchController(services.applications),
        memory: new MemoryController(services.memoryV2),
        permission: createPermissionAdapter(services),
        website: websiteController,
        llmContextInspector: new LlmContextInspectorController(services.llmContextInspector),
        workspaceFile: createWorkspaceFileAdapter(services),
    };
}
function createPluginAdapter(services) {
    return services.plugin ? new PluginController(services.plugin) : pluginController;
}
function createModelProviderAdapter(services) {
    return services.modelProvider
        ? createModelProviderController(services.modelProvider)
        : modelProviderController;
}
function createAgentAdapter(services) {
    return services.agent ? createAgentController(services.agent) : agentController;
}
function createPreferenceAdapter(services) {
    return new PreferenceController({
        globalInstructions: services.globalInstructions,
        workspaceIndexing: services.workspace?.indexing,
        composerSendBehavior: services.composerSendBehavior,
        composerEnterBehavior: services.composerEnterBehavior,
        computerUseDefaultPreference: services.computerUseDefaultPreference,
    });
}
function createWorkspaceIndexingAdapter(services) {
    return new WorkspaceIndexingController(services.workspace?.indexing);
}
function createCronAdapter(services) {
    const agent = services.agent;
    return createCronController(services.cron, {
        disabledLegacyCronCount: services.disabledLegacyScheduleCount,
        ...(agent
            ? {
                resolveAgentWriteTarget: (requestRef) => agent.resolveAgentWriteTarget(requestRef),
            }
            : {}),
    });
}
function createQuestionnaireAdapter(services) {
    const facade = services.application?.questionnaires;
    return facade ? createQuestionnaireController(facade) : questionnaireController;
}
function createSkillAdapter(services) {
    return services.skill ? new SkillController(services.skill) : skillController;
}
function createPermissionAdapter(services) {
    const facade = services.application?.permissions;
    const configuration = services.application?.configuration;
    return facade || configuration
        ? createPermissionController(facade, configuration)
        : permissionController;
}
function createWorkspaceFileAdapter(services) {
    if (!hasWorkspaceFileServices(services)) {
        return workspaceFileController;
    }
    // Once the V2 Workspace Git service is composed, its worktree operations
    // are the single owner. Keep the legacy facade only for compatibility-only
    // test/host compositions that have no V2 Git owner.
    const useV2WorktreeOwner = Boolean(services.workspace?.git && services.workspace?.file);
    return createWorkspaceFileController({
        ...(!useV2WorktreeOwner && services.managedWorktrees
            ? { managedWorktrees: services.managedWorktrees }
            : {}),
        ...(services.workspace?.git ? { workspaceGit: services.workspace.git } : {}),
        ...(services.workspace?.file ? { workspaceFile: services.workspace.file } : {}),
        ...(services.workspace?.localActions
            ? { workspaceLocalActions: services.workspace.localActions }
            : {}),
    });
}
function hasWorkspaceFileServices(services) {
    return [
        services.managedWorktrees,
        services.workspace?.git,
        services.workspace?.file,
        services.workspace?.localActions,
    ].some(Boolean);
}
function createSessionAdapter(services) {
    if (!services.applications && !services.cronDelivery && !services.conversation) {
        return sessionController;
    }
    return createSessionController({
        ...(services.applications ? { applications: services.applications } : {}),
        ...(services.cronDelivery ? { cronDelivery: services.cronDelivery } : {}),
        ...(services.conversation ? { conversation: services.conversation } : {}),
    });
}
//# sourceMappingURL=create.js.map