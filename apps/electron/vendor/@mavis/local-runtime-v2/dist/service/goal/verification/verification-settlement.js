import {} from '@mavis/goal';
import { resolveThreadGoalBudgetLimits, threadGoalRepeatedNotMetLimit, } from '../lifecycle/gate.js';
import {} from './verification-context.js';
import { ThreadGoalVerificationDispatcher } from './verification-dispatch.js';
import { threadGoalInconclusiveTransition, threadGoalVerificationFailureTransition, } from './verification-failure-reason.js';
import { publishThreadGoalEvent } from '../observability/wiring.js';
import { emitThreadGoalWorkerProposalDecision, threadGoalWorkerProposalInput, } from '../settlement/worker-proposal.js';
/** Owns verifier dispatch/accounting while the Goal host retains final CAS authority. */
export class ThreadGoalVerificationSettlement {
    deps;
    dispatcher;
    constructor(deps) {
        this.deps = deps;
        this.dispatcher = new ThreadGoalVerificationDispatcher({
            store: deps.store,
            nowMs: deps.nowMs,
            configGetter: deps.configGetter,
            reportFailure: deps.reportFailure,
            formatError: deps.formatError,
            emitRuntimeEvent: deps.emitRuntimeEvent,
            loadObjectiveImages: deps.loadObjectiveImages,
            projectVerificationWait: (attempt) => this.publishExecutionWaitChange(attempt.sessionId, () => this.deps.store.setExecutionWaitAtEpoch({
                goalId: attempt.goalId,
                expectedUpdatedAt: attempt.goalUpdatedAt,
                reason: 'verification',
            })),
            clearVerificationWait: (attempt) => this.publishExecutionWaitChange(attempt.sessionId, () => this.deps.store.clearExecutionWaitAtEpoch({
                goalId: attempt.goalId,
                expectedUpdatedAt: attempt.goalUpdatedAt,
            })),
        });
    }
    bind(verifier, transcriptWindowReader) {
        this.dispatcher.bind(verifier, transcriptWindowReader);
    }
    async applyPolicy(context) {
        await this.dispatcher.applyPolicy(context);
    }
    /** Cancel any verification still running for this session (user stop, retraction, delete). */
    abortSession(sessionId, reason) {
        this.dispatcher.abortSession(sessionId, reason);
    }
    async accountAndRecord(context) {
        if (context.verificationPreDispatchStale)
            return context.verificationPreDispatchStale;
        if (context.verificationAlreadyRecorded)
            return alreadyRecordedDecision(context.goal);
        const attempt = context.verificationAttempt;
        const outcome = context.verificationOutcome;
        if (!attempt || !outcome)
            return undefined;
        recordUsageObservation(context, outcome.type === 'result' ? outcome.result.usage : outcome.error.usage);
        if (outcome.type === 'failure') {
            context.proposedTransition = threadGoalVerificationFailureTransition(outcome.error.code);
            return undefined;
        }
        const result = normalizeVerificationResult(outcome.result);
        context.verificationOutcome = { type: 'result', result };
        return this.recordResult(context, result);
    }
    /**
     * Charge subagent-verifier spend against the Goal budget.
     *
     * The subagent verifier is a real child agent, so its tokens draw down the
     * same budget the worker draws from; evaluator-backend verification stays
     * report-only. Ordering is deliberate: the verdict CAS in
     * `accountAndRecord` runs first, so a Goal the verifier judged `met`
     * completes before this charge can trip `budget_limited` — the charge gates
     * only future work. The bump therefore expects `context.goal.updatedAt`
     * (the epoch after the verdict recorded), not the admission epoch: a
     * mismatch means a foreign decision raced us, and stale usage is still
     * written but never converted into a decision.
     */
    async chargeVerifierUsage(context) {
        if (context.verificationAttempt?.backend !== 'subagent')
            return undefined;
        const reported = context.verificationUsageAccounting?.reportedTokens ?? 0;
        if (reported <= 0)
            return undefined;
        // A full-usage Goal was already charged every verifier request as a
        // sub-session round, four parts per attempt; charging the reported total
        // again would count it twice. Only the budget decision remains.
        const tokens = context.goal.tokenUsage ? 0 : reported;
        const result = await this.bumpVerifierUsage(context, tokens);
        if (!result)
            return undefined;
        if (result.goal) {
            publishThreadGoalEvent(this.deps.publishGlobalEvent, { type: 'updated', goal: result.goal });
        }
        this.emitBudgetDecided(result);
        if (result.staleReason || !result.goal)
            return undefined;
        context.goal = result.goal;
        return result.transitioned ? this.limitAfterVerifierCharge(context, result.goal) : undefined;
    }
    async limitAfterVerifierCharge(context, goal) {
        if (context.verificationOutcome?.type === 'failure') {
            this.emitDecision(context, 'budget_limited');
        }
        return {
            stage: 7,
            action: 'budget_limited',
            reason: goal.statusReason ?? 'budget_limited',
            goalId: goal.goalId,
            decisionEpoch: goal.updatedAt,
        };
    }
    async bumpVerifierUsage(context, tokens) {
        try {
            return await this.deps.store.bumpBoundUsage({
                ...context.accounting.boundTurn.binding,
                admittedGoalUpdatedAt: context.goal.updatedAt,
            }, { tokens, activeSeconds: 0, mainTurns: 0 }, resolveThreadGoalBudgetLimits(context.goal, this.deps.configGetter));
        }
        catch (error) {
            this.report(context, 'thread_goal_verifier_charge_failed', error);
            return undefined;
        }
    }
    emitBudgetDecided(result) {
        if (!result.transitioned || !result.goal)
            return;
        this.deps.emitRuntimeEvent({
            type: 'goal.budget_decided',
            at: this.deps.nowMs(),
            payload: {
                goalId: result.goal.goalId,
                sessionId: result.goal.sessionId,
                decision: 'limited',
                dimension: result.transitioned,
                tokensUsed: result.goal.tokensUsed,
                turnsUsed: result.goal.turnsUsed,
                activeSeconds: result.goal.timeUsedSeconds,
            },
        });
        this.deps.emitStateTransition('active', result.goal);
    }
    emitDecision(context, disposition, acceptedResult, acceptedVerification) {
        const attempt = context.verificationAttempt;
        const outcome = context.verificationOutcome;
        const usage = context.verificationUsageAccounting;
        if (!attempt || !outcome || !usage)
            return;
        const result = acceptedResult ??
            (outcome.type === 'result' ? normalizeVerificationResult(outcome.result) : undefined);
        this.deps.emitRuntimeEvent({
            type: 'goal.verification_decided',
            at: this.deps.nowMs(),
            payload: {
                goalId: attempt.goalId,
                sessionId: attempt.sessionId,
                turnId: attempt.turnId,
                backend: attempt.backend,
                source: 'verifier',
                verdict: result?.verdict.verdict ?? 'inconclusive',
                disposition,
                ...(outcome.type === 'failure' ? { failureCode: outcome.error.code } : {}),
                ...verificationUsageFields(usage),
                ...verificationTraceFields(outcome),
                reasonPresent: Boolean(acceptedVerification?.reason.trim() ?? result?.verdict.reason.trim()),
                missingCount: verificationMissingCount(acceptedVerification, result),
                ...acceptedVerificationFields(acceptedVerification),
            },
        });
    }
    async recordResult(context, result) {
        let recorded;
        const workerProposal = threadGoalWorkerProposalInput(context.signal, context.input.turnId);
        try {
            recorded = await this.deps.store.recordVerification({
                goalId: context.goal.goalId,
                expectedEpoch: context.goal.updatedAt,
                objectiveDigest: context.accounting.boundTurn.binding.objectiveDigest,
                result: lastVerification(context, this.deps.nowMs(), result),
                repeatedNotMetLimit: threadGoalRepeatedNotMetLimit(this.deps.configGetter),
                ...(workerProposal ? { workerProposal } : {}),
                ...(verificationTransition(result) ? { decision: verificationTransition(result) } : {}),
            });
        }
        catch (error) {
            this.report(context, 'thread_goal_verification_record_failed', error);
            throw error;
        }
        if (recorded.status === 'stale') {
            this.emitDecision(context, 'stale', result);
            emitThreadGoalWorkerProposalDecision({
                signal: context.signal,
                sessionId: context.input.sessionId,
                turnId: context.input.turnId,
                result: recorded,
                at: this.deps.nowMs(),
                emit: this.deps.emitRuntimeEvent,
            });
            return {
                stage: 7,
                action: 'stale',
                reason: recorded.staleReason,
                ...(recorded.goal ? { goalId: recorded.goal.goalId } : {}),
            };
        }
        this.deps.emitStateTransition(context.goal.status, recorded.goal);
        publishThreadGoalEvent(this.deps.publishGlobalEvent, { type: 'updated', goal: recorded.goal });
        this.emitDecision(context, 'accepted', result, recorded.goal.lastVerification);
        emitThreadGoalWorkerProposalDecision({
            signal: context.signal,
            sessionId: context.input.sessionId,
            turnId: context.input.turnId,
            result: recorded,
            at: this.deps.nowMs(),
            emit: this.deps.emitRuntimeEvent,
        });
        context.goal = recorded.goal;
        if (recorded.goal.status === 'active')
            return undefined;
        return {
            stage: 7,
            action: 'settled',
            reason: recorded.goal.statusReason ?? `verification(${result.verdict.verdict})`,
            goalId: recorded.goal.goalId,
            decisionEpoch: recorded.decisionEpoch,
        };
    }
    report(context, code, error) {
        this.deps.reportFailure(context.input.sessionId, `${code}:${this.deps.formatError(error)}`);
    }
    /**
     * Mirror of the admission-side projection publisher.
     *
     * The store returns `undefined` whenever nothing changed — a superseded
     * epoch, a wait that is already absent, or the same reason re-observed — so
     * no redundant event is published and the user-visible wait timer keeps
     * counting from its original `sinceMs`.
     */
    async publishExecutionWaitChange(sessionId, write) {
        try {
            const updated = await write();
            if (!updated)
                return;
            publishThreadGoalEvent(this.deps.publishGlobalEvent, { type: 'updated', goal: updated });
        }
        catch (error) {
            // The wait projection explains a dispatch; it must never fail one.
            this.deps.reportFailure(sessionId, `thread_goal_execution_wait_projection_failed:${this.deps.formatError(error)}`);
        }
    }
}
/**
 * Record what verification cost as an observation on the settlement context.
 *
 * No write happens here: `goal.verification_decided` reports these numbers,
 * and `ThreadGoalVerificationSettlement.chargeVerifierUsage` charges the subagent-backend
 * portion against the Goal budget after the verdict records. An incomplete
 * sample gets no pessimistic estimate — the gap stays observable instead.
 */
