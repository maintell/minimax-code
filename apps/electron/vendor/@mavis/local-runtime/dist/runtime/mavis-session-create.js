import { ConversationTurnRejectedError } from '@mavis/conversation-contract';
import { sendToLocalSession } from './mavis-session-send.js';
const MODEL_ERROR_NAMES = new Set(['AgentModelSelectionError', 'LocalModelProviderError']);
const WORKSPACE_FAILURES = new Set(['workspace-required', 'run-location-invalid']);
/**
 * Creates a parallel visible Session, records who created it, then delivers the
 * first message through the same admission path as session send. An admission
 * failure keeps the Session and names it: the model tells the user, who deletes
 * it from the sidebar. A caller abort after admission is already reclaimed by
 * session send, so this path does not interrupt or delete.
 */
export async function createSessionWithFirstMessage(deps, req, signal) {
    throwIfAborted(signal);
    const created = await createParallelSession(deps, req);
    try {
        const admission = await sendToLocalSession(deps, {
            callerSessionId: req.callerSessionId,
            ...(req.callerTurnId ? { callerTurnId: req.callerTurnId } : {}),
            sessionId: created.sessionId,
            content: req.content,
        }, signal);
        return {
            sessionId: created.sessionId,
            agentName: created.agentName,
            turnId: admission.turnId,
            mode: admission.status === 'accepted' ? admission.mode : 'started',
        };
    }
    catch (error) {
        throw admissionFailed(created.sessionId, admissionReason(error));
    }
}
async function createParallelSession(deps, req) {
    try {
        return await deps.conversation.lifecycle.createSession({
            agentName: req.agentName,
            sessionKind: 'conversation',
            parentSessionId: null,
            visibility: 'visible',
            ...(req.title ? { title: req.title } : {}),
            ...(req.workspaceDir ? { workspaceDir: req.workspaceDir } : {}),
            ...(req.model ? { effectiveModel: req.model } : {}),
            createdBySessionId: req.callerSessionId,
        });
    }
    catch (error) {
        throw mapCreateError(error);
    }
}
function admissionReason(error) {
    if (error instanceof ConversationTurnRejectedError)
        return error.reason;
    // Session send maps a rejection into its own error. The original reason is
    // kept beside the mapped code so the failure reports the real cause.
    if (error instanceof Error &&
        'admissionReason' in error &&
        typeof error.admissionReason === 'string') {
        return error.admissionReason;
    }
    if (error instanceof Error && error.name === 'AbortError')
        return 'aborted';
    return 'unavailable';
}
function admissionFailed(sessionId, reason) {
    return Object.assign(new Error(`会话 ${sessionId} 已创建，但首条消息未能送达（${reason}）。会话保留在侧栏。请把这个结果告诉用户，不要自动重试。`), {
        status: reason === 'invalid-input' ? 400 : 500,
        code: 'SESSION_CREATE_ADMISSION_FAILED',
        reason,
        sessionId,
    });
}
/**
 * Create failures are classified by the error's own name and reason. Those are
 * stable across the lifecycle and model layers, and reading them here avoids a
 * dependency from the v1 runtime into the v2 service tree.
 */
function mapCreateError(error) {
    if (!(error instanceof Error))
        return error;
    const reason = 'reason' in error && typeof error.reason === 'string' ? error.reason : undefined;
    if (MODEL_ERROR_NAMES.has(error.name)) {
        return Object.assign(new Error(error.message), {
            status: 400,
            code: 'SESSION_CREATE_MODEL_UNRESOLVED',
        });
    }
    if (error.name === 'LocalRunLocationError' || (reason && WORKSPACE_FAILURES.has(reason))) {
        return Object.assign(new Error(error.message), {
            status: 400,
            code: 'SESSION_CREATE_INVALID_WORKSPACE',
        });
    }
    return error;
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    const error = new Error('Session create was aborted before the Session was created');
    error.name = 'AbortError';
    throw error;
}
//# sourceMappingURL=mavis-session-create.js.map