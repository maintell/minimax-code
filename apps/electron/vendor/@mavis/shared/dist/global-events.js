// Contract admission rules: ./global-events/README.md
export const GLOBAL_EVENT_TYPES = [
    'agent.created',
    'agent.updated',
    'session.created',
    'session.visibility_updated',
    'session.deleted',
    'session.pinned_updated',
    'session.title_updated',
    'session.model_updated',
    'session.interaction_mode.changed',
    'session.start',
    'session.finish',
    'session.error',
    'session.abort',
    'session.queue.updated',
    'session.compaction.started',
    'session.compaction.completed',
    'session.compaction.failed',
    'session.llm_retry',
    'permission.ask',
    'permission.resolved',
    'config.permission_mode.changed',
    'config.browser_use_tooling.changed',
    'questionnaire.ask',
    'questionnaire.dismiss',
    'questionnaire.superseded',
    'message.rewind',
    'notification.read',
    'notification.refresh',
    'content.retry.exceeded',
    'rotation.completed',
    'thread_goal.updated',
    'thread_goal.cleared',
    'thread_goal.objective_updated_steering',
    'workspace.git.changed',
];
const GLOBAL_EVENT_TYPE_SET = new Set(GLOBAL_EVENT_TYPES);
export function isGlobalEventType(value) {
    return typeof value === 'string' && GLOBAL_EVENT_TYPE_SET.has(value);
}
/** Decode the generated Thrift/SSE frame without duplicating every payload schema at runtime. */
export function decodeGlobalEventFrame(frame) {
    if (!isRecord(frame) || !isTimestamp(frame.timestamp))
        return undefined;
    if (frame.kind === 'heartbeat') {
        return { kind: 'heartbeat', timestamp: frame.timestamp };
    }
    if (frame.kind !== 'event' ||
        frame.source !== 'local-runtime' ||
        !isGlobalEventType(frame.type) ||
        typeof frame.payloadJson !== 'string') {
        return undefined;
    }
    let payload;
    try {
        payload = JSON.parse(frame.payloadJson);
    }
    catch {
        return undefined;
    }
    if (!isRecord(payload))
        return undefined;
    return {
        kind: 'event',
        event: {
            type: frame.type,
            timestamp: frame.timestamp,
            source: 'local-runtime',
            payload,
        },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTimestamp(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
//# sourceMappingURL=global-events.js.map