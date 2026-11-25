import { homedir } from 'node:os';
import path from 'node:path';
import { withPptPreviewTaskStop } from './ppt-task-stop-cascade.js';
import { bunnyMemoryRoot, createBunnyMediaDescriptionRepository, createBunnyRoundBudgetExtension, } from '../../service/bunny/index.js';
import { createAssignmentPermissionDecisions } from '../../service/assignment/index.js';
import { createProtectedRootDecisions, readLocalPermissionMode, runtimeStateProtectedRoots, } from '../../service/permission/index.js';
import { createRuntimeAssignmentExecutionExtension } from './assignment-snapshot-product.js';
import { withAssignmentTurnSettlement } from './assignment-turn-settlement.js';
import { createTurnAgentKindResolver } from './turn-agent-kind.js';
import { ptcScriptRefusedImport } from './ptc-script-import-check.js';
import { ptcScriptSkillRoots } from './ptc-script-skill-roots.js';
import { agentHomeDirectories } from './agent-homes.js';
import { currentBetaResolutionContext, getRuntimeBuildEnv, getRuntimeRegion, isLocalSourceProvenanceEnabled, resolveBetaFeature, } from '@mavis/config';
import { resolveBunnyHomeDir } from '@mavis/shared/local-runtime-paths';
import { createRuntimeAuthSubmissionPreparation } from './runtime-execution-auth.js';
import { resolveSafetyApiBase, SAFETY_SCENE } from '../../service/content-safety/index.js';
import { createPtcScriptHost, readPtcScriptCatalog, renderPtcScriptCatalog, } from '@mavis/agent-tools';
import { BUNNY_DATABASE_DIR, BUNNY_TRASH_DIR, sessionIsCoordinator, } from '../../service/session-system/index.js';
import { isCommandLineRuntimeOwner } from '../agent/profile-source.js';
import { combineLocalTurnToolPolicyGuards, createGoalBudgetToolPolicyGuard, } from '../agent/goal-budget-tool-policy.js';
import { createGoalFinalReply } from '../agent/goal-final-reply.js';
import { createRuntimeSourceReferenceExtension } from '../agent/source-reference-extension.js';
import { createBuiltinCoordinatorAgents } from '../agent/agent-surface-policy.js';
import { createPlanEntrySubmissionPreparation, } from '../../service/plan/index.js';
import { withSessionClioTurnSettlement } from '../../service/session-clio/index.js';
import { combineAgentEventObservers, contextResetSessions, composeTurnSubmissionPreparations, createGoalTurnSubmissionPreparation, createSubmissionMemoryMetricsPreparation, createLocalAgentHost, createLocalNetworkRecovery, createContentReviewSlowEventObserver, createSessionLLMRetryEventObserver, createPromptSuggestionService, createSideMessageFallbackLog, createSteerFaultFilePort, createTurnFaultFilePort, hasPriorityUserQueueItem, initializeTurnSystem, requireAgentRuntime, requireHarnessHistory, report, } from '../../service/turn-system/index.js';
import { closeRuntimeTurnSystem } from './runtime-services-lifecycle.js';
import { createRuntimeUndeliveredSideMessages } from './runtime-user-applications.js';
import { createQuestionnaireAnswerAdmissionPreparation, createQuestionnaireAnswerSteeringMarker, observeQuestionnaireAnswerSteering, } from './questionnaire-answer-admission.js';
import { createRuntimeQueueSelection, createWaitingForUserQueueWake, } from './runtime-queue-selection.js';
import { createRuntimeTurnAdmissionOptions } from './runtime-services-composition.js';
import { scopeCoordinatorTurnExtensions } from './coordinator-turn-scope.js';
import { createApprovedTitleHandler, createReplyTitleReviewHandler, createConsumedSteeringHandler, createQueueWakeFailureReporter, createTurnSystemMessageDelivery, } from './turn-message-delivery.js';
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
    // The suggestion runs outside the main Turn's waiting path. No account or
    // model is special-cased; only the remote policy narrows it.
    // Only a host that can show the suggestion pays for it. Headless command-line
    // owners have no composer; the interactive TUI opts in explicitly.
    const hasSuggestionSurface = input.options.promptSuggestionSurface ??
        !isCommandLineRuntimeOwner(input.options.runtimeOwnerKind);
    const suggestions = createPromptSuggestionService({
        // `enabled` is already the effective opt-in: the host's config read boundary
        // fills in the explicit choice, else the remote default (on when absent).
        enabled: () => hasSuggestionSurface &&
            input.product.preparation.configBuilder.config().promptSuggestion?.enabled === true,
        publish: input.writeGlobalEvent,
        hasPendingInput: async (sessionId) => (await input.sessionSystem.queue.committed.list(sessionId)).length > 0,
        policy,
        identity,
        review: async (text) => !(await input.safety.blocks(text, SAFETY_SCENE.MessageOutput)),
        log: (fields) => input.options.logger?.info(fields, '[prompt-suggestion]'),
    });
    const promptSuggestion = {
        enabled: () => suggestions.isEnabled(),
        turnStarted: (sessionId) => suggestions.cancel(sessionId),
        committed: (scope, capture) => suggestions.schedule(scope.sessionId, scope.turnId, capture, scope.messageId),
    };
    return { suggestions, promptSuggestion };
}
/**
 * The product with what coordinator-owned Sessions add to it: their `agentKind`
 * label, Bunny's home readable to Bunny, and assignment-aware permission
 * decisions over the ordinary policy. The app's own state (databases,
 * credentials, session history) is denied to every Session's writes first.
 */
