/**
 * Goal statuses in which the Goal is stopped but not finished. A message sent
 * in one of them runs as an ordinary Turn (spec §10): it does not resume the
 * Goal and does not change its state.
 */
const GOAL_NOT_ACTIVE_STATUSES = [
    'paused',
    'blocked',
    'usage_limited',
    'budget_limited',
];
/**
 * Reminder for an ordinary Turn while the session's Goal is stopped. The
 * history can still hold Goal instructions, for example the kickoff of a Goal
 * Turn the user paused before it replied; without this reminder the model
 * reads them as a live order and keeps working on the Goal.
 *
 * @internal Exported only for focused tests.
 */
export const GOAL_NOT_ACTIVE_TURN_REMINDER_TEMPLATE = '<system-reminder>\n' +
    "This session's goal is not running: its status is {{status}}. This is an ordinary turn, so respond only to the user's latest message.\n" +
    'Goal instructions earlier in the conversation, including requests to continue working toward the goal, do not authorize goal work in this turn.\n' +
    "If the user's latest message asks for a task, handle it as usual and use tools when it needs them.\n" +
    'Do not try to advance or complete the goal, and do not call update_goal for it. The user resumes the goal with the continue action in the interface.\n' +
    '</system-reminder>';
function renderGoalNotActiveTurnReminder(status) {
    return GOAL_NOT_ACTIVE_TURN_REMINDER_TEMPLATE.replace('{{status}}', status);
}
function isGoalNotActiveStatus(status) {
    return GOAL_NOT_ACTIVE_STATUSES.includes(status);
}
/**
 * Adds the not-active Goal reminder to ordinary Turns. Goal Turns and Goal
 * verifier Turns never get it, and neither do sessions without a Goal or with
 * an active or complete Goal. A failed Goal read adds nothing rather than
 * failing the user's Turn.
 */
export function createGoalNotActiveReminderExtension(goals) {
    return {
        id: 'local-goal-not-active-reminder',
        description: 'Tell ordinary Turns that the session Goal is stopped and must not be continued.',
        init(pi) {
            pi.registerReminderProvider({
                name: 'goal-not-active',
                compute: async (ctx) => {
                    if (!goals.isEnabled())
                        return null;
                    if (ctx.turnIntent?.kind === 'goal-verifier')
                        return null;
                    if (goals.getTurnBinding(ctx.turnId) !== undefined)
                        return null;
                    let goal;
                    try {
                        goal = await goals.store.getBySession(ctx.sessionId);
                    }
                    catch {
                        return null;
                    }
                    if (!goal || !isGoalNotActiveStatus(goal.status))
                        return null;
                    return { content: renderGoalNotActiveTurnReminder(goal.status) };
                },
            });
        },
    };
}
//# sourceMappingURL=not-active-reminder.js.map