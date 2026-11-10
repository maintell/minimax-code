import { AgentServiceError } from '../../../agent/errors.js';
/**
 * True only when the error is an `AgentServiceError` carrying the stable
 * `AGENT_NOT_FOUND` code. Other `AgentServiceError` codes, Session-level
 * errors, plain Errors, and any wrapped error keep failing the sweep.
 */
export function isAgentNotFoundError(error) {
    return error instanceof AgentServiceError && error.code === 'AGENT_NOT_FOUND';
}
export function reportDeletedAgentBackfillSkip(session, diagnostics) {
    // Telemetry delivery MUST stay best-effort here. The capture layer has
    // already decided this is a deleted-Agent skip and the sweep must continue.
    try {
        diagnostics?.reportAgentDefinitionSkip({
            code: 'AGENT_NOT_FOUND',
            reason: 'startup-backfill-deleted-agent-skip',
            sessionId: session.sessionId,
            agentName: session.agentName,
            status: session.status,
            sessionKind: session.sessionKind,
        });
    }
    catch (sinkError) {
        // A failing logger or network sink cannot re-escalate the skipped row.
        void sinkError;
    }
}
//# sourceMappingURL=backfill-diagnostics.js.map