import { reviewBlocks, SAFETY_SCENE, } from '../../content-safety/index.js';
/** 状态由当前 Turn 持有；晚到裁定仅阻断仍活跃的 attempt。 */
export async function reviewTurnInput(input) {
    const { turn, state } = input;
    if (!turn.reviewUserInput?.trim())
        return;
    try {
        const result = await input.review(turn.reviewUserInput, SAFETY_SCENE.UserInput);
        if (turn.signal?.aborted)
            return;
        applyInputVerdict(state, result);
        if (state.correctionPending)
            input.blockCurrent();
        turn.onInputReviewResolved?.(reviewBlocks(result));
    }
    catch {
        if (turn.signal?.aborted)
            return;
        state.rejected = true;
        state.correctionPending = true;
        state.variant = 'network';
        input.blockCurrent();
        turn.onInputReviewResolved?.(true);
    }
}
function applyInputVerdict(state, result) {
    state.replacement = result.action === 'replace' ? result.suggestion : undefined;
    if (result.action === 'guide')
        state.guide = result.guide_prompt?.trim() || undefined;
    state.rejected = reviewBlocks(result) && !state.replacement && !state.guide;
    state.correctionPending = Boolean(state.rejected || state.replacement || state.guide);
    state.variant =
        result.errorKind === 'local_error' || result.errorKind === 'auth_error' ? 'network' : 'content';
}
//# sourceMappingURL=host-input-review.js.map