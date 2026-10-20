import { GoalAdmission } from './admission.js';
import { GoalBreaker } from './breaker.js';
import { GoalContinuation } from './continuation.js';
import { GoalDependencyGates } from './dependency-gates.js';
import { GoalLifecycle } from './lifecycle.js';
import { GoalSettlement } from './settlement.js';
import { GoalTimeAccounting } from './time-accounting.js';
import { GoalTurnContextRegistry } from './turn-context.js';
/** Compose cyclic host callbacks once while each domain module keeps a narrow dependency record. */
export function composeGoalHostModules(input) {
    const { deps } = input;
    const timeAccounting = new GoalTimeAccounting(deps.nowMs);
    const turnContext = new GoalTurnContextRegistry();
    const gates = new GoalDependencyGates({
        isSessionBusy: (sessionId) => deps.isSessionBusy?.(sessionId) ??
            deps.turnTimingReader.getBySession(sessionId) !== undefined,
        hasPendingQuestionnaire: deps.hasPendingQuestionnaire,
        hasPendingPermission: deps.hasPendingPermission,
        hasAutomationOwnerConflict: deps.hasAutomationOwnerConflict,
        hasRequiredBackgroundWork: deps.hasRequiredBackgroundWork,
        isGoalVerifierChildSession: deps.isGoalVerifierChildSession,
    }, { report: deps.reportFailure, format: deps.formatError });
    let lifecycle;
    let settlement;
    let continuation;
    const breaker = new GoalBreaker({
        store: input.getStore,
        configGetter: input.configGetter,
        nowMs: deps.nowMs,
        publishGlobalEvent: deps.publishGlobalEvent,
        emitRuntimeEvent: input.emitRuntimeEvent,
        emitStateTransition: input.emitStateTransition,
        reportFailure: deps.reportFailure,
        formatError: deps.formatError,
        armContinuationRearm: (goal) => continuation.armExplicitResetRearm(goal),
        drainContinuationRearm: (drainInput) => continuation.drainContinuationRearm(drainInput),
    });
    continuation = new GoalContinuation({
        store: input.getStore,
        timeAccounting,
        turnContext,
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
        },
    });
    const signalCollector = {
        collect: (context, signal) => turnContext.collectSignal(context.turnId, signal),
    };
    lifecycle = new GoalLifecycle({
        dataDir: deps.dataDir,
        sessionExists: deps.sessionExists,
        store: input.getStore,
        gates,
        timeAccounting,
        turnContext,
        turnTimingReader: deps.turnTimingReader,
        continuation,
        ...(deps.abortThreadGoalTurn ? { abortThreadGoalTurn: deps.abortThreadGoalTurn } : {}),
        signalCollector,
        runtime: {
            isEnabled: input.isEnabled,
            nowMs: deps.nowMs,
            publishGlobalEvent: deps.publishGlobalEvent,
            emitRuntimeEvent: input.emitRuntimeEvent,
            emitStateTransition: input.emitStateTransition,
            abortVerification: (sessionId, reason) => settlement.abortVerification(sessionId, reason),
            handleChanged: input.handleChanged,
            reportFailure: deps.reportFailure,
            formatError: deps.formatError,
        },
    });
    const admission = new GoalAdmission({
        store: input.getStore,
        turnContext,
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
    deps.turnTimingReader.onFinished(input.handleTurnTimingFinished);
    return { admission, continuation, lifecycle, settlement, turnContext };
}
//# sourceMappingURL=composition.js.map