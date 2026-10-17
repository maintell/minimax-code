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
import { goalController } from './goal.controller.js';
import { MemoryController } from './memory.controller.js';
import { createMcpController } from './mcp.controller.js';
import { createModelProviderController, modelProviderController, } from './model-provider.controller.js';
import { permissionController } from './permission.controller.js';
import { PinController } from './pin.controller.js';
import { PreferenceController, } from './preference.controller.js';
import { PluginController, pluginController, } from './plugin.controller.js';
import { ProjectController } from './project.controller.js';
import { questionnaireController } from './questionnaire.controller.js';
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
    const agent = services.agent;
    return {
        demo: demoController,
        agentShell: new AgentShellControllerBase(),
        canvas: new CanvasController(services.canvas),
        events: createEventsController(services.globalEvents ?? CLOSED_GLOBAL_EVENTS),
        plugin: services.plugin ? new PluginController(services.plugin) : pluginController,
        mcp: createMcpController(services.mcp, services.mcpRuntime),
        modelProvider: services.modelProvider
            ? createModelProviderController(services.modelProvider)
            : modelProviderController,
        agent: agent ? createAgentController(agent) : agentController,
        pin: new PinController(services.applications),
        preference: new PreferenceController(services.globalInstructions, services.workspace?.indexing, services.composerSendBehavior, services.composerEnterBehavior),
        workspaceIndexing: new WorkspaceIndexingController(services.workspace?.indexing),
        cron: createCronController(services.cron, {
            disabledLegacyCronCount: services.disabledLegacyScheduleCount,
            ...(agent
                ? {
                    resolveAgentWriteTarget: (requestRef) => agent.resolveAgentWriteTarget(requestRef),
                }
                : {}),
        }),
        goal: goalController,
        channel: services.channelSystem
            ? createChannelController(services.channelSystem.legacyHttp)
            : channelController,
        questionnaire: questionnaireController,
        review: reviewController,
        skillEvolve: new SkillEvolveController(services.skillEvolve),
        skill: services.skill ? new SkillController(services.skill) : skillController,
        project: new ProjectController(services.applications),
        session: createSessionAdapter(services),
        sandbox: services.sandbox ? new SandboxController(services.sandbox) : sandboxController,
        sessionDispatch: new SessionDispatchController(services.applications),
        memory: new MemoryController(services.memoryV2),
        permission: permissionController,
        website: websiteController,
        llmContextInspector: new LlmContextInspectorController(services.llmContextInspector),
        workspaceFile: createWorkspaceFileAdapter(services),
    };
}
function createWorkspaceFileAdapter(services) {
    if (!services.managedWorktrees && !services.workspace?.git)
        return workspaceFileController;
    return createWorkspaceFileController({
        ...(services.managedWorktrees ? { managedWorktrees: services.managedWorktrees } : {}),
        ...(services.workspace?.git ? { workspaceGit: services.workspace.git } : {}),
    });
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