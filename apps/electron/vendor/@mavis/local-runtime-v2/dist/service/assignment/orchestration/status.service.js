import { ROUND_INTERRUPTED_BY_RESTART } from '../../coordinator-text/index.js';
import {} from '../contracts.js';
import { stoppedByRestart, } from '../../session-system/index.js';
import { findSessionAncestor } from './session-ancestry.js';
export function createAssignmentFacts(options) {
    const latest = (id) => options.inspection?.latestTurnActivity?.(id);
    const background = options.backgroundTasks;
    return {
        async status(session) {
            const [pending, question, queued, turn] = await Promise.all([
                options.permissions.listPending(),
                options.questionnaires.getPending({
                    agentName: session.agentName,
                    sessionId: session.sessionId,
                    // A skipped question stays answerable but no longer waits for the user.
                    excludeSkipped: true,
                }),
                options.sessions.queue.repository.listPendingSessionIds(),
                latest(session.sessionId),
            ]);
            const permissions = await requestsOfTask(options, session.sessionId, pending);
            const active = applicableQuestion(session, question);
            const waitingDetail = waitingFor(permissions, active);
            // An async question asked by a turn that is still executing is a to-do, not a stop:
            // the task keeps running and the question is counted separately.
            const askedWhileRunning = active !== undefined && session.status === 'started' && active.responseMode === 'async';
            const state = stateFor(session, {
                queued: queued.includes(session.sessionId),
                permissions: permissions.length,
                question: active !== undefined && !askedWhileRunning,
                finishedTurn: turn?.completedAtMs !== undefined,
            });
            return {
                state,
                pendingPermissionCount: permissions.length,
                pendingQuestionCount: active ? 1 : 0,
                ...(waitingDetail ? { waitingDetail } : {}),
                ...(turn
                    ? {
                        turnStartedAt: turn.acceptedAtMs,
                        ...(turn.completedAtMs !== undefined ? { turnEndedAt: turn.completedAtMs } : {}),
                    }
                    : {}),
                ...errorOf(session),
            };
        },
        async lastTurn(id) {
            const [session, turn] = await Promise.all([
                options.sessions.repositories.sessions.get(id),
                latest(id),
            ]);
            if (!session || !turn || turn.completedAtMs === undefined)
                return undefined;
            return { turnId: turn.turnId, state: terminalState(session) };
        },
        ...(background
            ? {
                hasRunningBackgroundTask: async (sessionId) => (await background.list({ ownerSessionId: sessionId, statuses: ['running'], limit: 1 }))
                    .items.length > 0,
            }
            : {}),
        messages: (sessionId, turnId) => options.sessions.repositories.messages.listTurn(sessionId, turnId),
        async startedByUser(sessionId, turnId) {
            const source = await options.sessions.repositories.messages.resolveTurnSource(sessionId, turnId);
            return source?.source !== undefined && USER_TYPED_SOURCES.has(source.source);
        },
    };
}
/**
 * Approval requests the task waits on: its own and those of the subagent Sessions
 * under it at any depth, whose turns block the task's turn. A request whose
 * Session can no longer be read is not counted.
 */
async function requestsOfTask(options, taskSessionId, pending) {
    const belongs = await Promise.all(pending.map(async (item) => {
        if (item.sessionId === taskSessionId)
            return true;
        try {
            const owner = await findSessionAncestor((id) => options.sessions.repositories.sessions.get(id), item.sessionId, (candidate) => candidate.parentSessionId === taskSessionId);
            return owner !== undefined;
        }
        catch {
            return false;
        }
    }));
    return pending.filter((_, index) => belongs[index]);
}
/** Input the user typed or edited in the session itself, not sent by Bunny or the runtime. */
const USER_TYPED_SOURCES = new Set(['api', 'conversation-mutation', 'miniapp']);
/**
 * A round the app's restart cut off reads as a failed round: nobody stopped it,
 * and Bunny gets it back as one (R6.5). Every other stop is someone's.
 */
function terminalState(session) {
    if (session.status === 'error' || stoppedByRestart(session))
        return 'failed';
    if (session.status === 'aborted' || session.status === 'interrupted')
        return 'stopped';
    return 'completed';
}
function errorOf(session) {
    if (stoppedByRestart(session))
        return { errorMessage: ROUND_INTERRUPTED_BY_RESTART };
    return session.errorMessage ? { errorMessage: session.errorMessage } : {};
}
function stateFor(session, pending) {
    if (session.status === 'aborted' || session.status === 'interrupted')
        return terminalState(session);
    // A waiting or running turn outranks messages queued behind it.
    if (pending.permissions)
        return 'waiting_approval';
    if (pending.question)
        return 'waiting_answer';
    if (session.status === 'started')
        return 'running';
    if (pending.queued || (session.status === 'idle' && !pending.finishedTurn))
        return 'queued';
    return terminalState(session);
}
/**
 * getPending owns resolution and expiry (and leaves out skipped questions);
 * later turns do not invalidate unanswered questions.
 */
function applicableQuestion(session, question) {
    if (!question)
        return undefined;
    if (session.status === 'aborted' || session.status === 'interrupted')
        return undefined;
    return question;
}
function questionTitle(question) {
    const step = question.steps?.[0];
    return [question.title, question.presentation?.title, step?.header, step?.question]
        .map((value) => value?.trim())
        .find((value) => Boolean(value));
}
function waitingFor(permissions, question) {
    if (permissions.length)
        return permissions
            .map((item) => [item.toolName, item.reason].filter(Boolean).join(': '))
            .join('; ');
    return question ? questionTitle(question) : undefined;
}
//# sourceMappingURL=status.service.js.map