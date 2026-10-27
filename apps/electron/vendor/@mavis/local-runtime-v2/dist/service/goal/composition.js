import { GoalRequestAccounting } from './accounting/request-accounting.js';
import { GoalTokenCharging } from './accounting/token-charging.js';
import { GoalAdmission } from './admission/admission.js';
import { GoalBreaker } from './breaker/breaker.js';
import { GoalContinuation } from './continuation/continuation.js';
import { GoalDependencyGates } from './admission/dependency-gates.js';
import { GoalLifecycle } from './lifecycle/lifecycle.js';
import { GoalResumeOutcomes } from './lifecycle/resume.js';
import { GoalUsageRecoveryRetention } from './lifecycle/usage-recovery-retention.js';
import { GoalSettlement } from './settlement/settlement.js';
import { GoalTimeAccounting } from './settlement/time-accounting.js';
import { GoalTurnContextRegistry } from './admission/turn-context.js';
import { GoalTurnHistory } from './admission/goal-turn-history.js';
import { GoalUsageRecoveryScheduler } from './continuation/usage-recovery-scheduler.js';
import { publishThreadGoalEvent } from './observability/wiring.js';
/** Compose cyclic host callbacks once while each domain module keeps a narrow dependency record. */
export function composeGoalHostModules(input) {
    const { deps } = input;
    const timeAccounting = new GoalTimeAccounting(deps.nowMs);
    const turnContext = new GoalTurnContextRegistry();
    const turnHistory = new GoalTurnHistory();
    const usageRecoveryRetention = new GoalUsageRecoveryRetention(deps.nowMs);
    const gates = new GoalDependencyGates({
        isSessionBusy: (sessionId) => deps.isSessionBusy?.(sessionId) ??
            deps.turnTimingReader.getBySession(sessionId) !== undefined,
        hasPendingQuestionnaire: deps.hasPendingQuestionnaire,
        hasPendingPermission: deps.hasPendingPermission,
        hasAutomationOwnerConflict: deps.hasAutomationOwnerConflict,
        listUnfinishedBackgroundTasks: deps.listUnfinishedBackgroundTasks,
        isGoalTurn: (goalId, turnId) => turnHistory.has(goalId, turnId),
        isGoalVerifierChildSession: deps.isGoalVerifierChildSession,
    }, { report: deps.reportFailure, format: deps.formatError });
    let lifecycle;
    let settlement;
    let continuation;
    // Automatic account-quota recovery ends by handing the resumed Goal to the
    // same `handleChanged` path a manual resume uses, so the "how does a Goal get
    // its next Turn" decision keeps exactly one owner.
    const usageRecovery = new GoalUsageRecoveryScheduler({
        store: input.getStore,
        nowMs: deps.nowMs,
        onResumed: (goal) => lifecycle.landUsageRecoveryResume(goal),
        reportFailure: deps.reportFailure,
        formatError: deps.formatError,
    });
    const breaker = new GoalBreaker({
        store: input.getStore,
        configGetter: input.configGetter,
        nowMs: deps.nowMs,
        publishGlobalEvent: deps.publishGlobalEvent,
        emitRuntimeEvent: input.emitRuntimeEvent,
        emitStateTransition: input.emitStateTransition,
        reportFailure: deps.reportFailure,
        formatError: deps.formatError,
        carryUsageRecovery: (goalId, fromEpoch, toEpoch) => usageRecoveryRetention.carry(goalId, fromEpoch, toEpoch),
        armContinuationRearm: (goal) => continuation.armExplicitResetRearm(goal),
        drainContinuationRearm: (drainInput) => continuation.drainContinuationRearm(drainInput),
    });
    continuation = new GoalContinuation({
        store: input.getStore,
        timeAccounting,
        turnContext,
        turnHistory,
        gates,
        turnTimingReader: deps.turnTimingReader,
        promptSnapshots: deps.promptSnapshots,
        internalTurnPromptReads: deps.internalTurnPromptReads,
        runtime: {
            isEnabled: input.isEnabled,
            nowMs: deps.nowMs,
            publishGlobalEvent: deps.publishGlobalEvent,
            emitRuntimeEvent: input.emitRuntimeEvent,
            abortVerification: (sessionId, reason) => settlement.abortVerification(sessionId, reason),
        },
        external: {
            startContinuationTurn: deps.startContinuationTurn,
            ...(deps.steerContinuationTurn ? { steerContinuationTurn: deps.steerContinuationTurn } : {}),
            ...(deps.enqueuePostTurnContinuation
                ? { enqueuePostTurnContinuation: deps.enqueuePostTurnContinuation }
                : {}),
            enqueueInitialContinuationTurn: deps.enqueueInitialContinuationTurn,
            hasPendingInitialContinuation: deps.hasPendingInitialContinuation,
            cancelInitialContinuation: deps.cancelInitialContinuation,
            requestQueueDispatch: deps.requestQueueDispatch,
            retireGoalQuestionnaire: deps.retireGoalQuestionnaire,
            ...(deps.settleOverdueGoalQuestionnaire
                ? { settleOverdueGoalQuestionnaire: deps.settleOverdueGoalQuestionnaire }
                : {}),
            pauseActiveGoalForRetraction: (sessionId) => lifecycle.pauseActiveGoalForRetraction(sessionId),
            reportFailure: deps.reportFailure,
            formatError: deps.formatError,
        },
    });
    settlement = new GoalSettlement({
        store: input.getStore,
        turnTimingReader: deps.turnTimingReader,
        turnContext,
        timeAccounting,
        gates,
        breaker,
        continuation,
        runtime: {
            isEnabled: input.isEnabled,
            nowMs: deps.nowMs,
            configGetter: input.configGetter,
            publishGlobalEvent: deps.publishGlobalEvent,
            emitRuntimeEvent: input.emitRuntimeEvent,
            emitStateTransition: input.emitStateTransition,
            reportFailure: deps.reportFailure,
            formatError: deps.formatError,
            syncUsageRecovery: (goal) => usageRecovery.sync(goal),
            loadObjectiveImages: deps.loadObjectiveImages,
            // A fresh trusted reset time from this Turn's own error wins; otherwise a
            // failed manual resume falls back to the schedule it interrupted.
            readUsageRecoveryHint: (turnId) => deps.readUsageRecoveryHint?.(turnId) ??
                usageRecoveryRetention.read(turnContext.getBinding(turnId)?.binding),
        },
    });
    const signalCollector = {
        collect: (context, signal) => turnContext.collectSignal(context.turnId, signal),
    };
    lifecycle = new GoalLifecycle({
        objectiveAssets: deps.objectiveAssets,
        sessionExists: deps.sessionExists,
        store: input.getStore,
        gates,
        timeAccounting,
        turnContext,
        turnTimingReader: deps.turnTimingReader,
        continuation,
        usageRecoveryRetention,
        resumes: new GoalResumeOutcomes({
            store: input.getStore,
            turnHistory,
            turnContext,
            turnTimingReader: deps.turnTimingReader,
            emitStateTransition: input.emitStateTransition,
            handleChanged: input.handleChanged,
        }),
        ...(deps.abortThreadGoalTurn ? { abortThreadGoalTurn: deps.abortThreadGoalTurn } : {}),
        ...(deps.endStoppedQueuePause ? { endStoppedQueuePause: deps.endStoppedQueuePause } : {}),
        ...(deps.releaseFailedTurnPause ? { releaseFailedTurnPause: deps.releaseFailedTurnPause } : {}),
        signalCollector,
        runtime: {
            isEnabled: input.isEnabled,
            nowMs: deps.nowMs,
            publishGlobalEvent: deps.publishGlobalEvent,
            emitRuntimeEvent: input.emitRuntimeEvent,
            emitStateTransition: input.emitStateTransition,
            abortVerification: (sessionId, reason) => settlement.abortVerification(sessionId, reason),
            handleChanged: input.handleChanged,
            applyChange: input.applyChange,
            reportFailure: deps.reportFailure,
            formatError: deps.formatError,
        },
    });
    const admission = new GoalAdmission({
        store: input.getStore,
        turnContext,
        turnHistory,
        gates,
        turnTimingReader: deps.turnTimingReader,
        configGetter: input.configGetter,
        events: {
            nowMs: deps.nowMs,
            publishGlobalEvent: deps.publishGlobalEvent,
            emitRuntimeEvent: input.emitRuntimeEvent,
            emitStateTransition: input.emitStateTransition,
        },
        failures: { report: deps.reportFailure, format: deps.formatError },
        prepareExplicitUserBreakerReset: (resetInput) => breaker.prepareExplicitUserReset(resetInput),
    });
    const accounting = new GoalRequestAccounting({
        store: input.getStore,
        turnContext,
        configGetter: input.configGetter,
        publishGoal: (goal) => publishThreadGoalEvent(deps.publishGlobalEvent, { type: 'updated', goal }),
        emitRuntimeEvent: input.emitRuntimeEvent,
        nowMs: deps.nowMs,
    });
    const tokenCharging = new GoalTokenCharging({
        store: input.getStore,
        turnContext,
        turnHistory,
        isEnabled: input.isEnabled,
        publishGoal: (goal) => publishThreadGoalEvent(deps.publishGlobalEvent, { type: 'updated', goal }),
    });
    deps.turnTimingReader.onFinished(input.handleTurnTimingFinished);
    return {
        accounting,
        tokenCharging,
        admission,
        continuation,
        lifecycle,
        settlement,
        turnContext,
        usageRecovery,
    };
}
//# sourceMappingURL=composition.js.map