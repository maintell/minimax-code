import { callbackify } from 'node:util';
import { logger } from '../../../infra/logging/logger.js';
/**
 * An `activated` steer starts a Turn and therefore owns its completion. A
 * producer that only needs the admission ACK still has to consume that
 * completion, otherwise a rejected Turn surfaces as an unhandled rejection in
 * the runtime process.
 */
export function observeSteerCompletion(result, observer) {
    if (result.mode !== 'activated')
        return result;
    callbackify(logSteerCompletion)(result, observer, (error) => {
        if (error) {
            logger.warn({ sessionId: observer.sessionId, turnId: result.turnId, error }, 'Steer completion observer failed');
        }
    });
    return result;
}
async function logSteerCompletion(result, observer) {
    try {
        await result.completion;
    }
    catch (error) {
        observer.matrixLogger?.warn({ sessionId: observer.sessionId, turnId: result.turnId }, `${observer.producer} activated Turn failed after admission: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=conversation-steer.js.map