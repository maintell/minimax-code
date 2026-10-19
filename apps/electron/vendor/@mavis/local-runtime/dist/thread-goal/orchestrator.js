/**
 * Thread Goal continuation orchestrator — wraps the host's per-turn
 * `runOneTurn` callable in a `while goal.status === 'active'` loop so
 * the model can keep working across turns without the user having to
 * keep typing prompts.
 *
 * Lifecycle in one SSE stream:
 *   1. user message arrives, host pre-buffers `userMessages` into the
 *      writer (so the UI sees the message immediately).
 *   2. orchestrator runs turn #1 with the user-typed content.
 *   3. After the turn returns, orchestrator reads the goal state.
 *      - status === 'active'        → render continuation prompt,
 *                                     new turnId, loop.
 *      - status in {complete,
 *                   blocked,
 *                   paused}         → break.
 *      - no goal exists for session → break.
 *      - turn status === 'error'    → mark goal blocked (if one exists)
 *                                     and break (codex on_turn_error parity).
 *      - turn status === 'aborted' /
 *        signal aborted             → break WITHOUT blocking. A turn abort
 *                                     (user cancel OR the objective-edit
 *                                     restart) leaves the goal `active` —
 *                                     codex `on_turn_abort` only accounts
 *                                     progress, it never blocks. Blocking
 *                                     here was the bug that left an edited
 *                                     goal stuck on `blocked`.
 *      - turn status ===
 *        'waiting_for_user'          → break WITHOUT blocking. ask_user has
 *                                     created a pending questionnaire; the
 *                                     answer path will kick the next turn.
 *      - turn status === 'retracted' → atomically pause the active goal,
 *                                     publish the updated goal, and break.
 *   4. Caller writes `[DONE]` and closes the writer.
 *
 * This legacy loop observes only durable Goal state. The hosted v2 path owns
 * `update_goal` proposals and settles them before any continuation decision;
 * this helper has no independent proposal authority.
 *
 * **No max-turn limit**, no token budget — codex Thread Goal alignment.
 * Safety nets: (a) `signal.aborted` short-circuits the loop,
 * (b) `update_goal(blocked)` lets the model self-stop, (c) UI `/goal
 * pause` flips status → paused, (d) UI `/goal clear` DELETE flips
 * status by removing the row.
 */
import { isContinuationStatus, renderContinuationPrompt, } from '@mavis/goal';
export function createThreadGoalContinuationOrchestrator(store, 
/**
 * Invoked when the orchestrator itself mutates the goal after a turn
 * error. Hosts project this onto the SSE bus so the UI banner stops live.
 */
onGoalMutated, 
/**
 * Selects the prompt for each continuation turn. Defaults to the plain
 * continuation template. The host overrides it so a just-edited objective
 * resolves to the `objective_updated` prompt on the next turn — codex
 * notifies the model via `inject_if_running`; archon lacks that channel, so
 * it pivots at the next turn boundary instead (no abort, no restart race).
 */
renderContinuation = renderContinuationPrompt, 
/**
 * Pauses an active goal after content-safety retracts the whole Turn.
 * The host owns the atomic store operation and SSE projection; returning
 * undefined is allowed when no active goal remains or the soft write fails.
 */
onTurnRetracted) {
    return {
        async run(input) {
            let turnsRun = 0;
            let promptText = input.initialPromptText;
            let turnId = input.initialTurnId;
            let isContinuation = false;
            let lastStatus = 'finished';
            while (true) {
                // Run the turn BEFORE checking the abort signal. The signal may
                // have flipped to aborted in between Promise microtasks before
                // we even reached this iteration — codex's `continue_if_idle`
                // path always runs the next turn and lets the turn itself
                // surface abort. Mirror that here so the first user-typed turn
                // is never silently dropped.
                turnsRun += 1;
                lastStatus = await input.runOneTurn({ turnId, promptText, isContinuation });
                // This legacy loop has no structured provider error provenance. Treat
                // the failure as retryable/unknown and pause instead of inventing a
                // stable blocker.
                if (lastStatus === 'error') {
                    const finalGoal = await pauseIfActiveAfterFailure(store, input.sessionId, onGoalMutated);
                    return finalGoal
                        ? { outcome: 'turn-errored', turnsRun, finalGoal }
                        : { outcome: 'turn-errored', turnsRun };
                }
                // Turn aborted — codex `on_turn_abort` accounts progress but does
                // NOT block. The goal stays `active`: a user cancel leaves it idle
                // for the next kick, and the objective-edit steering immediately
                // restarts it with the new objective. Just exit this loop.
                if (lastStatus === 'aborted' || input.signal?.aborted) {
                    return { outcome: 'aborted', turnsRun };
                }
                // ask_user created a pending questionnaire and intentionally ended this
                // turn. Do not continue immediately; the questionnaire reply path will
                // inject the answer and kick the next turn when the session is idle.
                if (lastStatus === 'waiting_for_user') {
                    return { outcome: 'waiting-for-user', turnsRun };
                }
                // A safety retraction is terminal for this continuation loop even
                // though the ordinary session persists `finished`. Pause before
                // resolving so session-terminal listeners cannot observe an active
                // goal and immediately kick it again.
                if (lastStatus === 'retracted') {
                    const finalGoal = await onTurnRetracted?.(input.sessionId);
                    return finalGoal
                        ? { outcome: 'turn-retracted', turnsRun, finalGoal }
                        : { outcome: 'turn-retracted', turnsRun };
                }
                // Read the durable goal state AFTER each turn. User changes and any
                // host-settled model proposal are visible at this boundary.
                const goal = await store.getBySession(input.sessionId);
                if (!goal) {
                    return { outcome: 'no-active-goal', turnsRun, lastStatus };
                }
                if (!isContinuationStatus(goal.status)) {
                    return { outcome: 'goal-finalized', turnsRun, finalGoal: goal };
                }
                // Continuation: render the goal-aware prompt, mint a new turn id.
                promptText = await renderContinuation(goal);
                turnId = input.generateTurnId();
                isContinuation = true;
            }
        },
    };
}
async function pauseIfActiveAfterFailure(store, sessionId, onGoalMutated) {
    const goal = await store.getBySession(sessionId);
    if (!goal)
        return undefined;
    if (goal.status !== 'active')
        return goal;
    const paused = await store.patch(goal.goalId, {
        status: 'paused',
        statusReason: 'paused(infra_retryable)',
    });
    onGoalMutated?.(paused);
    return paused;
}
//# sourceMappingURL=orchestrator.js.map