function withCoordinatorCapabilities(input) {
    const { roster } = input.sessionSystem.coordinatorOwnership;
    return {
        ...input.product,
        inputPreparation: {
            ...input.product.inputPreparation,
            resolveAgentKind: createTurnAgentKindResolver(input.sessionSystem.coordinatorOwnership),
        },
        // Bunny reads its own home (worklines, memory, notes) without asking.
        agentHomeDirectories: (agentName) => agentHomeDirectories(roster, input.options.dataDir, agentName),
        permission: {
            ...input.product.permission,
            decisions: createProtectedRootDecisions({
                sessions: input.sessionSystem.repositories.sessions,
                roots: runtimeStateProtectedRoots(input.options.dataDir),
            }, createAssignmentPermissionDecisions({
                sessions: input.sessionSystem.repositories.sessions,
                tasks: input.sessionSystem.repositories.assignmentTasks,
                ownership: input.sessionSystem.coordinatorOwnership,
                resolveAssignmentProject: input.resolveAssignmentProject,
                // The same live view the hosted facade reads, so both see one mode.
                localPermissionMode: async () => readLocalPermissionMode(input.product.preparation.configBuilder.config().permissionMode),
            }, input.product.permission.decisions, input.bunnyPermissionMode, {
                memory: bunnyMemoryRoot(input.options.dataDir),
                spaces: path.join(resolveBunnyHomeDir(input.options.dataDir), 'spaces'),
                runtime: [
                    path.join(resolveBunnyHomeDir(input.options.dataDir), BUNNY_DATABASE_DIR),
                    path.join(resolveBunnyHomeDir(input.options.dataDir), BUNNY_TRASH_DIR),
                ],
            })),
        },
    };
}
/** Bunny's Turn extensions, mounted only on the Turns of the Sessions they are for. */
function createCoordinatorTurnExtensions(input) {
    return scopeCoordinatorTurnExtensions(input.sessionSystem.coordinatorOwnership, {
        executionReminder: createRuntimeAssignmentExecutionExtension(input),
        roundBudget: createRuntimeBunnyRoundBudget(input),
    });
}
/** Bunny-only round budget; the refusal is opt-in, count, reminder and summary always run. */
function createRuntimeBunnyRoundBudget(input) {
    return createBunnyRoundBudgetExtension({
        isBlockEnabled: () => input.product.preparation.configBuilder.config().runawayGuard?.bunnyRoundBudgetBlock === true,
        ...(input.bunnyRoundBudgetSummary ? { onTurnSummary: input.bunnyRoundBudgetSummary } : {}),
        ...(input.bunnyReviewRound ? { reviewRound: input.bunnyReviewRound } : {}),
        ...(input.bunnyReferencedSessionRead
            ? { referencedSessionRead: input.bunnyReferencedSessionRead }
            : {}),
    });
}
/**
 * Side message fallback log, plus the steer fault rules that only a
 * verification instance's `diagnostics.steerFaultFile` config enables; without
 * that key every steer only reads the config.
 */
