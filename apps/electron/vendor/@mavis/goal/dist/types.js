/**
 * Thread Goal — codex-style atomic, per-session objective that survives
 * across multiple turns. The producer/verifier double-agent shape from
 * the previous GoalEngine v2 is intentionally NOT replicated here.
 *
 * Status semantics are host-owned — the asymmetry between
 * surfaces is the point:
 *
 *   - The MODEL (via `update_goal`) may propose `complete` or `blocked`, or on
 *     an explicit user turn request a guarded token-budget edit. The host owns
 *     durable settlement and mutation policy. A concurrent user change remains
 *     authoritative because budget writes compare the Goal decision epoch.
 *   - The USER (via the `/goal/*` REST surface) owns every transition
 *     except re-entry into `active` from a state whose budget or work is
 *     already spent: pause an `active` goal, stop it at any status,
 *     resume a `paused` / `blocked` / `usage_limited` one. Restoring
 *     `complete` or `budget_limited` to `active` is refused with 409
 *     (`GOAL_STATUS_CONFLICT` / `GOAL_BUDGET_LIMITED`) — see
 *     `TERMINAL_STATUSES` below for why. codex's external
 *     `set_thread_goal` has no transition guard; this surface does.
 *   - The SYSTEM (via bound accounting) may auto-transition `active` →
 *     `budget_limited` when `tokensUsed + delta >= tokenBudget`. Mirrors
 *     codex `accounting.rs` UPDATE that flips status atomically with the
 *     token bump.
 *
 * `complete` / `blocked` / `budget_limited` / `usage_limited` all stop the
 * auto-continuation loop. `/goal resume` only rescues `blocked` and
 * `usage_limited`. A separate explicit-user `update_goal` budget mutation may
 * atomically rearm `budget_limited(token)` when it raises the cap above
 * accounted usage or clears the cap; main-turn and active-time exhaustion are
 * not recoverable through a token edit. `complete` remains final.
 *
 * Persistence layout mirrors codex `thread_goals.thread_id PRIMARY KEY`:
 * at most one goal per session. `create_goal` replaces the previous
 * goal only when it is `complete` (codex `insert_thread_goal`'s
 * `ON CONFLICT … WHERE status = 'complete'`); anything else counts as
 * unfinished and the model gets an explicit rejection.
 */
export const THREAD_GOAL_STATUSES = [
    'active',
    'paused',
    'blocked',
    'complete',
    'budget_limited',
    'usage_limited',
];
export const THREAD_GOAL_VERIFICATIONS = ['none', 'evaluator', 'subagent'];
export const THREAD_GOAL_STATUS_REASONS = [
    'complete(worker_proposal)',
    'complete(verifier_met)',
    'complete(user_requested)',
    'paused(user_requested)',
    'paused(retracted)',
    'paused(infra_retryable)',
    'paused(accounting_unavailable)',
    'paused(verifier_unavailable)',
    'paused(route_unavailable)',
    // Verifier pauses are split by owner layer, not by adapter error: see
    // `verification-failure-reason.ts` for the code -> owner table.
    'paused(verifier_timeout)',
    'paused(verifier_protocol)',
    'paused(verifier_runtime)',
    'paused(verifier_budget)',
    'paused(verifier_capability)',
    'paused(verifier_aborted)',
    'paused(no_progress)',
    'paused(no_progress_after_completion_claim)',
    'blocked(worker_reported)',
    'blocked(safety_policy)',
    'blocked(verifier_impossible)',
    'budget_limited(token)',
    'budget_limited(main_turn)',
    'budget_limited(active_time)',
    'usage_limited(provider_quota)',
    'usage_limited(rate_limit)',
];
/**
 * Validate that an objective is non-empty and, when explicitly configured,
 * remains within the contract bound. Callers should trim before validating;
 * values are rejected, never truncated.
 */
export function validateThreadGoalObjective(value, maxChars) {
    if (value.length === 0) {
        return 'goal objective must not be empty';
    }
    if (maxChars !== undefined && value.length > maxChars) {
        return `goal objective must not exceed ${maxChars} characters`;
    }
    return null;
}
/**
 * The set of statuses that should trigger auto-continuation after a
 * turn ends. Only `active` continues; everything else freezes the loop.
 */
export const CONTINUATION_STATUSES = ['active'];
export function isContinuationStatus(status) {
    return CONTINUATION_STATUSES.includes(status);
}
/**
 * Why an `active` Goal cannot start its next Turn right now.
 *
 * This is deliberately NOT part of `ThreadGoalStatusReason`: `status` /
 * `statusReason` describe the Goal lifecycle (whether the system still owns
 * it), while a wait is an execution detail *inside* `active`. Folding the two
 * together would make every `status === 'active'` check carry a hidden
 * condition.
 *
 * Ordered by how directly the user can act on the blocker — admission reports
 * the first match, so a questionnaire the user can answer wins over a
 * background task they can only wait for.
 *
 * `verification` is the one reason admission never reports: it is written by
 * Turn settlement while it awaits the verifier, so it takes no part in the
 * blocker ordering above. It exists because a verifier dispatch can legitimately
 * run for minutes, during which the Goal is neither running a Turn nor idle,
 * and without it both clients render a Goal that looks stuck.
 */
export const THREAD_GOAL_WAIT_REASONS = [
    'questionnaire',
    'permission',
    'plan',
    'required_background',
    'automation_owner_conflict',
    'dependency_unavailable',
    'verification',
    'unknown',
];
/**
 * The set of statuses that stop the auto-continue loop once seen. Being in
 * this set says nothing about recoverability: the REST status surface resumes
 * a `blocked` or `usage_limited` goal back to `active`, but refuses that
 * transition for `complete` and `budget_limited`. The host's guarded token-
 * budget mutation is the sole exception for `budget_limited(token)`.
 */
export const TERMINAL_STATUSES = [
    'complete',
    'blocked',
    'budget_limited',
    'usage_limited',
];
export function isTerminalStatus(status) {
    return TERMINAL_STATUSES.includes(status);
}
//# sourceMappingURL=types.js.map