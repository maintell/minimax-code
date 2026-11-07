import { compareThreadGoalReplyFingerprints, } from '@mavis/goal';
import { and, eq } from 'drizzle-orm';
import { localRuntimeV2Goals as goals } from '../../../infra/db/schema/goal.js';
import { readGoalRow } from './store-row.js';
/**
 * Both breaker conditions share one occurrence ladder: the first observation is
 * only recorded, the second nudges, and the configured limit pauses. `limit` is
 * expressed as a total count of observations, so a limit of 3 pauses on the
 * third one.
 */
function decideAction(occurrences, limit) {
    if (occurrences >= limit)
        return 'pause';
    return occurrences >= 2 ? 'nudge' : 'none';
}
/**
 * Extra observations allowed before pausing on the polling signals: a Turn
 * that only repeated read-only tool calls, and a reply that repeats once its
 * numbers are ignored. Both are weaker evidence than a Turn with no tool at
 * all or a reply repeated word for word, so with the default limit of 3 they
 * pause on the fifth observation instead of the third.
 */
const POLLING_EXTRA_OCCURRENCES = 2;
function strongerAction(left, right) {
    if (left === 'pause' || right === 'pause')
        return 'pause';
    if (left === 'nudge' || right === 'nudge')
        return 'nudge';
    return 'none';
}
/**
 * Apply the repeated-reply and no-tool decisions plus an optional pause in one
 * short transaction.
 *
 * The two counters are independent: an identical reply never increments the
 * no-tool streak and a tool-less turn never increments the repeated-reply
 * streak. They only share the configured limit and the `paused(no_progress)`
 * outcome.
 */
export function updateThreadGoalBreaker(db, nowMs, goalId, input) {
    const state = readGoalRow(db, eq(goals.goalId, goalId));
    if (!state)
        return { action: 'stale', staleReason: 'missing_goal' };
    const decision = decideBreaker(state, input);
    if (decision.unchanged) {
        // Nothing to persist, so skip the write and leave the decision epoch
        // alone. The caller's epoch is still validated here: returning a newer
        // epoch would let this settled Turn commit a terminal proposal on top of
        // a concurrent user PATCH that should have invalidated it.
        if (state.updatedAt !== input.expectedEpoch) {
            return { action: 'stale', staleReason: 'goal_epoch', goal: state };
        }
        if (state.status !== 'active') {
            return { action: 'stale', staleReason: 'goal_status', goal: state };
        }
        return { action: 'none', epoch: state.updatedAt, goal: state };
    }
    const pauses = decision.action === 'pause';
    const nextStatus = pauses ? 'paused' : state.status;
    const nextStatusReason = pauses
        ? (input.pauseReason ?? 'paused(no_progress)')
        : state.statusReason;
    const nextEpoch = Math.max(nowMs(), state.updatedAt + 1);
    const result = db
        .update(goals)
        .set({
        replyFingerprint: decision.fingerprint,
        noProgressStreak: decision.replyStreak,
        noToolStreak: decision.noToolStreak,
        status: nextStatus,
        statusReason: nextStatusReason,
        updatedAtMs: nextEpoch,
    })
        .where(and(eq(goals.goalId, goalId), eq(goals.updatedAtMs, input.expectedEpoch), eq(goals.status, 'active')))
        .run();
    if (result.changes === 0)
        return staleBreakerResult(db, goalId, input.expectedEpoch);
    return {
        action: decision.action,
        epoch: nextEpoch,
        ...(decision.cause ? { cause: decision.cause } : {}),
        goal: {
            ...state,
            status: nextStatus,
            statusReason: nextStatusReason,
            replyFingerprint: decision.fingerprint,
            noProgressStreak: decision.replyStreak,
            noToolStreak: decision.noToolStreak,
            updatedAt: nextEpoch,
            executionWait: null,
        },
    };
}
function decideBreaker(state, input) {
    const occurrenceLimit = Number.isFinite(input.limit) ? Math.max(2, Math.floor(input.limit)) : 2;
    const reply = decideRepeatedReply(state, input, occurrenceLimit);
    // No-tool condition: a Turn without new tool progress, either no call at all
    // or only read-only calls that repeated recent ones. A `rerun` may have
    // changed something with the same output, so it resets like real work.
    // `unknown` is an observation gap, not a trustworthy zero: it resets so a gap
    // can never be stitched into a consecutive run.
    const noNewToolWork = input.toolActivity === 'absent' || input.toolActivity === 'repeated';
    const noToolStreak = noNewToolWork ? state.noToolStreak + 1 : 0;
    // The limit follows the current Turn: a run that reaches its pause through a
    // repeated read-only call waits for the polling limit.
    const noToolLimit = input.toolActivity === 'repeated'
        ? occurrenceLimit + POLLING_EXTRA_OCCURRENCES
        : occurrenceLimit;
    const noToolAction = noNewToolWork
        ? decideAction(noToolStreak, noToolLimit)
        : 'none';
    const action = strongerAction(reply.action, noToolAction);
    return {
        action,
        cause: breakerCause(action, reply.action, input.toolActivity),
        fingerprint: reply.fingerprint,
        replyStreak: reply.streak,
        noToolStreak,
        unchanged: action === 'none' &&
            reply.fingerprint === state.replyFingerprint &&
            reply.streak === state.noProgressStreak &&
            noToolStreak === state.noToolStreak,
    };
}
/**
 * Repeated-reply condition. A Turn without usable reply text carries no
 * fingerprint evidence at all, so it leaves both the stored fingerprint and its
 * streak exactly as they were instead of clearing them.
 *
 * A reply that repeats only once its numbers are ignored may still report
 * work that advances ("batch 3 of 10" → "batch 4"), so it extends the run only
 * on a Turn known to have made no new tool progress (`repeated` or `absent`).
 * A reply repeated word for word extends it regardless.
 */
