import { getRuntimeRegion, isInternalBuild, isLocalSourceProvenanceEnabled, } from '@mavis/config';
import { createRuntimeAuthSubmissionPreparation } from './runtime-execution-auth.js';
import { SAFETY_SCENE } from '../../service/content-safety/index.js';
import { isCommandLineRuntimeOwner } from '../agent/profile-source.js';
import { combineLocalTurnToolPolicyGuards, createGoalBudgetToolPolicyGuard, } from '../agent/goal-budget-tool-policy.js';
import { createGoalFinalReply } from '../agent/goal-final-reply.js';
import { createRuntimeSourceReferenceExtension } from '../agent/source-reference-extension.js';
import { createPlanEntrySubmissionPreparation, } from '../../service/plan/index.js';
import { withSessionClioTurnSettlement, } from '../../service/session-clio/index.js';
import { combineAgentEventObservers, composeTurnSubmissionPreparations, createContentReviewSlowEventObserver, createGoalTurnSubmissionPreparation, createLocalAgentHost, createSessionLLMRetryEventObserver, createPromptSuggestionService, createPromptSuggestionEligibility, hasPriorityUserQueueItem, initializeTurnSystem, requireAgentRuntime, } from '../../service/turn-system/index.js';
import { createQuestionnaireAnswerAdmissionPreparation, createQuestionnaireAnswerSteeringMarker, observeQuestionnaireAnswerSteering, } from './questionnaire-answer-admission.js';
import { createRuntimeQueueSelection } from './runtime-queue-selection.js';
import { createRuntimeTurnAdmissionOptions } from './runtime-services-composition.js';
import { createApprovedTitleHandler, createConsumedSteeringHandler, createQueueWakeFailureReporter, createTurnSystemMessageDelivery, } from './turn-message-delivery.js';
/** A Turn detached from its deleted Goal goes on as an ordinary Turn. */
function createRuntimeGoalFinalReply(goalPort) {
    return createGoalFinalReply({
        worksForGoal: (turn) => goalPort.goalIdForTurn(turn.sessionId, turn.turnId) !== undefined,
    });
}
function createRuntimePromptSuggestions(input) {
    // Remote rollout policy (Apollo `agent_config.prompt_suggestion`), read fresh
    // on every admission so a kill switch stops the feature without a restart.
    // No remote value, or a failed fetch, keeps the feature available to users
    // who opted in, like the Runaway Guard override.
    const policy = () => {
        const remote = input.options.getPromptSuggestionPolicy?.() ?? {};
        return { killSwitch: remote.killSwitch === true, sampleRate: remote.sampleRate ?? 1 };
    };
    // Keep credentials private to the auth adapter; the suggestion service only
    // sees a process-local epoch that also changes on logout or token rotation.
    let authSnapshot = input.options.compatibility.commerce.readAuthSnapshot();
    let authEpoch = 0;
    const identity = {
        identity: () => {
            const next = input.options.compatibility.commerce.readAuthSnapshot();
            if (next.accessToken !== authSnapshot.accessToken ||
                next.loginEpoch !== authSnapshot.loginEpoch) {
                authSnapshot = next;
                authEpoch += 1;
            }
            return next.accessToken?.trim() ? String(authEpoch) : undefined;
        },
    };
    // Advisory only: the suggestion runs outside the main Turn's waiting path and
    // consumes the user's own account quota. Trial grants are not wired yet, so
    // nothing here claims a platform-covered allowance.
    // Internal builds dogfood the feature on every account and model, so neither
    // billing gate (subscription check, managed-models-only scope) applies there.
    // A host may also open every model explicitly (the interactive TUI does).
    const billingGated = !isInternalBuild() && input.options.promptSuggestionUngated !== true;
    // Only a host that can show the suggestion pays for it. Headless command-line
    // owners have no composer; the interactive TUI opts in explicitly.
    const hasSuggestionSurface = input.options.promptSuggestionSurface ??
        !isCommandLineRuntimeOwner(input.options.runtimeOwnerKind);
    const suggestions = createPromptSuggestionService({
        enabled: () => hasSuggestionSurface &&
            input.product.preparation.configBuilder.config().promptSuggestion?.enabled === true,
        publish: input.writeGlobalEvent,
        // The extra generation is billed to the account. While gated, it runs only
        // for a confirmed subscription, and this gate is the enforcement point; the
        // settings hint is advisory and may be stale. Internal builds and hosts
        // that set `promptSuggestionUngated` skip it, so there the user's
        // `promptSuggestion.enabled` switch is the only check.
        ...(billingGated
            ? { eligibility: createPromptSuggestionEligibility(input.options.compatibility.commerce) }
            : {}),
        hasPendingInput: async (sessionId) => (await input.sessionSystem.queue.committed.list(sessionId)).length > 0,
        policy,
        identity,
        review: async (text) => !(await input.safety.blocks(text, SAFETY_SCENE.MessageOutput)),
        log: (fields) => input.options.logger?.info(fields, '[prompt-suggestion]'),
    });
    const promptSuggestion = {
        enabled: () => suggestions.isEnabled(),
        allowUnmanagedModels: !billingGated,
        turnStarted: (sessionId) => suggestions.cancel(sessionId),
        committed: (scope, capture) => suggestions.schedule(scope.sessionId, scope.turnId, capture),
    };
    return { suggestions, promptSuggestion };
}
export async function initializeRuntimeTurnSystem(input, dependencies) {
    const { plan, prepareMiniAppTurn, planEntryEnabled, normalExtensions, resumeSessionDeletion, goalVerifierExtension, goalVerifierOutputTokenCap, } = dependencies;
    const llmRetryObserver = createSessionLLMRetryEventObserver(input.writeGlobalEvent);
    const { suggestions, promptSuggestion } = createRuntimePromptSuggestions(input);
    let agentRuntime;
    input.options.compatibility.backgroundTasks.bindRuntimeOwner({
        ownerId: input.runtimeOwnerIdentity.createOwnerId('background-task'),
        isOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
    });
    const turnSystem = await initializeTurnSystem({
        db: input.options.db,
        onBackgroundTaskWaitChanged: (payload) => input.writeGlobalEvent({ type: 'session.background_task_wait', payload }),
        // Explicit user stops cascade into this Session's background work. Owned by
        // the injected V2 background owner; an accepted stop pauses the active Goal
        // through the v2 Goal owner first.
        userStop: input.options.compatibility.backgroundTasks.createUserStop({
            pauseActiveGoal: input.goalPort.pauseActiveForAbort,
        }),
        // A redelivered queue item runs under a fresh Turn id; its Goal token
        // attribution follows it.
        onQueuedTurnIdentity: ({ turnId, previousTurnIds }) => input.goalPort.followQueuedTurn({ turnId, previousTurnIds }),
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
        // An AskUser v2 answer steered into a Stopped/abnormally ended Turn falls
        // into the conversation through the teardown commit. injected_at is
        // written only here, after BOTH the display row and the canonical history
        // row (what the next model request reads) are durable. A failed canonical
        // append never reaches this hook: the message stays in the teardown retry
        // lane or falls back to the queue with injected_at still empty, so a crash
        // at any point leaves it to retry, the queue or startup recovery.
        onSteeringTeardownCommitted: createQuestionnaireAnswerSteeringMarker(questionnaireAnswerObserver(input, 'steering_teardown_committed')),
        createHost: async ({ turnControl, turnFacts, pluginHookSessionOwnership }) => {
            const goalFinalReply = createRuntimeGoalFinalReply(input.goalPort);
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
                promptSuggestion,
                // `sessionTitle.enabled: false` disables title generation: wire a
                // no-op so no title model request is issued. Read from the injected
                // config source (same as beta/custom_provider above), default on.
                onInputReviewResolved: (input.product.preparation.configBuilder.config().sessionTitle?.enabled ?? true)
                    ? createApprovedTitleHandler(input.sessionSystem, input.product.executor.reportFailure)
                    : () => { },
                onSteeringConsumed: observeQuestionnaireAnswerSteering(createConsumedSteeringHandler(input.messageDelivery, input.sessionSystem, input.writeGlobalEvent, input.product.executor.reportFailure), questionnaireAnswerObserver(input, 'steering_consumed')),
                toolPolicyGuard: combineLocalTurnToolPolicyGuards(goalFinalReply.toolPolicyGuard, plan.toolGuard, createGoalBudgetToolPolicyGuard()),
                outputTokenCap: goalVerifierOutputTokenCap,
                askUserPolicy: createAskUserPolicySource(input),
                resolveLlmRetry: () => ({ observer: llmRetryObserver }),
                // 送审等了 15 秒以上时发 `content.review.slow`，界面在输入框上方提示检查电脑负荷。
                onSlowReview: createContentReviewSlowEventObserver(input.writeGlobalEvent),
                normalExtensions: [
                    ...(!isLocalSourceProvenanceEnabled(input.options.runtimeOwnerKind)
                        ? []
                        : [
                            createRuntimeSourceReferenceExtension(input.options.compatibility.attachmentRegistration),
                        ]),
                    plan.extension,
                    goalVerifierExtension,
                    goalFinalReply.extension,
                    ...normalExtensions,
                    ...(input.memory ? [input.memory.agentExtension] : []),
                ],
                eventObserver: combineAgentEventObservers(...(input.channelSystem ? [input.channelSystem.terminalReplies] : []), input.turnLifecycleEvents),
                nowMs: input.nowMs,
                miniAppApprovals: dependencies.miniAppApprovals,
                ...(isCommandLineRuntimeOwner(input.options.runtimeOwnerKind)
                    ? { cliProductPolicy: true }
                    : {}),
                ...(input.options.runtimeOwnerKind === 'tui'
                    ? { tuiProductPolicy: true, contentReviewEnabled: getRuntimeRegion() === 'cn' }
                    : {}),
                ...(input.options.getRunawayGuardConfig
                    ? { getRunawayGuardConfig: input.options.getRunawayGuardConfig }
                    : {}),
                resolveComputerUseCapture: input.options.resolveComputerUseCapture,
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
            suggestions.cancel(sessionId);
            try {
                await requireAgentRuntime(agentRuntime).disposeSession(sessionId);
            }
            finally {
                await dependencies.disposeMcpSession(sessionId);
            }
        },
        ...createRuntimeTurnAdmissionOptions(input, plan.admission),
        submissionPreparation: composeTurnSubmissionPreparations(createRuntimeAuthSubmissionPreparation(input.options.executionAuthMode, input.product.preparation.modelResolver.authContextGetter), createPlanEntrySubmissionPreparation(plan), createGoalTurnSubmissionPreparation({
            prepare: input.goalPort.prepareTurnAdmission,
            hasPendingPlan: (sessionId) => plan.lifecycleFence.blocks({ sessionId }),
            hasPriorityMailboxWork: async (sessionId) => hasPriorityUserQueueItem(await input.sessionSystem.queue.committed.list(sessionId)),
        }), input.options.compatibility.sessionHandoff.hosted.submissionPreparation, 
        // Last: it only records that a v2 questionnaire answer reached the model.
        createQuestionnaireAnswerAdmissionPreparation({
            markAnswerAdmitted: markQuestionnaireAnswerDelivered(input),
            readQueuedOrigins: async (sessionId, itemId) => {
                const item = await input.sessionSystem.queue.committed.get(sessionId, itemId);
                return item
                    ? [
                        item.message.origin,
                        ...(item.immediateSendBatch?.members.map((member) => member.message.origin ?? member.provenance.sourceContext?.origin) ?? []),
                    ]
                    : [];
            },
            ...(input.options.logger ? { logger: input.options.logger } : {}),
        })),
        ...createRuntimeHistoryProjections(input),
        onTurnDiffRewindSkipped: (event) => input.options.logger?.warn({ ...event }, 'Turn diff rewind phase skipped'),
        ...createRuntimeQueueSelection({
            computerUseClient: input.options.computerUseClient,
            questionnaires: input.options.compatibility.peripherals.questionnaires,
            goals: input.goalPort,
            queue: input.sessionSystem.queue.committed,
            lifecycleFence: plan.lifecycleFence,
            entryEnabled: planEntryEnabled,
        }),
        createMessageDelivery: createTurnSystemMessageDelivery(input.messageDelivery),
        beforeStart: prepareMentionedMiniApps(input, prepareMiniAppTurn),
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
    input.options.compatibility.backgroundTasks.bindNotificationReceipts(turnSystem.receipts);
    return withPromptSuggestionLifecycle(turnSystem, suggestions);
}
/** A session a Mini App started must not cold-start other Mini Apps by mentioning them. */
function prepareMentionedMiniApps(input, prepareMiniAppTurn) {
    return async ({ input: message, sessionId, signal }) => {
        const record = await input.sessionSystem.sessions.repository.get(sessionId);
        if (record?.miniAppOrigin)
            return;
        return prepareMiniAppTurn({
            messages: [message, ...(message.queuedMessages ?? [])].map(({ text }) => ({
                content: text,
            })),
            signal,
        });
    };
}
function withPromptSuggestionLifecycle(turnSystem, suggestions) {
    return {
        ...turnSystem,
        turns: {
            ...turnSystem.turns,
            promptSuggestion: {
                cancel: (sessionId, turnId) => suggestions.cancelTurn(sessionId, turnId),
                read: (sessionId, turnId) => suggestions.read(sessionId, turnId),
            },
        },
        close: async () => {
            suggestions.close();
            await turnSystem.close();
        },
    };
}
/** Records that an AskUser v2 answer reached the model (v1 questionnaire owner, CAS once). */
function markQuestionnaireAnswerDelivered(input) {
    return (answer) => input.options.compatibility.questionnaires.createService().markAnswerAdmitted(answer);
}
/** Options for observeQuestionnaireAnswerSteering; kept out of createHost's branch budget. */
function questionnaireAnswerObserver(input, stage) {
    return {
        markAnswerDelivered: markQuestionnaireAnswerDelivered(input),
        stage,
        ...(input.options.logger ? { logger: input.options.logger } : {}),
    };
}
/**
 * Turn-start AskUser facts. The Goal fact deliberately reuses the thread-goal
 * store row (`status === 'active'`) that the questionnaire lifecycle's
 * `isGoalActive` reads at ask_user call time, so the policy SR and the actual
 * sync/async decision cannot disagree about "in Goal".
 */
function createAskUserPolicySource(input) {
    return {
        // The conversation config read model does not type `askUser`; the value is
        // normalized by `parseAskUserConfig` in the reminder owner.
        readConfig: () => Reflect.get(input.product.preparation.configBuilder.config(), 'askUser'),
        isGoalActive: async (sessionId) => (await input.goalPort.getBySession(sessionId))?.status === 'active',
    };
}
function createRuntimeHistoryProjections(input) {
    return {
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
    };
}
//# sourceMappingURL=turn-system-composition.js.map