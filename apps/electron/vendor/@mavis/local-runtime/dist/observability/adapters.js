import { reportThreadGoalEvalEvent } from '../thread-goal/eval-observability.js';
export function createLocalRuntimeTelemetrySink(logger) {
    const runtimeLogger = logger.child({ component: 'local-runtime.session' });
    return (event) => {
        const fields = {
            runtime: event.runtime,
            phase: event.phase,
            ...(event.message ? { reason: event.message } : {}),
        };
        const child = runtimeLogger.child({
            sessionId: event.sessionId,
            ...(event.turnId ? { turnId: event.turnId } : {}),
        });
        if (event.phase === 'failure') {
            child.error(`runtime turn ${event.phase}`, fields);
        }
        else if (event.phase === 'disabled') {
            child.warn(`runtime turn ${event.phase}`, fields);
        }
        else {
            child.info(`runtime turn ${event.phase}`, fields);
        }
    };
}
/** Records one safe local Goal event together with its best-effort Session Clio outcome. */
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
export function createMatrixToolLogger(logger) {
    const matrixLogger = logger.child({ component: 'local-runtime.matrix-tools' });
    return {
        info: (ctx, message) => matrixLogger
            .child({ sessionId: ctx.sessionId, turnId: ctx.turnId, workspaceDir: ctx.workspaceRoot })
            .info(message),
        warn: (ctx, message) => matrixLogger
            .child({ sessionId: ctx.sessionId, turnId: ctx.turnId, workspaceDir: ctx.workspaceRoot })
            .warn(message),
        debug: (ctx, message) => matrixLogger
            .child({ sessionId: ctx.sessionId, turnId: ctx.turnId, workspaceDir: ctx.workspaceRoot })
            .debug(message),
    };
}
//# sourceMappingURL=adapters.js.map