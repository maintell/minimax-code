import { ComputerUseCaptureReporter } from './reporter.js';
/**
 * The Harness capture port over the host-only resolver. Capture starts only
 * when the trusted configuration both enables it and grants local storage
 * consent. A strict capture that cannot open its directory fails the Turn;
 * otherwise the Turn runs without evidence and the failure is logged.
 */
export function createComputerUseCaptureStarter(resolve, logger) {
    if (!resolve)
        return undefined;
    return async (context) => {
        const config = await resolve(context);
        if (config?.enabled !== true || config.localStorageConsent !== true)
            return undefined;
        try {
            return await ComputerUseCaptureReporter.create(config, { sessionId: context.sessionId, turnId: context.turnId }, logger);
        }
        catch (error) {
            if (config.strict)
                throw new Error('computer_use_capture_initialization_failed', { cause: error });
            logInitializationFailure(logger, error);
            return undefined;
        }
    };
}
function logInitializationFailure(logger, error) {
    try {
        logger?.warn?.({
            operation: 'computer_use_capture_initialize',
            error_name: error instanceof Error ? error.name : typeof error,
        }, '[eval-capture] local eval reporting failed open');
    }
    catch {
        // Eval reporting and diagnostics are both best effort.
    }
}
//# sourceMappingURL=session.js.map