function createRuntimeSideMessageDiagnostics(input) {
    const logger = input.options.compatibility.goalHost.observability?.logger;
    return {
        faults: createSteerFaultFilePort({
            filePath: () => input.product.preparation.configBuilder.config().diagnostics?.steerFaultFile,
            nowMs: input.nowMs,
            onError: (error) => input.options.logger?.warn({ error: String(error) }, '[steer-fault] rules file unusable'),
        }),
        ...(logger ? { observe: createSideMessageFallbackLog(logger, input.nowMs) } : {}),
        // Spec 4.1-4.4: kept as an undelivered row and the active Goal paused.
        undelivered: createRuntimeUndeliveredSideMessages({
            sessionSystem: input.sessionSystem,
            goalPort: input.goalPort,
            reportFailure: (sessionId, message) => input.product.executor.reportFailure?.(sessionId, message),
        }),
        nowMs: input.nowMs,
    };
}
/**
 * Whether this host's own display surface can show a mid-stream retry as two
 * messages: the half answer ends, the resent attempt follows as a new one.
 *
 * Owner alone cannot answer it. `tui` is the owner of the interactive TUI *and*
 * of headless exec, ACP, app-server and inspection runs, so keying on it would
 * enable the retry for output surfaces that run adjacent assistant messages
 * together, or that only print the final text — there the split is unreadable.
 * Those hosts opt in explicitly through `partialStreamRecoverySurface`, exactly
 * like `promptSuggestionSurface` does for the suggestion.
 *
 * Unlike that option, no owner other than Desktop defaults to `true`: the SSH
 * `app-server` is not a command-line owner yet has no surface that renders the
 * split either, so "not a CLI" must not imply "renders the two messages".
 */
function shouldRecoverPartialStream(options) {
    // An explicit host choice always wins, including an explicit `false`.
    if (options.partialStreamRecoverySurface !== undefined)
        return options.partialStreamRecoverySurface;
    // Undeclared, only this machine's Desktop is known to render the split: it
    // hosts exactly one surface.
    return options.runtimeOwnerKind === 'electron';
}
/**
 * Network handling shared by every Turn of this runtime: one process-wide
 * network view, so an endpoint reached by any Session may wait out an outage;
 * an observer that also logs retry states, so an offline wait can be read
 * back after the UI has moved on; and the content-review offline wait, shown
 * in the UI as the same network wait as a model call. Committed-stream
 * recovery (50113) is enabled only when this host's own surface can show the
 * abandoned attempt and the resend as two messages.
 */
/**
 * The review requests' `contentReview.testBaseURL`. The conversation config
 * read model does not type it; `resolveSafetyApiBase` applies the test-build
 * loopback restriction.
 */
function reviewTestBaseURL(input) {
    const contentReview = Reflect.get(input.product.preparation.configBuilder.config(), 'contentReview');
    const value = contentReview && typeof contentReview === 'object'
        ? Reflect.get(contentReview, 'testBaseURL')
        : undefined;
    return typeof value === 'string' ? value : undefined;
}
function createRuntimeLlmRetry(input) {
    const publish = createSessionLLMRetryEventObserver(input.writeGlobalEvent);
    const recoverPartialStream = shouldRecoverPartialStream(input.options);
    const observer = (event) => {
        input.options.logger?.info({
            event: 'llm_retry',
            session_id: event.sessionId,
            turn_id: event.turnId,
            call_id: event.callId,
            scope: event.scope,
            status: event.status,
            retry_attempt: event.retryAttempt,
            request_attempt: event.requestAttempt,
            ...(event.delayMs === undefined ? {} : { delay_ms: event.delayMs }),
            ...(event.waitingFor ? { waiting_for: event.waitingFor } : {}),
            ...(event.error ? { reason: event.error.reason } : {}),
        }, '[llm-retry]');
        return publish(event);
    };
    const networkRecovery = createLocalNetworkRecovery({
        isDeviceOnline: input.options.isDeviceOnline,
        // The probe follows the model requests' route: the host transport, else the
        // global fetch the TUI points at its environment proxy.
        fetchImpl: input.product.fileApi?.fetchImpl ?? ((url, init) => globalThis.fetch(url, init)),
        // Same address source as the review requests, test-build loopback override included.
        reviewEndpoint: () => resolveSafetyApiBase(getRuntimeRegion(), getRuntimeBuildEnv(), reviewTestBaseURL(input)),
        onOfflineCheck: (check) => input.options.logger?.info({ event: 'network_offline_check', ...check }, '[network-recovery]'),
    });
    const reviewOfflineWait = ({ sessionId, turnId, signal, }) => networkRecovery.createOfflineWait({
        ...(signal ? { signal } : {}),
        observer: reviewWaitObserver(observer, sessionId, turnId),
    });
    return {
        llmRetry: {
            observer,
            networkRecovery,
            ...(recoverPartialStream ? { recoverPartialStream: true } : {}),
        },
        reviewOfflineWait,
    };
}
/** A content review waiting for the network, reported as a model-call network wait. */
function reviewWaitObserver(observer, sessionId, turnId) {
    const event = (fields) => observer({
        sessionId,
        turnId,
        callId: `content-review:${turnId}`,
        scope: 'agent',
        retryAttempt: 0,
        maxRetries: 0,
        requestAttempt: 1,
        ...fields,
    });
    return {
        waiting: (delayMs) => event({
            status: 'waiting',
            delayMs,
            nextRetryAtMs: Date.now() + delayMs,
            waitingFor: 'network',
            // Same detail as a model call waiting offline, so the notice keeps its info icon.
            error: { reason: 'network', message: 'Network unavailable' },
        }),
        resolved: (online) => event({ status: online ? 'recovered' : 'cancelled' }),
    };
}
/**
 * The Turn hold that only a verification instance's `diagnostics.turnFaultFile`
 * config enables (S14#4). The key is read once, when the Turn System is
 * composed: without it no Turn holds or reads anything. With it every Turn
 * reads the rules file, which the verification tooling may write at any time.
 */
