/**
 * What a user-authored Goal patch is asking for.
 *
 * These are pure questions about the *shape* of a `ThreadGoalPatchInput`, kept
 * out of `GoalLifecycle` so the lifecycle reads as a sequence of decisions
 * rather than a mix of decisions and field inspection. None of them reads Goal
 * state: each guard in `patchGoal` pairs one of these with the separate
 * question of what the stored Goal currently allows.
 */
/**
 * True for "just continue this Goal" — the shape `/goal resume` and the Retry
 * action send.
 *
 * A patch that also rewrites the objective or its resources is excluded: that
 * is a request to change the work, and it keeps the restart semantics it has
 * always had rather than being partially applied.
 */
function isBareResume(patch) {
    return (patch.status === 'active' &&
        patch.objective === undefined &&
        patch.objectiveResources === undefined);
}
/**
 * True for a resume that changes nothing but the status. Only this shape may
 * be answered without a write when the Goal is already `active`: any budget or
 * objective edit riding along must still be applied.
 */
export function isStatusOnlyResume(patch) {
    return isBareResume(patch) && patch.tokenBudget === undefined;
}
/**
 * True when a patch would put the Goal back to work or change what it aims at:
 * reactivation, a new objective (with or without replacement resources), or a
 * new token budget. Pausing, completing, blocking, and clearing are excluded —
 * those are how a user gets out of a Goal, not into one.
 */
export function restartsOrRetargetsGoal(patch) {
    return (patch.status === 'active' ||
        patch.objective !== undefined ||
        patch.objectiveResources !== undefined ||
        patch.tokenBudget !== undefined);
}
/**
 * Derive the user-authored status reason a bare status patch implies.
 *
 * This lives in the domain rather than in the wire contract: a `PatchGoalReq`
 * carries no `status_reason` field, so a transport-layer translator that
 * invents one is writing domain state it does not own — and that invented
 * field is exactly what silently diverted user pauses away from
 * `pauseGoalByUser`. An explicit reason from an internal caller still wins.
 */
export function withUserStatusReason(patch) {
    if (patch.statusReason !== undefined)
        return patch;
    if (patch.status === 'paused')
        return { ...patch, statusReason: 'paused(user_requested)' };
    if (patch.status === 'complete')
        return { ...patch, statusReason: 'complete(user_requested)' };
    return patch;
}
//# sourceMappingURL=lifecycle-patch-intent.js.map