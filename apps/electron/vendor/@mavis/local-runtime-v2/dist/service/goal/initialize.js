import { logger } from '../../infra/logging/index.js';
import { LocalThreadGoalKickoffQueue, } from './continuation/kickoff-host.js';
import { createGoalConversationPorts } from './execution/conversation-ports.js';
import { DeferredGoalConversation } from './execution/deferred-conversation.js';
import { createFailedTurnPauseRelease, createStoppedQueueContinuation, } from './execution/stopped-queue.js';
import { createGoalTurnLifecycle } from './execution/turn-lifecycle.js';
import { ThreadGoalUsageRecoveryHints } from './execution/usage-recovery-hint.js';
import { GoalService } from './goal.service.js';
import { createThreadGoalObservabilityEventSink } from './observability/runtime-event-sink.js';
import { DrizzleGoalStore } from './persistence/store.js';
import { GoalQuestionnairePolicy } from './questionnaire/goal-questionnaire-policy.js';
import { LocalActiveTurnTimingRegistry } from './settlement/turn-timing.js';
import { createLocalGoalVerifierExecution, } from './verification/verifier-execution.js';
export function initializeGoalService(input) {
    const { host } = input;
    const store = new DrizzleGoalStore(input.db, input.nowMs);
    const turnTimings = new LocalActiveTurnTimingRegistry(input.nowMs);
    const usageRecoveryHints = new ThreadGoalUsageRecoveryHints(input.nowMs);
    const questionnairePolicy = new GoalQuestionnairePolicy({
        questionnaires: host.questionnaires,
        readGoal: (sessionId) => store.getBySession(sessionId),
        isActiveGoal: (sessionId, goalId) => store.isActiveGoal(sessionId, goalId),
        nowMs: input.nowMs,
    });
    const conversation = new DeferredGoalConversation();
    const requireConversation = () => conversation.port;
    let service;
    const requireService = () => {
        if (!service)
            throw new Error('Goal service is not initialized');
        return service;
    };
    const kickoffQueue = new LocalThreadGoalKickoffQueue({
        conversation: conversation.port,
        getIntegration: requireService,
        ...(input.legacyQueueItems ? { legacyQueueItems: input.legacyQueueItems } : {}),
        reportFailure: input.reportFailure,
        reportRecoveryFailure: (error) => logger.warn({ error }, 'Thread Goal kickoff recovery failed'),
    });
    service = new GoalService({
        nowMs: input.nowMs,
        turnTimingReader: turnTimings,
        publishGlobalEvent: input.publishGlobalEvent,
        ...(host.promptSnapshots ? { promptSnapshots: host.promptSnapshots } : {}),
        ...(host.internalTurnPromptReads
            ? { internalTurnPromptReads: host.internalTurnPromptReads }
            : {}),
        objectiveAssets: host.objectiveAssets,
        loadObjectiveImages: host.loadObjectiveImages,
        hasPendingQuestionnaire: (sessionId, expectedGoalId) => expectedGoalId
            ? questionnairePolicy.blocksContinuation(sessionId, expectedGoalId)
            : host.hasUnresolvedQuestionnaire(sessionId),
        retireGoalQuestionnaire: (sessionId, goalId) => questionnairePolicy.retire(sessionId, goalId),
        settleOverdueGoalQuestionnaire: (sessionId, goalId) => questionnairePolicy.settleOverdue(sessionId, goalId),
        hasPendingPermission: host.hasPendingPermission,
        hasAutomationOwnerConflict: host.hasAutomationOwnerConflict,
        listUnfinishedBackgroundTasks: host.listUnfinishedBackgroundTasks,
        isGoalVerifierChildSession: host.isGoalVerifierChildSession,
        sessionExists: host.sessionExists,
        ...createGoalConversationPorts({
            conversation: requireConversation,
            promptReads: requireService,
        }),
        ...kickoffQueue.integrationDeps(),
        ...(input.stoppedQueue
            ? {
                endStoppedQueuePause: createStoppedQueueContinuation(input.stoppedQueue),
                releaseFailedTurnPause: createFailedTurnPauseRelease(input.stoppedQueue),
            }
            : {}),
        reportFailure: input.reportFailure,
        formatError: input.formatError,
        configGetter: input.configGetter,
        ...(input.isEnabled ? { isEnabled: input.isEnabled } : {}),
        ...(host.observability
            ? {
                emitRuntimeEvent: createThreadGoalObservabilityEventSink(host.observability.logger, host.observability.evalReporterFactory),
            }
            : {}),
        readUsageRecoveryHint: (turnId) => usageRecoveryHints.consume(turnId),
    }, store);
    const goals = service;
    return {
        service: goals,
        turnLifecycle: createGoalTurnLifecycle({ goals, turnTimings }),
        bindConversation: (runtimeConversation) => conversation.bind(runtimeConversation),
        observeLLMRequestFailure: (info) => usageRecoveryHints.observeLLMRequestFailure(info),
        recoverFacts: async () => {
            // Before any Goal Turn can start again: settle what the last process left
            // open. A failure leaves those rows as they were (still occupying budget)
            // and must not block the rest of startup recovery.
            try {
                await goals.recoverInterruptedRequests();
            }
            catch (error) {
                logger.warn({ error }, 'Thread Goal request recovery failed');
            }
            await kickoffQueue.recoverFacts();
        },
        takeOver: (runtimeConversation, signal) => kickoffQueue.takeOver(runtimeConversation, signal),
        questionnaireOwner: questionnairePolicy.workOwner(),
        recoverQuestionnaires: async (signal) => {
            await questionnairePolicy.recoverOnStartup(signal);
        },
        createVerifierExecution: (registry) => createLocalGoalVerifierExecution(host.verifierTaskRunner, registry, {
            onChildStarted: (child) => goals.recordVerifierChildStarted(child),
        }),
        close: () => {
            goals.stopUsageRecovery();
            questionnairePolicy.close();
            conversation.close();
        },
    };
}
//# sourceMappingURL=initialize.js.map