function createRuntimeTurnFaults(input) {
    const filePath = () => input.product.preparation.configBuilder.config().diagnostics?.turnFaultFile;
    if (!filePath())
        return undefined;
    return createTurnFaultFilePort({
        filePath,
        nowMs: input.nowMs,
        onError: (error) => input.options.logger?.warn({ error: String(error) }, '[turn-fault] rules file unusable'),
    });
}
export async function initializeRuntimeTurnSystem(input, dependencies) {
    const { plan } = dependencies;
    const { llmRetry, reviewOfflineWait } = createRuntimeLlmRetry(input);
    const { suggestions, promptSuggestion } = createRuntimePromptSuggestions(input);
    let agentHost;
    const queueSelection = createTurnQueueSelection(input, plan, dependencies.planEntryEnabled);
    input.options.compatibility.backgroundTasks.bindRuntimeOwner({
        ownerId: input.runtimeOwnerIdentity.createOwnerId('background-task'),
        isOwnerAlive: input.runtimeOwnerIdentity.isOwnerAlive,
    });
    const turnSystem = await initializeTurnSystem({
        db: input.options.db,
        onBackgroundTaskWaitChanged: (payload) => input.writeGlobalEvent({ type: 'session.background_task_wait', payload }),
        steeringObserver: {
            admitted: (steer) => input.bunnyTurnTiming?.steeringAdmitted?.(steer),
            discarded: (batch) => input.bunnyTurnTiming?.steeringDiscarded?.(batch),
        },
        onActiveTurnCountChanged: input.options.onActiveTurnCountChanged,
        // Explicit user stops cascade into this Session's background work. Owned by
        // the injected V2 background owner; an
        // accepted stop pauses the active Goal through the v2 Goal owner first.
        userStop: createRuntimeUserStop(input),
        // `/new-bunny` resets Bunny's main conversation instead of compacting it.
        contextReset: contextResetSessions(input.sessionSystem),
        // A redelivered queue item runs under a fresh Turn id; its Goal token
        // attribution follows it.
        onQueuedTurnIdentity: ({ turnId, previousTurnIds }) => input.goalPort.followQueuedTurn({ turnId, previousTurnIds }),
        ...(input.options.logger ? { logger: input.options.logger } : {}),
        sideMessages: createRuntimeSideMessageDiagnostics(input),
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
        resumeSessionDeletion: dependencies.resumeSessionDeletion,
        // Decision v5: teardown fall-to-session uses the delivery service's
        // consumeSteering directly — the wrapped handler above would publish a
        // `session.start` no ended Turn should emit.
        commitSteeringTeardownProjection: (steer) => input.messageDelivery.consumeSteering(steer),
        // The teardown commit has no Agent config, so a coordinator's fall-to-session
        // peer message would keep the ordinary session_send reply note its catalog
        // hides. The shared reader answers from the built-in roster, the same rule
        // the tool authority uses, and treats an unreadable Session as ordinary.
        receiverIsCoordinator: (sessionId) => sessionIsCoordinator(input.sessionSystem, sessionId),
        // An AskUser v2 answer steered into a Stopped/abnormally ended Turn falls
        // into the conversation through the teardown commit. injected_at is
        // written only here, after BOTH the display row and the canonical history
        // row (what the next model request reads) are durable. A failed canonical
        // append never reaches this hook: the message stays in the teardown retry
        // lane or falls back to the queue with injected_at still empty, so a crash
        // at any point leaves it to retry, the queue or startup recovery.
        onSteeringTeardownCommitted: createQuestionnaireAnswerSteeringMarker(questionnaireAnswerObserver(input, 'steering_teardown_committed')),
        createHost: async (capabilities) => {
            const goalFinalReply = createRuntimeGoalFinalReply(input.goalPort);
            const consumeSteering = createConsumedSteeringHandler(input.messageDelivery, input.sessionSystem, input.writeGlobalEvent, input.product.executor.reportFailure);
            const production = await createLocalAgentHost({
                pluginHooks: dependencies.pluginHooks,
                product: withTitleReviewCapability(input),
                db: input.options.db,
                preparation: input.preparation,
                sessions: input.sessionSystem,
                safety: input.safety,
                skillReceipts: input.skillReceipts,
                ...capabilities,
                turnCapabilities: input.turnCapabilities,
                promptSuggestion,
                // `sessionTitle.enabled: false` disables title generation: wire a
                // no-op so no title model request is issued. Read from the injected
                // config source (same as beta/custom_provider above), default on.
                onInputReviewResolved: createRuntimeTitleHandler(input),
                onSteeringConsumed: observeQuestionnaireAnswerSteering(async (steer) => {
                    // Before the display write: a consumed user input forbids a silent finish.
                    input.bunnyTurnSilence?.recordConsumedSteering(steer);
                    input.bunnyTurnTiming?.steeringConsumed?.(steer);
                    await consumeSteering(steer);
                }, questionnaireAnswerObserver(input, 'steering_consumed')),
                toolPolicyGuard: combineLocalTurnToolPolicyGuards(goalFinalReply.toolPolicyGuard, plan.toolGuard, createGoalBudgetToolPolicyGuard({
                    worksForGoal: (turn) => input.goalPort.goalIdForTurn(turn.sessionId, turn.turnId) !== undefined,
                })),
                outputTokenCap: dependencies.goalVerifierOutputTokenCap,
                askUserPolicy: createAskUserPolicySource(input),
                resolveLlmRetry: () => llmRetry,
                reviewOfflineWait,
                // 送审等了 15 秒以上时发 `content.review.slow`，界面在输入框上方提示检查电脑负荷。
                onSlowReview: createContentReviewSlowEventObserver(input.writeGlobalEvent),
                // 服务端审核开关：开着的轮次交给模型网关审核；关着、请求失败或读不到时在本地送审。
                gatewayReviewEnabled: input.safety.serverReviewEnabled,
                normalExtensions: [
                    ...createCoordinatorTurnExtensions(input),
                    ...(!isLocalSourceProvenanceEnabled(input.options.runtimeOwnerKind)
                        ? []
                        : [
                            createRuntimeSourceReferenceExtension(input.options.compatibility.attachmentRegistration),
                        ]),
                    plan.extension,
                    dependencies.goalVerifierExtension,
                    goalFinalReply.extension,
                    ...dependencies.normalExtensions,
                    ...(input.memory ? [input.memory.agentExtension] : []),
                ],
                ...memorySummaryHostOptions(input.memory),
                ...ptcScriptHostOptions(input, ptcScriptsSwitch(input)),
                eventObserver: combineAgentEventObservers(...(input.channelSystem ? [input.channelSystem.terminalReplies] : []), 
                // Before the lifecycle: it records each event before the terminal one is published.
                input.bunnyTurnSilence, input.turnLifecycleEvents, dependencies.extensionObserver, input.bunnyStateObserver, input.bunnyTurnTiming),
                turnTiming: input.bunnyTurnTiming,
                turnFaults: createRuntimeTurnFaults(input),
                segmentMediaDescriptions: createBunnyMediaDescriptionRepository({
                    db: input.options.bunnyDb,
                    // Read when a description is stored, not while the coordinator is composed.
                    messages: {
                        get: (sessionId, id) => input.sessionSystem.repositories.messages.get(sessionId, id),
                    },
                    nowMs: input.nowMs,
                }),
                nowMs: input.nowMs,
                miniAppApprovals: dependencies.miniAppApprovals,
                ...(isCommandLineRuntimeOwner(input.options.runtimeOwnerKind)
                    ? { cliProductPolicy: true }
                    : {}),
                ...(input.options.runtimeOwnerKind === 'tui' ? { tuiProductPolicy: true } : {}),
                ...(input.options.getRunawayGuardConfig
                    ? { getRunawayGuardConfig: input.options.getRunawayGuardConfig }
                    : {}),
                resolveComputerUseCapture: input.options.resolveComputerUseCapture,
                ...(input.options.getToolResultCompactionConfig
                    ? { getToolResultCompactionConfig: input.options.getToolResultCompactionConfig }
                    : {}),
                getSegmentContextConfig: input.options.getBunnyContextConfig,
            });
            agentHost = production;
            bindRuntimePtcStore(input, production);
            return production.host;
        },
        harnessHistory: lateBoundHarnessHistory(() => agentHost?.history),
        disposeRuntimeSession: async (sessionId) => {
            suggestions.cancel(sessionId);
            try {
                await requireAgentRuntime(agentHost?.lifecycle).disposeSession(sessionId);
            }
            finally {
                await dependencies.disposeMcpSession(sessionId);
            }
        },
        ...createRuntimeTurnAdmissionOptions(input, plan.admission),
        submissionPreparation: createRuntimeSubmissionPreparation(input, plan),
        ...createRuntimeHistoryProjections(input),
        onTurnDiffRewindSkipped: (event) => input.options.logger?.warn({ ...event }, 'Turn diff rewind phase skipped'),
        classifyQueuedItem: queueSelection.classifyQueuedItem,
        shouldYieldFifoPosition: queueSelection.shouldYieldFifoPosition,
        wakesQueueWhileWaitingForUser: createWaitingForUserQueueWake({
            queue: input.sessionSystem.queue.committed,
            sessions: input.sessionSystem.sessions.repository,
            isCoordinatorAgent: createBuiltinCoordinatorAgents({ agents: input.agentService }),
        }),
        createMessageDelivery: createTurnSystemMessageDelivery(input.messageDelivery),
        beforeStart: prepareMentionedMiniApps(input, dependencies.prepareMiniAppTurn),
        onTurnSettling: dependencies.miniAppMemory && releaseMiniAppTurn(dependencies.miniAppMemory),
        ...(input.sessionClio ? { sessionClio: input.sessionClio.capture } : {}),
        turnSettlement: withAssignmentTurnSettlement({
            owns: async (sessionId) => {
                const session = await input.sessionSystem.repositories.sessions.get(sessionId);
                return (session !== undefined &&
                    input.sessionSystem.coordinatorOwnership.standing(session) !== undefined);
            },
            settled: input.assignmentTurnSettled,
        }, input.sessionClio
            ? withSessionClioTurnSettlement(input.sessionClio.capture, input.product.turnSettlement)
            : input.product.turnSettlement),
        onQueueWakeFailure: createQueueWakeFailureReporter(input.product.executor.reportFailure, 'turn_submit_queue_wake_failed'),
        resolveChannelInputModel: input.channelTurnAdmission.resolveChannelInputModel,
        queueSubmissionRejections: input.channelTurnAdmission.queueSubmissionRejections,
        onRuntimeRecoveryFailure: createQueueWakeFailureReporter(input.product.executor.reportFailure, 'runtime_recovery_failed'),
        nowMs: input.nowMs,
    });
    input.options.compatibility.backgroundTasks.bindNotificationReceipts(turnSystem.receipts);
    queueSelection.bindDispatchQueue((sessionId) => turnSystem.turns.dispatchQueue(sessionId));
    return withRuntimeTurnSystemLifecycle(turnSystem, { suggestions, queueSelection, agentHost });
}
/** The production harness history exists only after `createHost`; bind it per call. */
function lateBoundHarnessHistory(current) {
    return {
        inspectContinuation: (request) => requireHarnessHistory(current()).inspectContinuation(request),
        rewind: (request) => requireHarnessHistory(current()).rewind(request),
        fork: (request) => requireHarnessHistory(current()).fork(request),
        inspectForkBoundary: (request) => requireHarnessHistory(current()).inspectForkBoundary(request),
    };
}
/**
 * Queue selection whose AskUser countdown wake dispatches through the Turn
 * System. That owner does not exist yet when its options are built, so the
 * dispatch is bound afterwards; only timers armed by queue classification
 * call it, and classification runs inside the Turn System.
 */
