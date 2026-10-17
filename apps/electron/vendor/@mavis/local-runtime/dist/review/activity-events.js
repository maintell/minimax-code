import { buildStreamRespEvent } from '@mavis/agent-core/event-bridge';
import { MsgType, RespDataType, Role, } from '@mavis/agent-core/protocol/agent-message';
import { makeId } from '../api/host-helpers.js';
export function createReviewActivityIdentity(reviewRunId) {
    return {
        messageId: makeId('msg_review_activity'),
        reviewRunId,
    };
}
export async function emitReviewActivity(input) {
    const message = {
        msg_id: input.identity.messageId,
        timestamp: input.timestamp,
        role: Role.Assistant,
        msg_type: MsgType.AgentContent,
        msg_content: '',
        thinking_content: '',
        tool_calls: [],
        source: 'code_review',
        origin: {
            type: 'code-review-activity',
            reviewRunId: input.identity.reviewRunId,
            turnId: input.turnId,
        },
        kind: input.kind,
    };
    await input.eventWriter.pushRuntime(buildStreamRespEvent({
        sessionId: input.sessionId,
        turnId: input.turnId,
        eventId: makeId(`evt_${input.kind}`),
        runtimeSeq: input.runtimeSeq ?? input.timestamp,
        respData: {
            type: RespDataType.AgentMessage,
            agent_message: message,
        },
    }));
}
//# sourceMappingURL=activity-events.js.map