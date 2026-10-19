import { randomUUID } from 'node:crypto';
import { logger } from '@mavis/shared/local-runtime-logging';
/** One bounded record per failed check, in every build. Never log raw upstream data. */
export function createSafetyFailureReporter(url, apiVersion, scene) {
    const startedAt = Date.now();
    const reviewId = randomUUID();
    const endpointHost = new URL(url).hostname;
    return (failure) => {
        logger.warn({
            reviewId,
            endpointHost,
            apiVersion,
            scene,
            durationMs: Date.now() - startedAt,
            ...failure,
        }, '[content-safety] review failed');
    };
}
//# sourceMappingURL=diagnostics.js.map