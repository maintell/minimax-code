import { projectAgentReferencesForModel, } from '@mavis/shared/agent-mention';
const TASK_CHILD_PURPOSE_PREFIXES = [
    'local-task:',
    'local-background-task:',
    'team-plan:',
];
export function resolveAgentPromptSurface(session, runtimeOwnerKind) {
    const taskChild = session.sessionKind === 'task' ||
        (session.sessionType === 'branch' &&
            Boolean(session.parentSessionId) &&
            session.visibility === 'hidden' &&
            TASK_CHILD_PURPOSE_PREFIXES.some((prefix) => session.purpose?.startsWith(prefix)));
    if (taskChild)
        return 'task-child';
    return runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui' ? 'cli' : 'interactive';
}
export async function projectLocalAgentReferencesForModel(input) {
    const surface = resolveAgentMentionSurface(input.agentConfig);
    const result = await projectAgentReferencesForModel(input.content, {
        surface,
        resolveAgentReference: input.projection.resolveAgentReference,
    });
    // A no-mention turn is intentionally silent. Projection telemetry is
    // useful for a real protocol outcome, but logging one success per normal
    // user turn would create high-volume noise without diagnostic value.
    if (result.projectedCount > 0) {
        input.projection.emitDiagnostic?.({
            stage: 'llm_projection',
            outcome: 'success',
            count: result.projectedCount,
            surface,
            runtime: 'desktop',
        });
    }
    const errorCounts = new Map();
    for (const errorCode of result.errorCodes) {
        errorCounts.set(errorCode, (errorCounts.get(errorCode) ?? 0) + 1);
    }
    for (const [errorCode, count] of errorCounts) {
        input.projection.emitDiagnostic?.({
            stage: 'llm_projection',
            outcome: 'failure',
            count,
            surface,
            runtime: 'desktop',
            errorCode,
        });
    }
    return result.content;
}
function resolveAgentMentionSurface(agentConfig) {
    const profile = agentConfig.agent_profile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile))
        return 'direct-subagent';
    const facts = profile;
    if (facts.surface === 'task-child')
        return 'task-child';
    return facts.surface === 'interactive' &&
        facts.trusted_builtin === true &&
        facts.canonical_view_name === 'mavis'
        ? 'main'
        : 'direct-subagent';
}
//# sourceMappingURL=agent-prompt-surface.js.map