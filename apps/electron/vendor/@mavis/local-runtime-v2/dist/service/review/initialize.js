import { ReviewContextAdmission } from './preparation/context-admission.js';
import { logger } from '../../infra/logging/logger.js';
export function initializeReviewContextAdmission(options) {
    return new ReviewContextAdmission({
        configGetter: options.configGetter,
        ...(options.remoteCounter ? { remoteCounter: options.remoteCounter } : {}),
        ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
        logger: options.logger ?? logger,
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    });
}
//# sourceMappingURL=initialize.js.map