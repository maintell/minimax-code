import { createPluginAgentRoster } from '../../assembly/turn-capability-lifecycle.js';
import { emitLocalPluginHookWarnings } from '../../assembly/local-turn-plugin-hooks.js';
import { LIGHTWEIGHT_TOOL_CALL_FALLBACK } from '../prompt.js';
/**
 * Plugin Hook subagent lifecycle wiring for one Turn: the tool context the runtime
 * receives, the SubagentStart registration it builds, and the best-effort transcript
 * cleanup that must never fail the Turn.
 */
export function pluginToolContext(input, coordinator) {
    return {
        ...(input.pluginHooks?.length
            ? { pluginSubagentLifecycle: createPluginSubagentLifecycle(input, coordinator) }
            : {}),
        ...(input.desktopCapabilities?.agents?.length
            ? { pluginAgents: createPluginAgentRoster(input.desktopCapabilities.agents) }
            : {}),
    };
}
function createPluginSubagentLifecycle(input, coordinator) {
    return {
        start: (child, signal) => startPluginSubagent(input, child, coordinator, signal),
        cancel: (childSessionId) => coordinator.cancelSubagent(childSessionId),
    };
}
async function startPluginSubagent(input, child, coordinator, signal) {
    const decision = await coordinator.startSubagent(buildPluginSubagentRegistration(input, child), signal);
    await emitLocalPluginHookWarnings({
        reporter: input.pluginHookEventReporter,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        event: 'SubagentStart',
        decision,
    });
    if (decision.continue === false) {
        throw new Error(decision.stopReason ?? 'Subagent stopped by Plugin Hook.');
    }
    return decision.additionalContext;
}
function buildPluginSubagentRegistration(input, child) {
    const runtimeContext = input.pluginHookRuntimeContext;
    return {
        handlers: input.pluginHooks ?? [],
        parentSessionId: input.lease.sessionId,
        parentTurnId: input.lease.turnId,
        parentPromptId: runtimeContext?.promptId ?? input.lease.turnId,
        childSessionId: child.childSessionId,
        childTurnId: child.childTurnId,
        cwd: input.session.workspaceDir,
        ...(runtimeContext?.transcriptPath !== undefined
            ? { parentTranscriptPath: runtimeContext.transcriptPath }
            : {}),
        ...(runtimeContext?.codexTranscriptPath !== undefined
            ? { parentCodexTranscriptPath: runtimeContext.codexTranscriptPath }
            : {}),
        ...(runtimeContext?.model ? { model: runtimeContext.model } : {}),
        ...(runtimeContext?.permissionMode ? { permissionMode: runtimeContext.permissionMode } : {}),
        ...(runtimeContext?.effort ? { effort: runtimeContext.effort } : {}),
        agentId: resolvePluginSubagentAgentId(child),
        agentType: child.agentType,
        ...(child.agentTranscriptPath ? { agentTranscriptPath: child.agentTranscriptPath } : {}),
        ...(child.agentCodexTranscriptPath
            ? { agentCodexTranscriptPath: child.agentCodexTranscriptPath }
            : {}),
    };
}
export function resolvePluginHookSessionOwnershipClaim(prepareOwnership, leaseId) {
    return prepareOwnership ? leaseId : undefined;
}
function resolvePluginSubagentAgentId(child) {
    return child.agentId ?? child.childSessionId;
}
export async function cleanupPluginHookTranscriptBestEffort(cleanup) {
    if (!cleanup)
        return;
    try {
        await cleanup();
    }
    catch {
        // Ownership preparation failed before the transcript could be attached.
    }
}
export function pluginHookTranscriptCleanup(writer) {
    return writer ? () => writer.cleanup() : undefined;
}
export const lightweightToolCallFallback = (lightweightMode) => lightweightMode ? { unexpectedToolCallFallback: LIGHTWEIGHT_TOOL_CALL_FALLBACK } : {};
//# sourceMappingURL=plugin-subagent-lifecycle.js.map