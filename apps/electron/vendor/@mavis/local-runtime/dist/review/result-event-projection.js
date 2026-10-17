import { RuntimeEventType } from '@mavis/agent-core/protocol';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
export function projectReviewResultEvent(event, activity, turnId, outcome) {
    if (!outcome)
        return event;
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return event;
    const raw = event.payload.stream_resp;
    if (typeof raw !== 'string')
        return event;
    try {
        const data = JSON.parse(raw);
        if (data.type !== RespDataType.AgentMessage ||
            !data.agent_message ||
            typeof data.agent_message.msg_content !== 'string') {
            return event;
        }
        const annotationResult = /^\s*<annotation-result\b/iu.test(data.agent_message.msg_content);
        const replacesActivity = annotationResult && activity && !activity.terminal;
        const currentOrigin = data.agent_message.origin &&
            typeof data.agent_message.origin === 'object' &&
            !Array.isArray(data.agent_message.origin)
            ? data.agent_message.origin
            : {};
        return {
            ...event,
            payload: {
                ...event.payload,
                stream_resp: JSON.stringify({
                    ...data,
                    agent_message: {
                        ...data.agent_message,
                        ...(replacesActivity
                            ? {
                                msg_id: activity.messageId,
                                source: 'code_review',
                                kind: 'review_result',
                            }
                            : {}),
                        origin: {
                            ...currentOrigin,
                            ...(replacesActivity
                                ? {
                                    type: 'code-review-activity',
                                    reviewRunId: activity.reviewRunId,
                                    turnId,
                                }
                                : {}),
                            reviewOutcome: outcome,
                        },
                    },
                }),
            },
        };
    }
    catch {
        return event;
    }
}
//# sourceMappingURL=result-event-projection.js.map