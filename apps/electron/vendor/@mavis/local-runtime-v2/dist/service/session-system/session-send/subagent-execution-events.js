import { MsgType } from '@mavis/agent-core/protocol/agent-message';
import { logger } from '../../../infra/logging/logger.js';
import { isSubagentExecutionChild } from '../conversation/session-policy.js';
import { parseSubagentExecutionFact, } from '../stream/subagent-execution-fact.js';
/** Only delegated workers record executions; see isSubagentExecutionChild. */
function isDispatchedChild(session, sessionId) {
    if (!session?.parentSessionId || session.parentSessionId === sessionId)
        return false;
    return isSubagentExecutionChild(session);
}
/**
 * A Turn the user started from the child's own composer (or by editing a message there)
 * is not a parent dispatch: the parent never waits on it, so it records no execution.
 */
function isUserInitiatedChildTurnSource(source) {
    return (source === 'api' ||
        source === 'conversation-mutation' ||
        source === 'channel' ||
        source.startsWith('channel:'));
}
/** Display-only durable facts; never append these records to canonical model history. */
export function createSubagentExecutionEvents(options) {
    const write = async (fact) => {
        const phase = fact.status === 'started' ? 'started' : 'terminal';
        const identity = `subagent-execution:${fact.child_session_id}:${fact.turn_id}:${phase}`;
        // The child copy is a recovery marker, deliberately not the public event:
        // parsing a child's own timeline must not look like a self-dispatch.
        const markerId = `${identity}:recovery`;
        const existing = await options.messages.get(fact.child_session_id, markerId);
        let marker = existing ?? {
            msg_id: markerId,
            msg_type: MsgType.SystemEvent,
            msg_content: JSON.stringify({ eventType: 'subagent.execution.recovery', fact }),
        };
        if (!existing) {
            const persistedMarker = await options.messages.upsert({
                sessionId: fact.child_session_id,
                message: marker,
                source: 'subagent-lifecycle',
            });
            marker = JSON.parse(persistedMarker.dataJson);
        }
        const authoritative = markerFact(marker);
        if (!authoritative)
            throw new Error('Invalid persisted subagent execution fact');
        // The frozen parent may have been deleted while the child ran: keep only the child
        // marker instead of leaving orphan rows, notifications or frames for that Session.
        if (!(await options.sessions.get(authoritative.parent_session_id))) {
            logger.info({
                sessionId: authoritative.child_session_id,
                parentSessionId: authoritative.parent_session_id,
            }, 'Subagent execution parent no longer exists; skipping parent fact');
            return;
        }
        // First terminal fact wins, including on replay after a process restart.
        if (await options.messages.get(authoritative.parent_session_id, identity))
            return;
        const persisted = await options.messages.upsert({
            sessionId: authoritative.parent_session_id,
            source: 'subagent-lifecycle',
            message: {
                msg_id: identity,
                msg_type: MsgType.SystemEvent,
                msg_content: JSON.stringify(authoritative),
                ...(typeof marker.timestamp === 'number' ? { timestamp: marker.timestamp } : {}),
            },
        });
        // Product notification follows the durable message. Its failure cannot
        // change the child Turn outcome; a reload reads the same stable message.
        try {
            options.onCommitted?.({
                ...authoritative,
                sessionId: authoritative.parent_session_id,
                msgId: persisted.msgId,
                timestamp: persisted.createdAtMs,
            });
        }
        catch (error) {
            logger.warn({
                error: error instanceof Error ? error.message : String(error),
                sessionId: authoritative.parent_session_id,
                turnId: authoritative.turn_id,
            }, 'Subagent execution notification failed after persistence');
        }
        options.stream?.write({
            sessionEventType: 'subagent.execution',
            identity,
            sessionId: authoritative.parent_session_id,
            kind: 'message-committed',
            data: { messages: [JSON.parse(persisted.dataJson)] },
        });
    };
    return {
        project: async ({ sessionId, turnId, status, origin }) => {
            if (origin && isUserInitiatedChildTurnSource(origin.source))
                return;
            const startedMarker = await options.messages.get(sessionId, `subagent-execution:${sessionId}:${turnId}:started:recovery`);
            const started = startedMarker ? markerFact(startedMarker) : undefined;
            if (started?.child_session_id === sessionId && started.turn_id === turnId) {
                await write({ ...started, status });
                return;
            }
            // Callers pass the origin wherever they still hold the Turn request. A terminal
            // without one (a forced stop) belongs to a running Turn, so it is recorded only
            // when that Turn's start was: no in-memory state, and a restart keeps the answer.
            if (status !== 'started' && !origin)
                return;
            const session = await options.sessions.get(sessionId);
            if (!isDispatchedChild(session, sessionId))
                return;
            await write({
                eventType: 'subagent.execution',
                parent_session_id: session.parentSessionId,
                child_session_id: sessionId,
                turn_id: turnId,
                agent_name: session.agentName,
                status,
            });
        },
        recover: async (sessionId) => {
            const facts = [];
            let before;
            do {
                const page = await options.messages.list(sessionId, {
                    systemEventsOnly: true,
                    ...(before ? { before } : {}),
                });
                for (const message of page.messages) {
                    const fact = markerFact(message);
                    if (fact?.child_session_id === sessionId)
                        facts.push(fact);
                }
                before = page.hasMore ? page.nextCursor : undefined;
            } while (before);
            // Replay public writes that a crash may have interrupted before Session
            // state was committed; only a precise unclosed started marker is interrupted.
            for (const fact of facts) {
                if (fact.status !== 'started')
                    await write(fact);
            }
            for (const fact of facts) {
                if (fact.status !== 'started')
                    continue;
                await write(fact);
                await write({ ...fact, status: 'interrupted' });
            }
        },
    };
}
function markerFact(message) {
    if (typeof message.msg_content !== 'string')
        return undefined;
    try {
        const parsed = JSON.parse(message.msg_content);
        if (parsed?.eventType !== 'subagent.execution.recovery')
            return undefined;
        return parseSubagentExecutionFact(parsed.fact);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=subagent-execution-events.js.map