function createTurnQueueSelection(input, plan, planEntryEnabled) {
    let dispatchQueue;
    const selection = createRuntimeQueueSelection({
        computerUseClient: input.options.computerUseClient,
        questionnaires: input.options.compatibility.peripherals.questionnaires,
        goals: input.goalPort,
        queue: input.sessionSystem.queue.committed,
        lifecycleFence: plan.lifecycleFence,
        entryEnabled: planEntryEnabled,
        nowMs: input.nowMs,
        legacyQuestionnaireHoldExempt: createBuiltinCoordinatorAgents({ agents: input.agentService }),
        dispatchQueue: async (sessionId) => {
            if (!dispatchQueue)
                throw new Error('Turn System queue dispatch is not bound');
            await dispatchQueue(sessionId);
        },
        ...(input.options.logger ? { logger: input.options.logger } : {}),
    });
    return {
        ...selection,
        bindDispatchQueue: (dispatch) => {
            dispatchQueue = dispatch;
        },
    };
}
/** A session a Mini App started must not cold-start other Mini Apps by mentioning them. */
function prepareMentionedMiniApps(input, prepareMiniAppTurn) {
    return async ({ input: message, sessionId, turnId, source, signal }) => {
        const record = await input.sessionSystem.sessions.repository.get(sessionId);
        if (record?.miniAppOrigin)
            return;
        const members = [message, ...(message.queuedMessages ?? [])];
        return prepareMiniAppTurn({
            sessionId,
            turnId,
            initiator: mentionInitiator(source, members),
            messages: members.map(({ text }) => ({ content: text })),
            signal,
        });
    };
}
/**
 * An @ mention counts as the local user's (and may put another Mini App to sleep) only when the
 * Desktop user typed every message of the turn: `api` source, and no member of the batch has a
 * channel sender (a remote person on Feishu/Telegram/...) or an origin (a background-task
 * delivery or another session's `session send`). Every source other than `api` starts the turn
 * as `agent`: cron, Goal continuation and subagent turns, and also locally typed code review and
 * questionnaire turns.
 */
