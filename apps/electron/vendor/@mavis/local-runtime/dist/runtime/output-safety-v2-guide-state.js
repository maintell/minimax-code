/** Model-only guide retained after blocking an attempt, consumed once by the host. */
export class OutputSafetyV2GuideState {
    guidePrompt;
    guideReviewed = false;
    isGuideReviewed() {
        return this.guideReviewed;
    }
    /** 记录一次 reject+guide_prompt 命中。同一 attempt 多次命中会覆盖之前的引导词。 */
    mark(guidePrompt) {
        this.guidePrompt = guidePrompt;
        this.guideReviewed = true;
    }
    /**
     * 一次性消费最近一次 review 命中的引导词,同时清空 guideReviewed 标志。
     * 避免 host 同一 attempt 内多次读取或跨 attempt 残留。
     */
    consume() {
        const out = this.guidePrompt;
        this.guidePrompt = undefined;
        this.guideReviewed = false;
        return out;
    }
    /** 每 attempt 边界由 host 调一次,避免跨 attempt 残留。 */
    reset() {
        this.guidePrompt = undefined;
        this.guideReviewed = false;
    }
}
//# sourceMappingURL=output-safety-v2-guide-state.js.map