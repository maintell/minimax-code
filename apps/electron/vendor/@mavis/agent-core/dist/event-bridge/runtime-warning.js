import { MsgType, RespDataType, } from '../protocol/agent-message.js';
import { buildStreamRespEvent } from './converters.js';
export const RUNTIME_WARNING_EVENT_TYPE = 'runtime.warning';
/**
 * Build a durable, user-visible runtime warning without adding it to model
 * history. Hosts persist and fan out this ordinary `MsgType.SystemEvent`; UI
 * clients project it into a warning surface while Pi history ignores it.
 */
export function buildRuntimeWarningEvent(input) {
    const message = {
        msg_id: input.eventId,
        turn_id: input.turnId,
        timestamp: input.nowMs ?? Date.now(),
        msg_type: MsgType.SystemEvent,
        msg_content: JSON.stringify({
            eventType: RUNTIME_WARNING_EVENT_TYPE,
            message: input.message,
            source: input.source,
            ...(input.category ? { category: input.category } : {}),
            ...(input.code ? { code: input.code } : {}),
            ...(input.pluginName ? { pluginName: input.pluginName } : {}),
            ...(input.hookEvent ? { hookEvent: input.hookEvent } : {}),
            ...(input.terminalSequence ? { terminalSequence: input.terminalSequence } : {}),
        }),
    };
    const respData = {
        type: RespDataType.AgentMessage,
        agent_message: message,
    };
    return buildStreamRespEvent({
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventId: input.eventId,
        runtimeSeq: input.runtimeSeq,
        respData,
    });
}
//# sourceMappingURL=runtime-warning.js.map