import { isContinuationStatus } from '@mavis/goal';
import { firstGoalBlocker } from './blockers.js';
import { isThreadGoalContinuationQueueItem, isThreadGoalKickoffQueueItem, readThreadGoalContinuationOrigin, readThreadGoalKickoffOrigin, } from './kickoff.js';
/** Classify one queued item against the current Goal and ordered dependency gates. */
export async function classifyThreadGoalQueueItem(item, hasPendingPlan, deps) {
    if (isThreadGoalKickoffQueueItem(item)) {
        return classifyKickoffQueueItem(item, hasPendingPlan, deps);
    }
    if (isThreadGoalContinuationQueueItem(item)) {
        return classifyContinuationQueueItem(item, hasPendingPlan, deps);
    }
    if (await deps.gates.hasPendingQuestionnaire(item.sessionId)) {
        deps.emitQueueItemDeferred(item.sessionId, 'questionnaire_unresolved');
        return 'defer';
    }
    return 'ready';
}
async function classifyKickoffQueueItem(item, hasPendingPlan, deps) {
    const origin = readThreadGoalKickoffOrigin(item.message.origin);
    if (!origin)
        return 'cancel';
    const goal = await deps.getGoalBySession(item.sessionId);
    if (!goal || goal.goalId !== origin.goalId || goal.status === 'complete')
        return 'cancel';
    if (goal.kickoffState === 'consumed')
        return 'cancel';
    if (goal.status !== 'active')
        return 'defer';
    return classifyAgainstBlockers(goal, hasPendingPlan, deps);
}
async function classifyContinuationQueueItem(item, hasPendingPlan, deps) {
    const origin = readThreadGoalContinuationOrigin(item.message.origin);
    if (!origin)
        return 'cancel';
    const goal = await deps.getGoalBySession(item.sessionId);
    if (!goal || goal.goalId !== origin.goalId || goal.updatedAt !== origin.goalUpdatedAt) {
        return 'cancel';
    }
    if (origin.kind === 'completion-summary') {
        if (goal.status !== 'complete' ||
            goal.lastWorkerProposal?.type !== 'complete' ||
            !goal.lastWorkerProposal.resultDelivery)
            return 'cancel';
        return classifyAgainstBlockers(goal, hasPendingPlan, deps);
    }
    if (origin.kind === 'budget-limit') {
        if (await deps.gates.hasAutomationOwnerConflict(goal.sessionId)) {
            deps.emitDecision(goal.sessionId, goal.goalId, 'deferred', 'deferred(automation_owner_conflict)');
            return 'defer';
        }
        return goal.status === 'budget_limited' ? 'ready' : 'cancel';
    }
    if (!isContinuationStatus(goal.status))
        return 'cancel';
    return classifyAgainstBlockers(goal, hasPendingPlan, deps);
}
/**
 * Record the queue-selection blocker before returning `defer`. The dispatcher
 * releases that claim with `drainAgain: false`, so this is the durable evidence
 * explaining why an otherwise-active Goal is parked.
 */
async function classifyAgainstBlockers(goal, hasPendingPlan, deps) {
    let blocker;
    try {
        blocker = await firstGoalBlocker({
            hasPendingQuestionnaire: (sessionId, goalId) => 
            // The Goal-owned continuation guard also requires an active Goal.
            // Result delivery is terminal work: check real unresolved input without
            // re-entering that active-only guard or auto-answering a Goal questionnaire.
            deps.gates.hasPendingQuestionnaire(sessionId, goal.status === 'complete' ? undefined : goalId),
            hasPendingPermission: (sessionId) => deps.gates.hasPendingPermission(sessionId),
            ...(hasPendingPlan ? { hasPendingPlan } : {}),
            hasRequiredBackgroundWork: (sessionId) => deps.gates.hasRequiredBackgroundWork(sessionId),
            hasAutomationOwnerConflict: (sessionId) => deps.gates.hasAutomationOwnerConflict(sessionId),
        }, { sessionId: goal.sessionId, goalId: goal.goalId });
    }
    catch (error) {
        deps.failures.report(goal.sessionId, `thread_goal_queue_blocker_read_failed:${deps.failures.format(error)}`);
        blocker = 'dependency_unavailable';
    }
    if (!blocker)
        return 'ready';
    deps.emitDecision(goal.sessionId, goal.goalId, 'deferred', `deferred(${blocker})`);
    await deps.projectExecutionWait(goal, blocker);
    return 'defer';
}
//# sourceMappingURL=admission-queue.js.map