import { randomUUID } from 'node:crypto';
import { DesktopAgentToolError, mapToolError } from '../sidebar-tools/index.js';
/**
 * Backs `session_fork` and `session_wait`.
 *
 * Forking reuses the same conversation-mutation workflow the UI's own fork
 * entry uses, so a fork created by an Agent is indistinguishable from one the
 * user created. Waiting only observes the live global event stream: it never
 * starts, steers or stops a Turn.
 */
/** The events that end a wait for one watched chat. */
const WAIT_EVENT_KINDS = new Set([
    'session.finish',
    'session.error',
    'session.abort',
    'permission.ask',
    'questionnaire.ask',
]);
export class DesktopSessionToolsService {
    options;
    constructor(options) {
        this.options = options;
    }
    async getForkOptions(req) {
        try {
            const result = await this.options.applications.conversation.getSessionForkOptions({
                id: req.sessionId,
                ...(req.assistantMessageId !== undefined
                    ? { assistantMessageId: req.assistantMessageId }
                    : {}),
            });
            return {
                can_fork: result.canFork === true,
                ...(result.unavailableReason ? { unavailable_reason: result.unavailableReason } : {}),
                ...(result.resolvedAssistantMessageId
                    ? { resolved_assistant_message_id: result.resolvedAssistantMessageId }
                    : {}),
                ...(result.suggestedTitle ? { suggested_title: result.suggestedTitle } : {}),
            };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to read the fork options.');
        }
    }
    async forkSession(req) {
        try {
            const result = await this.options.applications.conversation.forkSession({
                id: req.sessionId,
                ...(req.assistantMessageId !== undefined
                    ? { assistantMessageId: req.assistantMessageId }
                    : {}),
                clientRequestId: this.newRequestId(),
                useSuggestedTitle: req.title === undefined,
                createIsolatedWorktree: false,
                ...(req.title !== undefined ? { title: req.title } : {}),
            });
            const sessionId = result.session?.sessionId;
            if (!sessionId) {
                throw new DesktopAgentToolError('INTERNAL', 'The fork produced no conversation.');
            }
            return {
                session_id: sessionId,
                ...(result.session?.title ? { title: result.session.title } : {}),
                ...(result.forkOriginMessageId
                    ? { fork_origin_message_id: result.forkOriginMessageId }
                    : {}),
            };
        }
        catch (error) {
            throw mapToolError(error, 'Failed to fork the conversation.');
        }
    }
    async waitForSessions(req) {
        const watching = new Set(req.sessionIds);
        const outcomes = [];
        const seen = new Set();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), req.timeoutMs);
        try {
            await this.collect(watching, outcomes, seen, controller.signal);
        }
        finally {
            clearTimeout(timer);
        }
        const reported = new Set(outcomes.map((outcome) => outcome.session_id));
        return {
            timed_out: outcomes.length === 0,
            outcomes,
            pending_session_ids: [...watching].filter((id) => !reported.has(id)),
        };
    }
    /** Drains the live stream until every watched chat reported, or the wait ended. */
    collect(watching, outcomes, seen, signal) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                unsubscribe();
                signal.removeEventListener('abort', finish);
                resolve();
            };
            const unsubscribe = this.options.subscribeGlobalEvents((event) => {
                const outcome = toWaitOutcome(event, watching);
                if (!outcome || seen.has(outcome.session_id))
                    return;
                seen.add(outcome.session_id);
                outcomes.push(outcome);
                // The wait is a "tell me as soon as something happens" call: the first
                // event per chat is enough, and one event overall ends the wait.
                finish();
            });
            signal.addEventListener('abort', finish, { once: true });
            if (signal.aborted)
                finish();
        });
    }
    newRequestId() {
        return this.options.newRequestId?.() ?? randomUUID();
    }
}
/** Only the five wait-worthy events for a watched chat become an outcome. */
function toWaitOutcome(event, watching) {
    if (!WAIT_EVENT_KINDS.has(event.type))
        return undefined;
    const payload = event.payload;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
    if (!sessionId || !watching.has(sessionId))
        return undefined;
    return {
        session_id: sessionId,
        event: event.type,
        ...(typeof payload.turnId === 'string' ? { turn_id: payload.turnId } : {}),
        ...(typeof payload.error === 'string' ? { detail: payload.error } : {}),
    };
}
//# sourceMappingURL=session-tools-service.js.map