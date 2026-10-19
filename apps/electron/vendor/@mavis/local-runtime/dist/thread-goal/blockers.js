/**
 * Single ordered source of truth for "which blocker is the Goal sitting on".
 *
 * Queue selection and final admission both evaluate the same list in the same
 * order so the reason projected to the user while waiting is the same one that
 * later admits or re-defers the Turn. Order is by how directly the user can act
 * on the blocker: things they can resolve now come before things they can only
 * wait out.
 *
 * Returns `undefined` when nothing blocks the Goal.
 */
export async function firstGoalBlocker(gates, input) {
    if (await gates.hasPendingQuestionnaire(input.sessionId, input.goalId))
        return 'questionnaire';
    if (await gates.hasPendingPermission(input.sessionId))
        return 'permission';
    if (gates.hasPendingPlan && (await gates.hasPendingPlan(input.sessionId)))
        return 'plan';
    if (await gates.hasRequiredBackgroundWork(input.sessionId))
        return 'required_background';
    if (await gates.hasAutomationOwnerConflict(input.sessionId))
        return 'automation_owner_conflict';
    return undefined;
}
//# sourceMappingURL=blockers.js.map