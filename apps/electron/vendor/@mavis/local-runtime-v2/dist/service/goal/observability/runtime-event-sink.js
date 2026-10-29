import { reportThreadGoalEvalEvent, } from './eval-observability.js';
/**
 * Records one safe local Goal decision event in the structured runtime log,
 * together with its best-effort Session Clio outcome. The record shape
 * (`mavis.goal_runtime_event.v1`, `eventType`, `eventAtMs`, `payload`) is what
 * diagnostics and verification read back as the Goal's runtime events.
 */
export function createThreadGoalObservabilityEventSink(logger, reporterFactory) {
    const goalLogger = logger.child({ component: 'local-runtime.thread-goal' });
    return (event) => {
        const deliveries = reporterFactory
            ? reportThreadGoalEvalEvent(reporterFactory, event)
            : [
                {
                    sessionId: event.payload.sessionId,
                    trajectory: 'parent',
                    outcome: 'not_configured',
                },
            ];
        const payload = event.payload;
        const child = goalLogger.child({
            sessionId: event.payload.sessionId,
            ...(typeof payload.turnId === 'string' ? { turnId: payload.turnId } : {}),
        });
        child.info('Thread Goal runtime decision', {
            schema: 'mavis.goal_runtime_event.v1',
            eventType: event.type,
            eventAtMs: event.at,
            payload,
            clioDeliveries: deliveries,
        });
    };
}
//# sourceMappingURL=runtime-event-sink.js.map