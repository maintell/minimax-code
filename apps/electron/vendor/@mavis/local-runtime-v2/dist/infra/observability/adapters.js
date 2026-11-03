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