function recordUsageObservation(context, usage) {
    context.verificationUsageAccounting = {
        reportedTokens: validReportedTokens(usage.tokens),
        activeSeconds: sanitizeCounter(usage.activeSeconds),
        incomplete: usage.incomplete || usage.tokens === null,
        ...(usage.childTurns === undefined ? {} : { childTurns: sanitizeCounter(usage.childTurns) }),
    };
}
export function normalizeVerificationResult(result) {
    const verdict = normalizedVerdict(result.verdict);
    return verdict
        ? { ...result, verdict }
        : {
            ...result,
            verdict: {
                verdict: 'inconclusive',
                reason: 'Verifier returned an invalid or incomplete verdict payload.',
                code: 'schema_error',
            },
        };
}
/** The trimmed verdict, or undefined when a required field is empty. */
function normalizedVerdict(verdict) {
    const reason = verdict.reason.trim();
    if (!reason)
        return undefined;
    switch (verdict.verdict) {
        case 'met':
            return { ...verdict, reason };
        case 'not_met': {
            const missing = verdict.missing.map((item) => item.trim()).filter(Boolean);
            return missing.length > 0 ? { ...verdict, reason, missing } : undefined;
        }
        case 'impossible': {
            const blocker = verdict.blocker.trim();
            return blocker ? { ...verdict, reason, blocker } : undefined;
        }
        case 'inconclusive': {
            const code = verdict.code.trim();
            return code ? { ...verdict, reason, code } : undefined;
        }
        default:
            return undefined;
    }
}
function verificationUsageFields(usage) {
    return {
        reportedTokens: usage.reportedTokens,
        ...(usage.incomplete ? { usageIncomplete: true } : {}),
        activeSeconds: usage.activeSeconds,
        ...(usage.childTurns === undefined ? {} : { childTurns: usage.childTurns }),
    };
}
function verificationTraceFields(outcome) {
    const traceRef = outcome.type === 'result' ? outcome.result.traceRef : outcome.error.traceRef;
    if (!traceRef)
        return {};
    return {
        childSessionId: traceRef.sessionId,
        ...(traceRef.turnId ? { childTurnId: traceRef.turnId } : {}),
    };
}
function acceptedVerificationFields(acceptedVerification) {
    if (!acceptedVerification)
        return {};
    return {
        ...(acceptedVerification.missingFingerprint
            ? { missingFingerprint: acceptedVerification.missingFingerprint }
            : {}),
        notMetStreak: acceptedVerification.notMetStreak,
    };
}
function verificationMissingCount(acceptedVerification, result) {
    if (acceptedVerification?.verdict === 'not_met')
        return acceptedVerification.missing.length;
    return result?.verdict.verdict === 'not_met' ? result.verdict.missing.length : 0;
}
function alreadyRecordedDecision(goal) {
    if (goal.status === 'active')
        return undefined;
    return {
        stage: 7,
        action: goal.status === 'budget_limited' ? 'budget_limited' : 'settled',
        reason: goal.statusReason ?? 'verification_already_recorded',
        goalId: goal.goalId,
        decisionEpoch: goal.updatedAt,
    };
}
function lastVerification(context, at, result) {
    const verdict = result.verdict;
    return {
        v: 1,
        backend: result.backend,
        verdict: verdict.verdict,
        reason: verdict.reason,
        missing: verdict.verdict === 'not_met' ? verdict.missing : [],
        notMetStreak: 0,
        turnId: context.input.turnId,
        objectiveDigest: context.accounting.boundTurn.binding.objectiveDigest,
        at,
    };
}
function verificationTransition(result) {
    switch (result.verdict.verdict) {
        case 'met':
            return { status: 'complete', statusReason: 'complete(verifier_met)' };
        case 'impossible':
            return { status: 'blocked', statusReason: 'blocked(verifier_impossible)' };
        case 'inconclusive':
            return threadGoalInconclusiveTransition(result.verdict.code);
        case 'not_met':
            return undefined;
    }
}
function validReportedTokens(tokens) {
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
        ? Math.floor(tokens)
        : null;
}
function sanitizeCounter(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
//# sourceMappingURL=verification-settlement.js.map