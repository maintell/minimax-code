import { createHash } from 'node:crypto';
import { GOAL_CONFIG_DEFAULTS } from '@mavis/config';
import { runInImmediateTransaction } from '../persistence/db.js';
import { threadGoalStaleDecision } from './binding-stale.js';
import { rowToThreadGoalState } from './store-row.js';
import { materializeThreadGoalWorkerProposal } from './store-worker-proposal.js';
/** Persist one verifier verdict and its optional host decision in one short CAS transaction. */
export function recordThreadGoalVerification(db, nowMs, input) {
    return runInImmediateTransaction(db, () => {
        const state = readGoal(db, input.goalId);
        if (!state)
            return { status: 'stale', staleReason: 'missing_goal' };
        const stale = threadGoalStaleDecision(state, input);
        if (stale)
            return stale;
        const lastVerification = normalizeVerificationResult(state.lastVerification, input.result);
        const repeatedNotMetLimit = positiveIntegerOrDefault(input.repeatedNotMetLimit, GOAL_CONFIG_DEFAULTS.verifier.repeatedNotMetLimit);
        const repeatedGap = lastVerification.verdict === 'not_met' &&
            lastVerification.notMetStreak >= repeatedNotMetLimit;
        const decision = repeatedGap
            ? { status: 'paused', statusReason: 'paused(no_progress)' }
            : input.decision;
        const nextStatus = decision?.status ?? state.status;
        const nextStatusReason = decision?.statusReason ?? state.statusReason;
        const decisionEpoch = Math.max(nowMs(), input.expectedEpoch + 1);
        const workerProposal = materializeThreadGoalWorkerProposal(input.workerProposal, decisionEpoch);
        const result = db
            .prepare(`UPDATE local_runtime_thread_goals
         SET last_verification = ?, status = ?, status_reason = ?, updated_at_ms = ?,
             last_worker_proposal = COALESCE(?, last_worker_proposal)
         WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`)
            .run(JSON.stringify(lastVerification), nextStatus, nextStatusReason, decisionEpoch, workerProposal ? JSON.stringify(workerProposal) : null, input.goalId, input.expectedEpoch);
        if ((result.changes ?? 0) === 0) {
            return (threadGoalStaleDecision(readGoal(db, input.goalId), input) ?? {
                status: 'stale',
                staleReason: 'goal_status',
            });
        }
        return {
            status: 'settled',
            decisionEpoch,
            goal: {
                ...state,
                status: nextStatus,
                statusReason: nextStatusReason,
                lastVerification,
                ...(workerProposal ? { lastWorkerProposal: workerProposal } : {}),
                updatedAt: decisionEpoch,
                executionWait: null,
            },
        };
    });
}
function normalizeVerificationResult(previous, result) {
    const missing = normalizeMissing(result.missing);
    if (result.verdict !== 'not_met') {
        return {
            ...result,
            missing,
            missingFingerprint: undefined,
            notMetStreak: 0,
        };
    }
    const missingFingerprint = createHash('sha256').update(JSON.stringify(missing)).digest('hex');
    const notMetStreak = previous?.verdict === 'not_met' && previous.missingFingerprint === missingFingerprint
        ? previous.notMetStreak + 1
        : 1;
    return {
        ...result,
        missing,
        missingFingerprint,
        notMetStreak,
    };
}
function normalizeMissing(values) {
    return [
        ...new Set(values.map((value) => value.trim().replace(/\s+/g, ' ')).filter((value) => value.length > 0)),
    ].sort();
}
function readGoal(db, goalId) {
    const row = db
        .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
        .get(goalId);
    return rowToThreadGoalState(row);
}
function positiveIntegerOrDefault(value, fallback) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
//# sourceMappingURL=store-verification.js.map