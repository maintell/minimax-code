import { Type } from '@sinclair/typebox';
import { callerSessionId, invalidArgument, namespacedTool, uiRequestTool, } from './desktop-tool-factory.js';
/**
 * The `session.manage` and `session.dispatch` tools this stage adds: open a
 * chat in the UI, fork one, and wait for other chats to reach a state worth
 * reporting. Every capability already exists; the tools add no new product
 * behaviour.
 */
/** `session_wait` watches a bounded set of chats so one wait stays cheap. */
const MAX_WAIT_SESSIONS = 8;
/** Long enough for a normal turn, short enough to stay inside one program. */
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 600_000;
export const SessionOpenToolDef = {
    name: 'session_open',
    namespace: 'session.manage',
    description: 'Bring one conversation to the front in the desktop app, exactly as clicking it in the sidebar ' +
        'would. Use it when the user asks to see, show or go to a chat.',
    schema: Type.Object({
        session: Type.String({
            minLength: 1,
            description: 'Session id, from session_list or sidebar_read.',
        }),
    }),
};
export const SessionForkToolDef = {
    name: 'session_fork',
    namespace: 'session.manage',
    description: 'Fork a conversation into a new one that starts from an earlier assistant reply, keeping the ' +
        'original untouched. Without `from_message` it forks from the most recently completed turn.',
    schema: Type.Object({
        session: Type.String({ minLength: 1, description: 'Session id to fork.' }),
        from_message: Type.Optional(Type.String({
            minLength: 1,
            description: 'Assistant message id to fork from; omit for the latest completed turn.',
        })),
        title: Type.Optional(Type.String({ minLength: 1, description: 'Title for the new chat.' })),
    }),
};
export const SessionWaitToolDef = {
    name: 'session_wait',
    namespace: 'session.dispatch',
    description: 'Wait until one of the watched conversations finishes, errors, is aborted, or asks the user for a ' +
        'permission or an answer. Returns as soon as the first event arrives; a chat that is still running ' +
        'when the wait ends is listed as pending.',
    schema: Type.Object({
        sessions: Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            maxItems: MAX_WAIT_SESSIONS,
            description: `Session ids to watch, at most ${MAX_WAIT_SESSIONS}.`,
        }),
        timeout_ms: Type.Optional(Type.Integer({
            minimum: 1_000,
            maximum: MAX_WAIT_TIMEOUT_MS,
            description: `How long to wait; defaults to ${DEFAULT_WAIT_TIMEOUT_MS} ms.`,
        })),
    }),
};
export function buildLocalSessionOpenTool(adapter) {
    return uiRequestTool(SessionOpenToolDef, adapter, (input, ctx) => ({
        sessionId: callerSessionId(ctx),
        operation: 'session.open',
        target: { sessionId: input.session },
    }));
}
export function buildLocalSessionManageTools(adapter) {
    return [
        namespacedTool(SessionForkToolDef, async (input, _ctx, signal) => {
            const options = await adapter.getForkOptions({
                sessionId: input.session,
                ...(input.from_message !== undefined ? { assistantMessageId: input.from_message } : {}),
            }, signal);
            if (!options.can_fork) {
                throw invalidArgument(options.unavailable_reason ?? 'This conversation has no completed turn to fork from.');
            }
            return adapter.forkSession({
                sessionId: input.session,
                ...(input.from_message !== undefined ? { assistantMessageId: input.from_message } : {}),
                ...(input.title !== undefined ? { title: input.title } : {}),
            }, signal);
        }),
        namespacedTool(SessionWaitToolDef, async (input, _ctx, signal) => {
            const sessionIds = [...new Set(input.sessions)];
            if (sessionIds.length === 0)
                throw invalidArgument('Watch at least one conversation.');
            if (sessionIds.length > MAX_WAIT_SESSIONS) {
                throw invalidArgument(`Watch at most ${MAX_WAIT_SESSIONS} conversations at a time.`);
            }
            return adapter.waitForSessions({ sessionIds, timeoutMs: input.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS }, signal);
        }),
    ];
}
//# sourceMappingURL=local-session-manage-tools.js.map