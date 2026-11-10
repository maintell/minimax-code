import { RuntimeEventType } from '@mavis/agent-core/protocol';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
export function projectReviewResultEvent(event, activity, turnId, outcome) {
    if (!outcome || event.type !== RuntimeEventType.STREAM_RESP)
        return event;
    const raw = event.payload.stream_resp;
    if (typeof raw !== 'string')
        return event;
    return projectReviewResultStream(event, raw, {
        activity,
        turnId,
        outcome,
    });
}
function projectReviewResultStream(event, raw, input) {
    const { activity, turnId, outcome } = input;
    try {
        const data = JSON.parse(raw);
        const message = data.agent_message;
        if (data.type !== RespDataType.AgentMessage ||
            !message ||
            typeof message.msg_content !== 'string') {
            return event;
        }
        const replacesActivity = /^\s*<annotation-result\b/iu.test(message.msg_content) &&
            Boolean(activity && !activity.terminal);
        const currentOrigin = objectOrigin(message.origin);
        return {
            ...event,
            payload: {
                ...event.payload,
                stream_resp: JSON.stringify({
                    ...data,
                    agent_message: {
                        ...message,
                        ...reviewActivityFields(activity, replacesActivity),
                        origin: {
                            ...currentOrigin,
                            ...reviewActivityOrigin(activity, replacesActivity, turnId),
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
function objectOrigin(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function reviewActivityFields(activity, replacesActivity) {
    if (!replacesActivity || !activity)
        return {};
    return { msg_id: activity.messageId, source: 'code_review', kind: 'review_result' };
}
function reviewActivityOrigin(activity, replacesActivity, turnId) {
    if (!replacesActivity || !activity)
        return {};
    return { type: 'code-review-activity', reviewRunId: activity.reviewRunId, turnId };
}
//# sourceMappingURL=result-event-projection.js.map