function mentionInitiator(source, members) {
    return source === 'api' &&
        members.every(({ origin, channelContext }) => !origin && !channelContext)
        ? 'user'
        : 'agent';
}
/**
 * Drops every hold the turn took (@ references and managed MCP calls). `releaseTurn` cannot throw
 * today; the guard only keeps settlement total. A thrown release would leave the plugins in the
 * foreground tier until restart.
 */
function releaseMiniAppTurn(memory) {
    return (turn) => {
        try {
            memory.releaseTurn(turn);
        }
        catch {
            // The Turn settles regardless.
        }
    };
}
/**
 * Adds the prompt-suggestion port and the harness lifecycle (Plugin Hook
 * Session events and close), and stops suggestions and countdown wake timers
 * on close.
 */
function withRuntimeTurnSystemLifecycle(turnSystem, owners) {
    const { suggestions, queueSelection } = owners;
    const harness = requireAgentRuntime(owners.agentHost?.lifecycle);
    // One close behind both seams: the Turn System's own close releases the Host's
    // resources (the PTC session store's temp tree) even when `turnSystem.close()`
    // fails, and `closeHarness` hands the same close to the services lifecycle.
    // Memoized, so a lifecycle that wraps its own cleanup runs it exactly once.
    let harnessClosing;
    const closeAgentHostResources = () => {
        harnessClosing ??= harness.close();
        return harnessClosing;
    };
    return {
        ...turnSystem,
        pluginHooks: harness.pluginHooks,
        closeHarness: closeAgentHostResources,
        turns: {
            ...turnSystem.turns,
            promptSuggestion: {
                cancel: (sessionId, turnId) => suggestions.cancelTurn(sessionId, turnId),
                read: (sessionId, turnId) => suggestions.read(sessionId, turnId),
            },
        },
        close: async () => {
            suggestions.close();
            queueSelection.close();
            await closeRuntimeTurnSystem(() => turnSystem.close(), closeAgentHostResources);
        },
    };
}
/**
 * Binds the PTC session store so a committed context reset reaches it. With
 * `beta.ptcStore` off there is no store: the binding is told so, and stops
 * remembering resets for a store that will never exist.
 *
 * The Host lifecycle stays on the composition the caller keeps
 * (`agentHost.lifecycle`), which is what Session disposal and the runtime
 * close both read.
 */
