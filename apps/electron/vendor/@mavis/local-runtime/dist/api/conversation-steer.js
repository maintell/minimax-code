/**
 * An `activated` steer starts a Turn and therefore owns its completion. A
 * producer that only needs the admission ACK still has to consume that
 * completion, otherwise a rejected Turn surfaces as an unhandled rejection in
 * the runtime process.
 */
export function observeSteerCompletion(result, observer) {
    if (result.mode !== 'activated')
        return result;
    void result.completion.catch((error) => {
        observer.matrixLogger?.warn({ sessionId: observer.sessionId, turnId: result.turnId }, `${observer.producer} activated Turn failed after admission: ${error instanceof Error ? error.message : String(error)}`);
    });
    return result;
}
//# sourceMappingURL=conversation-steer.js.map