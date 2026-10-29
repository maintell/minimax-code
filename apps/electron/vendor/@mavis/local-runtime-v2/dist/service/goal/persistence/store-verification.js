import { createHash } from 'node:crypto';
import {} from '@mavis/goal';
import { GOAL_CONFIG_DEFAULTS } from '@mavis/config';
import { and, eq } from 'drizzle-orm';
import { localRuntimeV2Goals as goals } from '../../../infra/db/schema/goal.js';
import { threadGoalStaleDecision } from './binding-stale.js';
import { readGoalRow } from './store-row.js';
import { materializeThreadGoalWorkerProposal } from './store-worker-proposal.js';
/** Persist one verifier verdict and its optional host decision in one short CAS transaction. */
export function recordThreadGoalVerification(db, nowMs, input) {
    const state = readGoal(db, input.goalId);
    if (!state)
        return { status: 'stale', staleReason: 'missing_goal' };
    const stale = threadGoalStaleDecision(state, input);
    if (stale)
        return stale;
    const lastVerification = normalizeVerificationResult(state.lastVerification, input.result);
    const decision = verificationDecision(lastVerification, input);
    const nextStatus = decision?.status ?? state.status;
    const nextStatusReason = decision?.statusReason ?? state.statusReason;
    const decisionEpoch = Math.max(nowMs(), input.expectedEpoch + 1);
    const workerProposal = materializeThreadGoalWorkerProposal(input.workerProposal, decisionEpoch);
    const result = db
        .update(goals)
        .set({
        lastVerification: JSON.stringify(lastVerification),
        status: nextStatus,
        statusReason: nextStatusReason,
        updatedAtMs: decisionEpoch,
        ...(workerProposal ? { lastWorkerProposal: JSON.stringify(workerProposal) } : {}),
    })
        .where(and(eq(goals.goalId, input.goalId), eq(goals.updatedAtMs, input.expectedEpoch), eq(goals.status, 'active')))
        .run();
    if (result.changes === 0) {
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
}
/** A repeated identical gap overrides the verifier-owned decision with a no-progress pause. */
function verificationDecision(lastVerification, input) {
    const repeatedNotMetLimit = positiveIntegerOrDefault(input.repeatedNotMetLimit, GOAL_CONFIG_DEFAULTS.verifier.repeatedNotMetLimit);
    const repeatedGap = lastVerification.verdict === 'not_met' && lastVerification.notMetStreak >= repeatedNotMetLimit;
    return repeatedGap ? { status: 'paused', statusReason: 'paused(no_progress)' } : input.decision;
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
    return readGoalRow(db, eq(goals.goalId, goalId));
}
function positiveIntegerOrDefault(value, fallback) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
//# sourceMappingURL=store-verification.js.map