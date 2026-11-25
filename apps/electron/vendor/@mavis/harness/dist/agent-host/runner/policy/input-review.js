import { reviewBlocks, } from '@mavis/shared/local-runtime-safety';
import { reviewBlocksInput } from '../input-safety.js';
import { measureReviewElapsedMs, SAFETY_REVIEW_SLOW_READ_MS, } from '../output/output-safety-event-writer.js';
/**
 * Transport retries allowed once the device came back from offline: the first
 * requests after a reconnect often fail while DNS / TLS are still settling.
 */
const RECOVERED_REVIEW_MAX_RETRIES = 3;
const RECOVERED_REVIEW_RETRY_BASE_MS = 500;
/**
 * Reviews the user input. A review that fails on transport while the device is
 * offline waits for the network and reviews the same input again, like an
 * output review does. After such a reconnect a few transport failures are
 * retried with backoff before the review gives up; returns whether the input
 * was rejected.
 */
export async function reviewInputText(input, reviewText, deps, ...[observe, observeNetworkFailure, observeSlowReview]) {
    const retryNetworkFailure = deps.offlineWait
        ? createNetworkFailureRetry(deps.offlineWait, input.signal)
        : undefined;
    for (;;) {
        const startMs = Date.now();
        const startPerfMs = performance.now();
        const result = await reviewInputOnce(deps.reviewContent, reviewText);
        if (input.signal?.aborted)
            return false;
        const verdict = classifyInputReview(result, input.contentReviewRequired === true);
        // 慢送审只算这一次审核本身，不含下面的离线等待与系统休眠时间。
        const elapsedMs = measureReviewElapsedMs(startMs, startPerfMs);
        if (verdict.variant === 'network' && retryNetworkFailure) {
            const retry = await retryNetworkFailure();
            if (input.signal?.aborted)
                return false;
            if (retry)
                continue;
        }
        const slow = observeReviewElapsed(elapsedMs, observeSlowReview);
        if (verdict.variant === 'network')
            observeNetworkFailure(slow);
        observe(verdict.rejected, verdict.variant, result?.errorKind === 'api_error', result);
        reportInputReviewResolution(input, verdict.blocks);
        return verdict.rejected;
    }
}
export function reportInputReviewResolution(input, rejected) {
    if (input.deferInputReviewResolution !== true) {
        input.onInputReviewResolved?.(rejected);
    }
}
/**
 * Decides whether a transport-failed review runs again: always after waiting
 * out an offline period, and a few times with backoff once a reconnect happened.
 */
function createNetworkFailureRetry(offlineWait, signal) {
    let recovered = false;
    let recoveredRetries = 0;
    return async () => {
        if (await offlineWait.untilOnline()) {
            recovered = true;
            return true;
        }
        if (!recovered || recoveredRetries >= RECOVERED_REVIEW_MAX_RETRIES)
            return false;
        const delayMs = RECOVERED_REVIEW_RETRY_BASE_MS * 2 ** recoveredRetries;
        recoveredRetries += 1;
        return waitForBackoff(delayMs, signal);
    };
}
function waitForBackoff(delayMs, signal) {
    if (signal?.aborted)
        return Promise.resolve(false);
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve(true);
        }, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
/** One input review; undefined when it threw, which counts as a transport failure. */
async function reviewInputOnce(reviewContent, text) {
    try {
        return normalizeInputReviewResult(await reviewContent(text, 300));
    }
    catch {
        return undefined;
    }
}
function normalizeInputReviewResult(result) {
    // Input guides without text pass without interrupting the active attempt.
    return result.action === 'guide' && !result.guide_prompt?.trim()
        ? { pass: true, action: 'allow' }
        : result;
}
/** 审核返回（或抛错）时看耗时：等了 15 秒以上先通知慢送审，再把是否慢交给调用方。 */
function observeReviewElapsed(elapsedMs, observeSlowReview) {
    const slow = elapsedMs >= SAFETY_REVIEW_SLOW_READ_MS;
    if (slow)
        observeSlowReview();
    return slow;
}
function classifyInputReview(result, authVariantEnabled) {
    if (!result)
        return { rejected: true, blocks: true, variant: 'network' };
    const rejected = reviewBlocksInput(result);
    return {
        rejected,
        blocks: reviewBlocks(result),
        variant: inputReviewVariant(rejected, result.errorKind, authVariantEnabled),
    };
}
function inputReviewVariant(rejected, errorKind, authVariantEnabled) {
    if (!rejected)
        return undefined;
    if (errorKind === 'auth_error')
        return authVariantEnabled ? 'auth' : 'network';
    return errorKind === 'local_error' ? 'network' : 'content';
}
//# sourceMappingURL=input-review.js.map