import { inspectContinuationHistory } from '../history/continuation-history.js';
/**
 * The continuation state of a settled run's committed history, read with the
 * `inspectContinuation` rules. History that fails canonical validation cannot
 * be continued, so it reads as `unavailable`.
 */
export function continuationHintOf(messages) {
    try {
        return inspectContinuationHistory(messages);
    }
    catch {
        return 'unavailable';
    }
}
//# sourceMappingURL=continuation-hint.js.map