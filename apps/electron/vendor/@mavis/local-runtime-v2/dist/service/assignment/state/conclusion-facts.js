import { isVerdictGated } from '../verdict/verdict-gate.js';
/** An error carrying the code the assignment tools report it under. */
function coded(message, code) {
    return Object.assign(new Error(message), { code });
}
/**
 * Whether something other than a review still owns the task's conclusion.
 *
 * The verdict gate owns a gated task's conclusion: the old path never writes it, and never
 * redelivers its report either, since the review that matters is the review task's.
 *
 * A task whose own background commands or subagents are still running is not done either:
 * its review ends without closing it, and their results reach the task, which finishes its
 * work and reports again.
 */
export async function reviewConclusionHeld(assignment, success, sessionId, facts) {
    if (isVerdictGated(assignment))
        return true;
    if (!success)
        return false;
    return (await facts.hasRunningBackgroundTask?.(sessionId)) === true;
}
/**
 * Checks and shapes one conclusion, writing nothing: a batch is validated in full before any
 * of it lands, so a refusal here leaves every task in it exactly as it was.
 */
export async function prepareConclusion(ports, item, gateOn) {
    const task = await ports.requireTask(item.sessionId);
    const assignment = await ports.requireAssignment(task);
    // A reviewed task may only be concluded once its verdict landed and Bunny read it.
    // With the gate switched off nothing holds it: the kill switch has to be a way out, not
    // a second lock, and a task whose gate was released while the switch is off closes here.
    const blocked = ports.conclusionBlock(assignment);
    if (blocked)
        throw coded(blocked, 'ASSIGNMENT_VERDICT_REQUIRED');
    const turn = await ports.facts.lastTurn(task.sessionId);
    if (!turn)
        throw new Error('Task has no result to summarize');
    const summary = item.summary.trim();
    return {
        result: {
            sessionId: task.sessionId,
            reportKey: `${task.sessionId}:${turn.turnId}:${turn.state}`,
            summary,
        },
        summaryItem: {
            sessionId: task.sessionId,
            title: task.title ?? '',
            summary,
            // Stable across coordinator turns, different for a real new task result.
            revision: `${assignment.assignedAt}:${turn.turnId}:${turn.state}`,
            // No files: Bunny's conversation shows none. They stay with the task, in its panel
            // and in the completion closeReviewed records below.
        },
        gated: isVerdictGated(assignment) || (!gateOn && assignment.verdictGateReleased !== undefined),
        // A task whose own background commands or subagents are still running is not done,
        // whichever path would close it: its result reaches the task, not the conclusion.
        backgroundRunning: (await ports.facts.hasRunningBackgroundTask?.(task.sessionId)) === true,
    };
}
//# sourceMappingURL=conclusion-facts.js.map