import { createCronMetrics } from './adapters/metrics.client.js';
import { composeCronService } from './composition.js';
/**
 * Initializes the Cron service and registers its Scheduler handler. The caller starts shared
 * background infrastructure before awaiting ready(), preserving the existing start/recovery order.
 */
export function initializeCronService(options) {
    const metrics = createCronMetrics(options.metrics);
    const composition = composeCronService({
        reviewContent: options.reviewContent,
        db: options.db,
        scheduler: options.scheduler,
        ...(options.sessionPorts ? { sessionPorts: options.sessionPorts } : {}),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
        metrics,
    });
    let readyPromise;
    let closePromise;
    const close = () => {
        closePromise ??= composition.close();
        return closePromise;
    };
    const ready = () => {
        readyPromise ??= reportStartedAndRecover(composition, metrics, options.recoverPendingRuns !== false);
        return readyPromise;
    };
    return {
        service: composition.service,
        isSessionOwnedByDefinition: composition.isSessionOwnedByDefinition,
        ready,
        close,
    };
}
async function reportStartedAndRecover(composition, metrics, recoverPendingRuns) {
    metrics.engineStarted();
    if (recoverPendingRuns)
        await composition.recoverPendingRuns();
}
//# sourceMappingURL=initialize.js.map