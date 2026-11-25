import { createContentSafetyChecker } from './transport/checker.js';
import { callSafetyApi } from './transport/api.js';
import { callLocalSafetyCheckV2 } from './transport/api-v2.js';
import { createContentReviewModeProbe } from './transport/review-mode.js';
import { ContentSafetyService, } from './content-safety.service.js';
function initializeContentSafetyService(options) {
    return new ContentSafetyService(options);
}
export function initializeManagedContentSafetyService(options) {
    let closed = false;
    let unbind;
    const pending = new Set();
    const run = async (action) => {
        if (closed)
            throw new Error('Content safety owner has been closed');
        const work = action();
        pending.add(work);
        try {
            return await work;
        }
        finally {
            pending.delete(work);
        }
    };
    const checker = createContentSafetyChecker(options);
    // 开关读 common_config；读不到或不是 true 时按本地送审处理。
    const reviewMode = createContentReviewModeProbe();
    const service = initializeContentSafetyService({
        review: (content, scene) => run(() => checker(content, scene)),
        serverReviewEnabled: reviewMode.serverReviewEnabled,
        close: async () => {
            closed = true;
            unbind?.();
            await Promise.allSettled([...pending]);
        },
    });
    const transport = () => ({
        authContext: options.authContextGetter?.(),
        routingContext: options.routingContextGetter?.(),
        fetchImpl: options.fetchImpl ?? fetch,
        region: options.region,
        buildEnv: options.buildEnv,
    });
    unbind = options.bind({
        review: service.review,
        // Legacy /content had no auth-refresh or testBaseURL override; retain that contract.
        reviewText: (input) => run(() => callSafetyApi({ ...transport(), ...input })),
        reviewV2: (request) => run(() => callLocalSafetyCheckV2({ ...transport(), request })),
    });
    return service;
}
//# sourceMappingURL=initialize.js.map