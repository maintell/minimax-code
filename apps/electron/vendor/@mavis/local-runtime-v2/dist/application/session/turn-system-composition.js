import { getRuntimeRegion, isLocalSourceProvenanceEnabled, } from '@mavis/config';
import { isCommandLineRuntimeOwner } from '../agent/profile-source.js';
import { combineLocalTurnToolPolicyGuards, createGoalBudgetToolPolicyGuard, } from '../agent/goal-budget-tool-policy.js';
import { createGoalBudgetSummaryExtension } from '../agent/goal-budget-summary-reminder.js';
import { createGoalFinalReply } from '../agent/goal-final-reply.js';
import { createRuntimeSourceReferenceExtension } from '../agent/source-reference-extension.js';
import { createPlanEntrySubmissionPreparation, } from '../../service/plan/index.js';
import { withSessionClioTurnSettlement, } from '../../service/session-clio/index.js';
import { combineAgentEventObservers, composeTurnSubmissionPreparations, createGoalTurnSubmissionPreparation, createLocalAgentHost, createSessionLLMRetryEventObserver, hasPriorityUserQueueItem, initializeTurnSystem, requireAgentRuntime, } from '../../service/turn-system/index.js';
import { createRuntimeQueueSelection } from './runtime-queue-selection.js';
import { createRuntimeTurnAdmissionOptions } from './runtime-services-composition.js';
import { createApprovedTitleHandler, createConsumedSteeringHandler, createQueueWakeFailureReporter, createTurnSystemMessageDelivery, } from './turn-message-delivery.js';
export async function initializeRuntimeTurnSystem(input, dependencies) {
    const { plan, prepareMiniAppTurn, planEntryEnabled, normalExtensions, resumeSessionDeletion, goalVerifierExtension, goalVerifierOutputTokenCap, } = dependencies;
    const llmRetryObserver = createSessionLLMRetryEventObserver(input.writeGlobalEvent);
    let agentRuntime;
    input.options.compatibility.backgroundTasks.bindRuntimeOwner({
        ownerId: input.runtimeOwnerIdentity.createOwnerId('background-task'),
        isOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
    });
    return initializeTurnSystem({
        db: input.options.db,
        // Explicit user stops cascade into this Session's background work. Owned by
        // the V1 compat layer, which holds the task runners and their admissions.
        userStop: input.options.compatibility.backgroundTasks.userStop,
        ...(input.options.logger ? { logger: input.options.logger } : {}),
        sessions: input.sessionSystem,
        processStartedAtMs: input.processStartedAtMs,
        makeLeaseId: () => input.runtimeOwnerIdentity.createOwnerId('turn-lease'),
        makeDeletionOwnerId: () => input.runtimeOwnerIdentity.createOwnerId('session-delete'),
        isLeaseOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
        isLeaseOwnerCurrent: input.runtimeOwnerIdentity.ownsOwnerId,
        runtimeRecoveryRetryMs: input.runtimeOwnerIdentity.recoveryRetryMs,
        ...(input.options.recoverPersistedState !== false
            ? {
                onRuntimeRecovery: input.options.compatibility.backgroundTasks.recover,
                pollRuntimeRecovery: input.options.compatibility.backgroundTasks.pollRecovery,
            }
            : {}),
        resumeSessionDeletion,
        // Decision v5: teardown fall-to-session uses the delivery service's
        // consumeSteering directly — the wrapped handler above would publish a
        // `session.start` no ended Turn should emit.
        commitSteeringTeardownProjection: (steer) => input.messageDelivery.consumeSteering(steer),
        createHost: async ({ turnControl, turnFacts, pluginHookSessionOwnership }) => {
            const goalFinalReply = createGoalFinalReply();
            const production = await createLocalAgentHost({
                product: input.product,
                db: input.options.db,
                preparation: input.preparation,
                sessions: input.sessionSystem,
                safety: input.safety,
                turnControl,
                turnFacts,
                pluginHookSessionOwnership,
                turnCapabilities: input.turnCapabilities,
                // `sessionTitle.enabled: false` disables title generation: wire a
                // no-op so no title model request is issued. Read from the injected
                // config source (same as beta/custom_provider above), default on.
                onInputReviewResolved: (input.product.preparation.configBuilder.config().sessionTitle?.enabled ?? true)
                    ? createApprovedTitleHandler(input.sessionSystem, input.product.executor.reportFailure)
                    : () => { },
                onSteeringConsumed: createConsumedSteeringHandler(input.messageDelivery, input.sessionSystem, input.writeGlobalEvent, input.product.executor.reportFailure),
                toolPolicyGuard: combineLocalTurnToolPolicyGuards(goalFinalReply.toolPolicyGuard, plan.toolGuard, createGoalBudgetToolPolicyGuard()),
                outputTokenCap: goalVerifierOutputTokenCap,
                resolveLlmRetry: () => ({ observer: llmRetryObserver }),
                normalExtensions: [
                    ...(!isLocalSourceProvenanceEnabled(input.options.runtimeOwnerKind)
                        ? []
                        : [
                            createRuntimeSourceReferenceExtension(input.options.compatibility.attachmentRegistration),
                        ]),
                    plan.extension,
                    goalVerifierExtension,
                    createGoalBudgetSummaryExtension(),
                    goalFinalReply.extension,
                    ...normalExtensions,
                    ...(input.memory ? [input.memory.agentExtension] : []),
                ],
                eventObserver: combineAgentEventObservers(...(input.channelSystem ? [input.channelSystem.terminalReplies] : []), input.turnLifecycleEvents),
                nowMs: input.nowMs,
                ...(isCommandLineRuntimeOwner(input.options.runtimeOwnerKind)
                    ? { cliProductPolicy: true }
                    : {}),
                ...(input.options.runtimeOwnerKind === 'tui'
                    ? { tuiProductPolicy: true, contentReviewEnabled: getRuntimeRegion() === 'cn' }
                    : {}),
                ...(input.options.getRunawayGuardConfig
                    ? { getRunawayGuardConfig: input.options.getRunawayGuardConfig }
                    : {}),
                ...(input.options.getToolResultCompactionConfig
                    ? {
                        getToolResultCompactionConfig: input.options.getToolResultCompactionConfig,
                    }
                    : {}),
            });
            agentRuntime = production.lifecycle;
            return production.host;
        },
        disposeRuntimeSession: async (sessionId) => {
            try {
                await requireAgentRuntime(agentRuntime).disposeSession(sessionId);
            }
            finally {
                await dependencies.disposeMcpSession(sessionId);
            }
        },
        ...createRuntimeTurnAdmissionOptions(input, plan.admission),
        submissionPreparation: composeTurnSubmissionPreparations(createPlanEntrySubmissionPreparation(plan), createGoalTurnSubmissionPreparation({
            prepare: input.options.compatibility.sessionV2.goals.prepareTurnAdmission,
            hasPendingPlan: (sessionId) => plan.lifecycleFence.blocks({ sessionId }),
            hasPriorityMailboxWork: async (sessionId) => hasPriorityUserQueueItem(await input.sessionSystem.queue.committed.list(sessionId)),
        }), input.options.compatibility.sessionHandoff.hosted.submissionPreparation),
        forkProjections: {
            forkPrefix: async (request) => {
                const sourcePlan = await input.sessionSystem.planDocuments.resolveAndEnsure(request.sourceSessionId);
                await input.options.compatibility.sessionV2.diff.capability.forkPrefix({
                    ...request,
                    excludedFilePaths: [sourcePlan.canonicalPath],
                });
            },
        },
        rewindProjections: {
            preflight: (request) => input.options.compatibility.sessionV2.diff.rewind.preflight(request),
            apply: (request) => input.options.compatibility.sessionV2.diff.rewind.apply(request),
            deleteTurns: async (request) => {
                await input.options.compatibility.sessionV2.diff.rewind.deleteTurns(request);
                await input.inspector?.service.deleteTurns(request.sessionId, request.turnIds);
            },
        },
        onTurnDiffRewindSkipped: (event) => input.options.logger?.warn({ ...event }, 'Turn diff rewind phase skipped'),
        ...createRuntimeQueueSelection({
            computerUseClient: input.options.computerUseClient,
            questionnaires: input.options.compatibility.peripherals.questionnaires,
            goals: input.options.compatibility.sessionV2.goals,
            queue: input.sessionSystem.queue.committed,
            lifecycleFence: plan.lifecycleFence,
            entryEnabled: planEntryEnabled,
        }),
        createMessageDelivery: createTurnSystemMessageDelivery(input.messageDelivery),
        beforeStart: ({ input: message, signal }) => prepareMiniAppTurn({
            messages: [message, ...(message.queuedMessages ?? [])].map(({ text }) => ({
                content: text,
            })),
            signal,
        }),
        ...(input.sessionClio ? { sessionClio: input.sessionClio.capture } : {}),
        ...(input.sessionClio || input.product.turnSettlement
            ? {
                turnSettlement: input.sessionClio
                    ? withSessionClioTurnSettlement(input.sessionClio.capture, input.product.turnSettlement)
                    : input.product.turnSettlement,
            }
            : {}),
        onQueueWakeFailure: createQueueWakeFailureReporter(input.product.executor.reportFailure, 'turn_submit_queue_wake_failed'),
        resolveChannelInputModel: input.channelTurnAdmission.resolveChannelInputModel,
        queueSubmissionRejections: input.channelTurnAdmission.queueSubmissionRejections,
        onRuntimeRecoveryFailure: createQueueWakeFailureReporter(input.product.executor.reportFailure, 'runtime_recovery_failed'),
        nowMs: input.nowMs,
    });
}
//# sourceMappingURL=turn-system-composition.js.map