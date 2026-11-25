import { dialogReviewUnavailable, SAFETY_SCENE, } from '@mavis/shared/local-runtime-safety';
import { createSafetyMetrics } from '../../safety/observability.js';
import { resolveSafetyPolicy, withSafetyTimeout } from '../../safety/policy.js';
/** A review still running at the policy timeout is a local transport failure. */
const REVIEW_TIMED_OUT = { pass: false, errorKind: 'local_error' };
const STAGE_DISABLED = { pass: true };
export function createDialogSafetyReview(options) {
    const policy = resolveSafetyPolicy(options.contentSafety?.policy);
    const metrics = createSafetyMetrics(options.metricsClient, options.contentSafety?.host);
    return {
        review: async (content, scene) => {
            const stage = dialogStageOf(scene);
            if (!policy.enabledStages.includes(stage))
                return STAGE_DISABLED;
            let result;
            try {
                result = await withSafetyTimeout(options.reviewContent(content, scene), policy.timeoutMs, REVIEW_TIMED_OUT);
            }
            catch (error) {
                metrics.check(stage, 'unavailable');
                throw error;
            }
            metrics.check(stage, dialogVerdictKind(result));
            return result;
        },
        maxRetries: policy.maxRetries,
        unavailable: (scene) => metrics.unavailable(dialogStageOf(scene)),
    };
}
function dialogStageOf(scene) {
    if (scene === SAFETY_SCENE.UserInput)
        return 'input';
    return scene === SAFETY_SCENE.ThinkingContent ? 'thinking' : 'output';
}
function dialogVerdictKind(result) {
    if (result.pass)
        return 'pass';
    if (dialogReviewUnavailable(result))
        return 'unavailable';
    if (result.action === 'guide')
        return 'regenerate';
    return result.action === 'replace' && result.suggestion?.trim() ? 'regenerate' : 'block';
}
//# sourceMappingURL=dialog-safety-review.js.map