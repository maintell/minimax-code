const GOAL_RUNTIME_EVENT_SCHEMA = 'mavis.goal_runtime_event.v1';
/**
 * Projects Goal decisions into the existing Session Clio lifecycle stream.
 *
 * @internal Exported only for focused tests.
 */
export function createThreadGoalEvalEventSink(reporterFactory) {
    return (event) => void reportThreadGoalEvalEvent(reporterFactory, event);
}
export function reportThreadGoalEvalEvent(reporterFactory, event) {
    const input = {
        eventType: event.type,
        payload: {
            schema: GOAL_RUNTIME_EVENT_SCHEMA,
            event_type: event.type,
            event_at_ms: event.at,
            payload: snakeCaseObject(event.payload),
        },
    };
    const deliveries = [
        {
            sessionId: event.payload.sessionId,
            trajectory: 'parent',
            outcome: reportRuntimeEvent(reporterFactory, event.payload.sessionId, input),
        },
    ];
    const childSessionId = verifierChildSessionId(event);
    if (childSessionId && childSessionId !== event.payload.sessionId) {
        deliveries.push({
            sessionId: childSessionId,
            trajectory: 'verifier_child',
            outcome: reportRuntimeEvent(reporterFactory, childSessionId, input),
        });
    }
    return deliveries;
}
function reportRuntimeEvent(reporterFactory, sessionId, input) {
    try {
        return reporterFactory.reportRuntimeEvent?.(sessionId, input) ?? 'unsupported';
    }
    catch {
        // Local structured observability must survive a broken optional Clio adapter.
        return 'projection_failed';
    }
}
function verifierChildSessionId(event) {
    if (event.type !== 'goal.verification_child_started' &&
        event.type !== 'goal.verification_decided') {
        return undefined;
    }
    return event.payload.childSessionId;
}
function snakeCaseObject(value) {
    if (Array.isArray(value))
        return value.map(snakeCaseObject);
    if (!isRecord(value))
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [toSnakeCase(key), snakeCaseObject(nested)]));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function toSnakeCase(value) {
    return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
//# sourceMappingURL=eval-observability.js.map