function decideRepeatedReply(state, input, occurrenceLimit) {
    if (input.fingerprint === null) {
        return { action: 'none', fingerprint: state.replyFingerprint, streak: state.noProgressStreak };
    }
    const match = compareThreadGoalReplyFingerprints(state.replyFingerprint, input.fingerprint);
    // A reply that only moved its numbers may be work reported by count. It
    // extends the run only when the Turn is known to have made no new tool
    // progress; after new work or a rerun that may have written something it
    // starts a new run, so the streak never mixes it into a word-for-word repeat.
    const knownIdle = input.toolActivity === 'repeated' || input.toolActivity === 'absent';
    if (match === 'different' || (match === 'numbers_only' && !knownIdle)) {
        return { action: 'none', fingerprint: input.fingerprint, streak: 0 };
    }
    const streak = state.noProgressStreak + 1;
    // noProgressStreak intentionally stores repeats *after* the first reply,
    // while repeatedReplyLimit is expressed as total identical replies. Add the
    // baseline back before comparing so a limit of 3 pauses on reply 3, not on
    // the third repeat (reply 4). A reply that only moved its numbers waits for
    // the polling limit.
    const limit = match === 'numbers_only' ? occurrenceLimit + POLLING_EXTRA_OCCURRENCES : occurrenceLimit;
    return {
        action: decideAction(streak + 1, limit),
        fingerprint: input.fingerprint,
        streak,
    };
}
function breakerCause(action, replyAction, toolActivity) {
    if (action === 'none')
        return undefined;
    if (replyAction === action)
        return 'repeated_reply';
    return toolActivity === 'repeated' ? 'repeated_tool' : 'no_tool';
}
function staleBreakerResult(db, goalId, expectedEpoch) {
    const current = readGoalRow(db, eq(goals.goalId, goalId));
    if (!current)
        return { action: 'stale', staleReason: 'missing_goal' };
    if (current.updatedAt !== expectedEpoch) {
        return { action: 'stale', staleReason: 'goal_epoch', goal: current };
    }
    return { action: 'stale', staleReason: 'goal_status', goal: current };
}
//# sourceMappingURL=store-breaker.js.map