function bindRuntimePtcStore(input, production) {
    input.options.prepared?.ptcStoreBinding?.bind(production.ptcSessionStore);
}
/**
 * `sessionTitle.enabled: false` disables title generation: wire a no-op so no
 * title model request is issued. Read from the injected config source (same as
 * beta/custom_provider above), default on.
 */
function createRuntimeTitleHandler(input) {
    const enabled = input.product.preparation.configBuilder.config().sessionTitle?.enabled ?? true;
    return enabled
        ? createApprovedTitleHandler(input.sessionSystem, input.product.executor.reportFailure)
        : () => { };
}
function createRuntimeUserStop(input) {
    return withPptPreviewTaskStop(input.options.compatibility.backgroundTasks.createUserStop({
        pauseActiveGoal: input.goalPort.pauseActiveForAbort,
    }), input.pptPreview);
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
function createRuntimeSubmissionPreparation(input, plan) {
    return composeTurnSubmissionPreparations(createRuntimeAuthSubmissionPreparation(input.options.executionAuthMode, input.product.preparation.modelResolver.authContextGetter), 
    // Counts submissions that passed auth; it never rejects one.
    createSubmissionMemoryMetricsPreparation(input.options.metrics), createPlanEntrySubmissionPreparation(plan), createGoalTurnSubmissionPreparation({
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
    }));
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
/** Memory owns the summary text; the Turn system places it in history. */
function memorySummaryHostOptions(memory) {
    return memory ? { memorySummaryContext: memory.summaryContext } : {};
}
function withTitleReviewCapability(input) {
    return {
        ...withCoordinatorCapabilities(input),
        executor: {
            ...input.product.executor,
            onReplyCommitted: (input.product.preparation.configBuilder.config().sessionTitle?.enabled ?? true)
                ? createReplyTitleReviewHandler(input.sessionSystem, input.product.executor.reportFailure)
                : undefined,
        },
    };
}
/**
 * `beta.ptcScripts`, read once while the Turn System is composed and
 * never again. The switch decides whether run_code offers the saved-script
 * child tool, so a value that changed mid-Session would change the prompt
 * prefix; turning it on or off therefore needs a restart, which is deliberate.
 * Task child capture resolves the switch again per child Session, so the two
 * can disagree until that restart (`ptcScriptsEnabled` in
 * `task-agent-binding-capture.ts`).
 */
function ptcScriptsSwitch(input) {
    return resolveBetaFeature('ptcScripts', input.product.preparation.configBuilder.config().beta?.ptcScripts, currentBetaResolutionContext());
}
/**
 * The PTC script directories and the catalog reminder that lists what is saved
 * in them. The directories are the project `.minimax/ptc`, the user
 * `<dataDir>/ptc` and the skill roots PTC asks for, so a script shipped inside
 * a skill can be imported. A Session that is not in PTC mode gets no catalog at
 * all.
 *
 * Those skill roots are what `ptcScriptSkillRoots` returns for this call,
 * which is still not exactly the set the skill registry ends up scanning: PTC
 * passes no `compatibleAgentNames`, so the compatibility directories of legacy
 * agent names are missing. It does apply the registry's Agent-resource rule
 * (`excludeAgentResources` and the frozen owner incarnation), so the
 * agent-level and Agent-scoped builtin roots the registry would drop are
 * dropped here too.
 *
 * The catalog below lists only the project and user directories
 * (`ptcScriptCatalogDirectories`); a skill root is never listed, so an
 * unverified Agent incarnation has nothing to hide from the reminder even
 * though the loader allowlist is what really decides what `import()` reads.
 *
 * `scriptsEnabled` is `beta.ptcScripts`, already resolved by the caller. Off
 * wires nothing at all, which is the same shape a host without script
 * support has: `ptcScriptSupport` then returns undefined, so no save tool is
 * built, the Worker installs no `import()` loader, and the catalog
 * reminder is withdrawn.
 */
function ptcScriptHostOptions(input, scriptsEnabled) {
    if (!scriptsEnabled)
        return {};
    const config = () => input.product.preparation.configBuilder.config();
    const host = createPtcScriptHost({
        dataDir: () => config().dataDir,
        homeDir: () => homedir(),
        // The Agent resource scope travels with the call: `ptcScriptSupport`
        // forwards this Turn's `agentProfile`, so the roots the loader allowlist
        // gets obey the same private-resource rule the `skill` tool obeys.
        skillRoots: (scope) => ptcScriptSkillRoots(config(), scope),
        refusedImport: ptcScriptRefusedImport,
    });
    return {
        ptcScripts: host,
        ptcScriptCatalog: async (sessionId) => {
            const session = await input.sessionSystem.sessions.repository.get(sessionId);
            // Not a PTC Session, or already gone: no copy may reach the model. Only
            // the tool call mode decides this, so a window that already carries a
            // copy is withdrawn without touching the script directories.
            if (!session || session.toolCallMode !== 'ptc')
                return { status: 'disabled' };
            return {
                status: 'enabled',
                // Reading both directories and every listed header happens here, so it
                // runs only on a Turn that really places a copy.
                load: async () => {
                    const catalog = readPtcScriptCatalog(
                    // The same filtered roots the loader gets, so the reminder never
                    // offers a script `import()` would refuse.
                    host.importable({
                        workspaceDir: session.workspaceDir,
                        agentName: session.agentName,
                        ...(session.isDefaultWorkspace ? { isDefaultWorkspace: true } : {}),
                    }));
                    const content = renderPtcScriptCatalog(catalog);
                    return content
                        ? {
                            content,
                            entries: catalog.entries.length,
                            truncated: catalog.hidden > 0,
                        }
                        : undefined;
                },
            };
        },
        // Counted when a copy really reaches a provider request, not on every Turn
        // that looked for one: a window that already carries a frozen copy places
        // nothing, and an empty catalog places nothing either.
        ptcScriptCatalogInjected: (injected) => report(() => input.product.runner.metricsClient?.histogram('ptc_script_catalog_entries', injected.entries, { truncated: injected.truncated ? 'true' : 'false' })),
    };
}
//# sourceMappingURL=turn-system-composition.js.map