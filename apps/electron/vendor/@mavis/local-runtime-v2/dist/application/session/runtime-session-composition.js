import { settleInBackground } from '../../service/plugin-system/index.js';
import { isLocalSourceProvenanceEnabled } from '@mavis/config';
import { incrementMetric } from '@mavis/shared/local-runtime-logging/metrics';
import { BUNNY_LIBRARY_ROOT_AGENTS, projectBunnyGreetingOrigin, bunnyTaskHistoryObserver, } from '../../service/bunny/index.js';
import { inputReviewDisposition, productOutputReviewPolicy, SAFETY_SCENE, } from '../../service/content-safety/index.js';
import { CUSTOM_PROVIDER_ID_PREFIX, ModelAccessRelist, initializeModelSystem, freezeManagedQueueModel, resolveRequestedSessionModel, LocalModelProviderError, resolveBuiltinAgentModelGroup, previewAgentModelSelection, resolveEffectiveAgentModelSelection, AgentModelSelectionError, } from '../../service/model-system/index.js';
import { createSessionSystemPinBridge, initializePinService, } from '../../service/pin/index.js';
import { ArtifactLibraryService, createAssignmentTaskRepository, createCanonicalRecoveryLoggerAdapter, initializeSessionSystem, QueueServiceError, readSessionAdditionalWorkspaceRoots, } from '../../service/session-system/index.js';
import { createFileApiRuntime, createProductionAgentPreparation, createPtcStoreDecision, createProductionRootArchiveTitleModel, createProductionSessionTitleModel, createSessionModelRepair, agentHostModelFromQueue, } from '../../service/turn-system/index.js';
import { createBuiltinAgentSurfacePolicy } from '../agent/agent-surface-policy.js';
import { createRuntimeAgentProduct } from '../agent/runtime-agent-product.js';
import { bunnyMessageWriteObservers } from './bunny-message-writes.js';
import { withAdvisorAgentProduct } from './advisor-agent-product.js';
import { withGoalAgentProduct } from './goal-agent-product.js';
import { withQuotaAutoResumeProduct } from './quota-auto-resume-product.js';
import { createRuntimeGoalPort } from './runtime-goal-port.js';
import { initializeGoalService, isGoalVerifierChildSession, } from '../../service/goal/index.js';
import { createApplicationFactPorts, createCommittedModelProviderSessionPort, } from './fact-ports.js';
import { createSessionToolCallModePolicy } from './session-tool-call-mode-policy.js';
import { createPinnedAgentLookup } from './pin-agent-lookup.js';
import { ModelProviderApplication } from './model-provider-application.js';
import { ChannelAgentModelSelectionError, previewChannelAgentModelSelection, resolveChannelAgentQueueModel, selectChannelAgentModel, } from './channel-agent-model-selection.js';
import { createRuntimeCompactionFactSink } from './runtime-compaction-facts.js';
import { createSessionTitlePolicy } from './session-title-policy.js';
import { describeError } from './turn-message-delivery.js';
import { createQueueSubmissionRejectionDelivery, queryCollapseSteeringProjection, } from '../conversation/index.js';
function createRuntimeToolCallModePolicy(input) {
    return createSessionToolCallModePolicy(input.modelConfig.read, input.logger, {
        ...(input.ptcDefault ? { ptcDefault: input.ptcDefault } : {}),
        ...(input.metrics ? { metrics: input.metrics } : {}),
    });
}
export function createProductionSessionComposition(input) {
    const visible = createVisibleModelConfig(input.modelConfig);
    const visibleInput = { ...input, modelConfig: visible.port };
    const tuiProductPolicy = input.runtimeOwnerKind === 'tui';
    let executionSessionSystem;
    const baseProduct = createRuntimeAgentProduct({
        baseProduct: input.baseProduct,
        agentService: input.agentService,
        ensureSessionAgentDefinition: async (sessionId) => {
            const sessionSystem = executionSessionSystem;
            if (!sessionSystem)
                throw new Error('Session Agent definition reader is unavailable during runtime composition.');
            return await sessionSystem.sessions.records.ensureSessionAgentDefinition(sessionId);
        },
        modelConfig: visible.port,
        logger: input.logger,
        nowMs: input.nowMs,
        runtimeOwnerKind: input.runtimeOwnerKind,
        capabilityProfile: input.capabilityProfile,
        miniappAvailable: input.miniappAvailable,
        pptPreviewAvailable: input.pptPreviewAvailable,
        browserUse: input.browserUse,
        implicitCustomProviderThinking: tuiProductPolicy,
        ...(input.systemPromptOverrides ? { systemPromptOverrides: input.systemPromptOverrides } : {}),
        agentReferenceProjection: input.agentReferenceProjection,
        ...(input.inspector ? { inspector: input.inspector } : {}),
        internalTurnPromptReads: input.internalTurnPromptReads,
        globalInstructions: input.globalInstructions,
        ...(input.promptSnapshots ? { promptSnapshots: input.promptSnapshots } : {}),
        modelAccessExtensionTool: input.modelAccess?.extensionTool,
    });
    const { goal, goalPort, bindGoalCronOwnerReader } = composeGoalOwner(input, baseProduct, () => executionSessionSystem?.queue.committed);
    const product = composeAdvisorProduct(composeSessionProduct(baseProduct, goal, input.quotaAutoResume), input, {
        preparation: () => preparation,
        sessionSystem: () => executionSessionSystem,
    });
    const modelSystem = createSessionModelSystem(input, product);
    visible.bind(() => modelSystem.providers.modelCatalogConfig?.());
    input.agentService.bindBuiltinModelGroupResolver(async ({ previous, bundled }) => resolveBuiltinAgentModelGroup({ config: visible.read(), previous, bundled }));
    bindAgentConfigModelPorts({
        agentService: input.agentService,
        modelConfig: visible.port,
        logger: input.logger,
    });
    const preparation = createProductionAgentPreparation({
        configBuilder: {
            ...product.preparation.configBuilder,
            // One decision for this whole assembly: the Agent Host's store and the PTC
            // prompt line that names it read this same getter, so they cannot disagree.
            ptcStoreRequested: createPtcStoreDecision(product.preparation.configBuilder.config()),
        },
        modelResolver: modelSystem.resolver,
        ...(input.logger ? { logger: input.logger } : {}),
    });
    const facts = createSessionFactPorts(input, goal);
    const archiveTitleModel = createProductionRootArchiveTitleModel({ agents: product.agents, preparation, safety: input.safety }, input.nowMs);
    const sessionPin = createSessionSystemPinBridge();
    const sessionSystem = initializeSessionSystem({
        db: input.db,
        ...bunnyStoreRepositories(input),
        ...(input.coordinatorRoster ? { coordinatorRoster: input.coordinatorRoster } : {}),
        sourceProjectionEnabled: isLocalSourceProvenanceEnabled(input.runtimeOwnerKind),
        messageWriteObservers: bunnyMessageWriteObservers(input.bunnyDb),
        dataDir: input.dataDir,
        agents: input.agentSessionPorts.directory,
        rootAgents: input.agentSessionPorts.roots,
        ...sessionSurfaceOptions(input),
        defaultWorkspaceDir: input.compatibility.workspace.defaultDirectory,
        titlePolicy: createSessionTitlePolicy({
            config: visible.read,
            safety: input.safety,
            readDefinition: (sessionId) => sessionSystem.repositories.sessions.getSessionAgentDefinition(sessionId),
        }),
        resolveRequestedModel: (model) => resolveRequestedSessionModel(visible.read(), model),
        toolCallMode: createRuntimeToolCallModePolicy(input),
        backfillDiagnostics: createSessionBackfillDiagnostics({
            logger: input.logger,
            reportFailure: product.executor.reportFailure,
        }),
        ...createProjectHistoryRepairOptions(input),
        legacyMigration: {
            ...input.compatibility.legacyMigration,
            onCanonicalRecovery: createCanonicalRecoveryLoggerAdapter(input.logger),
        },
        inputNavigationDiffs: input.compatibility.diff.inputNavigation,
        storageRetention: {
            pruneTurnDiffs: input.compatibility.diff.pruneExpired,
            logger: input.logger,
        },
        onPinnedSessionImported: sessionPin.onImported,
        pinnedProjectIds: sessionPin.pinnedProjectIds,
        facts: facts.session,
        conversationFacts: facts.conversation,
        queueFacts: facts.queue,
        resolveQueueModel: createQueueModelResolver(visibleInput, () => executionSessionSystem),
        ...createRuntimeEventSinks(input.inspector, input.publishGlobalEvent),
        ...(input.metrics ? { compactionMetrics: input.metrics } : {}),
        title: createSessionTitleOptions(input, { agents: product.agents, preparation }),
        nowMs: input.nowMs,
        runtimeOwnerIdentity: input.runtimeOwnerIdentity,
    });
    executionSessionSystem = sessionSystem;
    const channelTurnAdmission = createChannelTurnAdmission(input, visibleInput, sessionSystem);
    const pinService = createRuntimePinService(input, sessionSystem);
    sessionPin.bind(pinService);
    input.compatibility.bindSessionPinReader((sessionId) => pinService.isSessionPinned(sessionId));
    preparation.bindSessionModelRepair(createSessionModelRepair(sessionSystem.sessions.records, input.logger, modelUpdatedFactSink(facts)));
    preparation.bindTaskSessionBindings(sessionSystem.sessions.records);
    preparation.bindAdditionalWorkspaceRoots((sessionId) => readSessionAdditionalWorkspaceRoots(sessionSystem.repositories.projects, sessionId));
    const modelProviderApplication = new ModelProviderApplication({
        publish: input.publishGlobalEvent,
        tuiProductPolicy,
        config: visible.read,
        providers: modelSystem.providers,
        sessions: createCommittedModelProviderSessionPort({
            get: async (sessionId) => {
                const session = await sessionSystem.repositories.sessions.get(sessionId);
                if (!session)
                    return undefined;
                const binding = await sessionSystem.repositories.sessions.getSessionAgentDefinition(sessionId);
                const frozenModel = binding?.definition.definitionVersion === 2 ? binding.definition.model : undefined;
                return { ...session, frozenModel };
            },
            update: (sessionId, fields) => sessionSystem.sessions.records.mutateSession(sessionId, fields),
            onCommittedUpdate: modelUpdatedFactSink(facts),
        }),
        setDefaultModel: input.modelConfig.setDefaultModel,
        setDefaultAdvisor: input.modelConfig.setDefaultAdvisor,
        refreshOfficialModels: input.refreshOfficialModels,
        resolveChannelSelection: ({ agentName }) => resolveChannelSelection(visibleInput, agentName),
        selectChannelModel: async ({ agentName, selection }) => await selectChannelAgentModel({
            config: visible.read(),
            agents: input.agentService,
            agentName,
            selection,
        }),
        ...(tuiProductPolicy ? { implicitCustomProviderThinking: true } : {}),
    });
    return {
        product,
        preparation,
        modelSystem,
        modelAccessRelistLifecycle: createModelAccessRelistLifecycle(input, modelSystem),
        modelProviderApplication,
        sessionSystem,
        pinService,
        globalInstructions: input.globalInstructions,
        archiveTitleModel,
        facts,
        channelTurnAdmission,
        goal,
        goalPort,
        bindGoalCronOwnerReader,
    };
}
/** Title generation for new Sessions. */
function createSessionTitleOptions(input, owners) {
    return {
        model: createProductionSessionTitleModel(owners, input.nowMs),
        reviewPromptSnapshots: input.promptSnapshots,
        ...(input.metrics
            ? {
                onOutcome: (outcome) => input.metrics?.counter('session_title_generation_total', 1, { outcome }),
                onReviewOutcome: (outcome) => incrementMetric(input.metrics, 'session_title_review_total', 1, { outcome }),
            }
            : {}),
        // Title failures stay Session-scoped diagnostics, never runtime turn failures.
        onFailure: ({ stage, sessionId, error }) => input.logger.warn({ sessionId, stage, reason: `session_title_${stage}_failed:${describeError(error)}` }, 'session title generation failed'),
    };
}
/**
 * What Session System applies without knowing who owns it: built-in Agent surface facts,
 * steered provenance, origin markers and the roots that feed the artifact library.
 */
function sessionSurfaceOptions(input) {
    return {
        agentSurfaces: createBuiltinAgentSurfacePolicy({
            agents: input.agentService,
            dataDir: input.dataDir,
        }),
        steeringProjection: (queryKey) => ({ ...queryCollapseSteeringProjection(queryKey) }),
        originProjection: projectBunnyGreetingOrigin,
    };
}
/** The Session System's repositories over the Bunny store; it never holds that connection. */
function bunnyStoreRepositories(input) {
    return {
        assignmentTasks: createAssignmentTaskRepository({
            db: input.bunnyDb,
            sessions: input.db,
            storeHasData: () => input.bunnyStore.hasData(),
            nowMs: input.nowMs,
            // Bunny's task events are counted in its assignment metrics as they are written.
            historyWritten: bunnyTaskHistoryObserver(input.runtimeOwnerKind, input.metrics, input.db),
        }),
        artifactLibrary: new ArtifactLibraryService(input.db, input.bunnyDb, input.dataDir, BUNNY_LIBRARY_ROOT_AGENTS),
    };
}
/** Adds the advisor tool; its owners are late-bound and both exist before any Turn runs. */
function composeAdvisorProduct(product, input, owners) {
    return withAdvisorAgentProduct(product, {
        preparation: owners.preparation,
        sessions: () => {
            const owner = owners.sessionSystem();
            if (!owner)
                throw new Error('Session system is unavailable for the advisor tool.');
            return {
                getExecutionSnapshot: (sessionId) => owner.sessions.execution.getExecutionSnapshot(sessionId),
                recordUsage: (record) => owner.usage.projector.record(record),
            };
        },
        // The same Files API wiring as the Turn executor's requests.
        fileApi: createFileApiRuntime({ db: input.db, nowMs: input.nowMs, product: product.fileApi }),
        logger: input.logger,
        // A managed advisor is reviewed like a managed main model: the Turn's input and the output,
        // with the same scenes, verdict rules and region policy.
        contentReview: {
            reviewInput: async (text) => inputReviewDisposition(await input.safety.review(text, SAFETY_SCENE.UserInput)),
            blocksAdvice: (text) => input.safety.blocks(text, SAFETY_SCENE.MessageOutput),
            policy: productOutputReviewPolicy(input.runtimeOwnerKind),
        },
        nowMs: input.nowMs,
    });
}
/** 已提交事实的端口；撤回时经各自的服务重开问卷、删除目标。 */
function createSessionFactPorts(input, goal) {
    return createApplicationFactPorts({
        publish: input.publishGlobalEvent,
        questionnaires: input.compatibility.questionnaires,
        goals: goal.service,
        logger: input.logger,
    });
}
/**
 * The Turn product every Session runs on: the Goal wiring, plus the quota
 * auto-resume feed only where a Desktop-owned Runtime supplies its owner.
 */
function composeSessionProduct(baseProduct, goal, quotaAutoResume) {
    const goalProduct = withGoalAgentProduct(baseProduct, goal);
    return quotaAutoResume ? withQuotaAutoResumeProduct(goalProduct, quotaAutoResume) : goalProduct;
}
/** Build the single Goal owner over the product it borrows turn infrastructure from. */
function composeGoalOwner(input, baseProduct, committedQueue) {
    let goalCronOwnerReader;
    const goal = initializeGoalService({
        db: input.db,
        legacyQueueItems: committedQueue,
        stoppedQueue: committedQueue,
        nowMs: input.nowMs,
        publishGlobalEvent: input.publishGlobalEvent,
        configGetter: baseProduct.preparation.configBuilder.config,
        reportFailure: (sessionId, message) => baseProduct.executor.reportFailure?.(sessionId, message),
        formatError: describeError,
        host: {
            ...input.goalHost,
            hasAutomationOwnerConflict: async (sessionId) => (await input.goalHost.hasActiveTeamOwner(sessionId)) ||
                goalCronOwnerReader?.(sessionId) === true,
            isGoalVerifierChildSession: async (sessionId) => isGoalVerifierChildSession(await input.goalHost.readSessionFacts(sessionId)),
            sessionExists: async (sessionId) => (await input.goalHost.readSessionFacts(sessionId)) !== undefined,
            promptSnapshots: () => input.promptSnapshots,
            internalTurnPromptReads: () => input.internalTurnPromptReads,
        },
    });
    const goalPort = createRuntimeGoalPort(goal);
    input.goalHost.bindQuestionnaireWorkOwner(goal.questionnaireOwner);
    input.goalHost.bindSubSessionRoundAttribution({
        attributeRound: (round) => goal.service.attributeSubSessionRound(round),
        forgetRound: (childTurnId) => goal.service.forgetSubSessionRound(childTurnId),
    });
    return {
        goal,
        goalPort,
        bindGoalCronOwnerReader: (reader) => {
            goalCronOwnerReader = reader;
        },
    };
}
/** The model config with extension catalogs merged in, once `bind` names their source. */
function createVisibleModelConfig(config) {
    let catalog;
    const read = () => catalog?.() ?? config.read();
    return {
        read,
        port: { ...config, read },
        bind: (source) => {
            catalog = source;
        },
    };
}
function createSessionModelSystem(input, product) {
    return initializeModelSystem({
        config: input.modelConfig,
        resolverOptions: {
            ...product.preparation.modelResolver,
            ...(input.modelAccess ? { modelAccess: input.modelAccess } : {}),
        },
        ...(product.fileApi?.fetchImpl ? { fetchImpl: product.fileApi.fetchImpl } : {}),
        ...(input.runtimeOwnerKind === 'tui' ? { implicitCustomProviderThinking: true } : {}),
    });
}
/**
 * The product owners (Electron, TUI) re-read their model-access providers' model lists hourly
 * (ModelAccessRelist); other owners have none.
 */
function createModelAccessRelistLifecycle(input, modelSystem) {
    if (!input.modelAccess ||
        (input.runtimeOwnerKind !== 'electron' && input.runtimeOwnerKind !== 'tui'))
        return undefined;
    const relist = new ModelAccessRelist({
        config: input.modelConfig.read,
        refresh: (providerKey, signal) => modelSystem.providers.discoverModels(`${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`, {
            modelAccess: { signal },
        }),
        usable: (providerKey) => input.modelAccess?.requests.owns(providerKey) !== false,
        warn: (fields, message) => input.logger.warn({ ...fields }, message),
    });
    let stopMigrations;
    const adoptMigratedEntries = async (providerKeys) => {
        try {
            await modelSystem.providers.adoptModelAccessInstallations(providerKeys);
        }
        catch (error) {
            input.logger.warn({ event: 'model_access_migration_adopt_failed', error: String(error) }, 'model access provider entries were not re-pointed');
        }
    };
    return {
        start: () => {
            relist.start();
            // A package split moved bindings: point their provider entries at the new installation.
            stopMigrations ??= input.modelAccess?.onCredentialsMigrated?.((providerKeys) => {
                settleInBackground(adoptMigratedEntries(providerKeys));
            });
        },
        close: () => {
            stopMigrations?.();
            stopMigrations = undefined;
            return relist.close();
        },
    };
}
/** Publishes a committed Session model write; `replacedFrom` marks a retired-model replacement. */
function modelUpdatedFactSink(facts) {
    return (session, replacedFrom) => facts.session.handle({
        kind: 'model-updated',
        session,
        ...(replacedFrom ? { replacedFrom } : {}),
    });
}
function createChannelTurnAdmission(input, visibleInput, sessionSystem) {
    return {
        queueSubmissionRejections: createQueueSubmissionRejections(input, sessionSystem),
        // Channel input resolves against the visible model catalog (extension catalogs included).
        resolveChannelInputModel: createChannelInputModelResolver(visibleInput, sessionSystem),
    };
}
/** Session-system facts the Runtime republishes as Global Events. */
function createRuntimeEventSinks(inspector, publishGlobalEvent) {
    return {
        compactionFacts: createRuntimeCompactionFactSink(inspector, publishGlobalEvent),
        // Advisory progress while a worktree is created; the create request result stays authoritative.
        worktreeProgress: (progress) => publishGlobalEvent({ type: 'workspace.worktree.progress', payload: progress }),
    };
}
function createQueueModelResolver(input, getSessionSystem) {
    return async (session, model, queueInput, explicitModelUpdate) => {
        const sessionSystem = requireExecutionSessionSystem(getSessionSystem);
        const trustedRequeue = trustedFrozenChannelRequeueModel(session, queueInput);
        if (trustedRequeue)
            return trustedRequeue;
        if (session.sessionKind === 'channel' && (queueInput || explicitModelUpdate)) {
            return await resolveChannelAgentQueueModelAtAdmission({
                config: input.modelConfig.read(),
                agents: input.agentService,
                session,
                targetAgentId: await channelTargetAgentId(sessionSystem, session.sessionId, queueInput?.message.channelContext?.targetAgentId),
            });
        }
        const binding = model
            ? undefined
            : await sessionSystem.repositories.sessions.getSessionAgentDefinition(session.sessionId);
        const frozenModel = binding?.definition.definitionVersion === 2 ? binding.definition.model : undefined;
        try {
            return freezeManagedQueueModel(input.modelConfig.read(), session, model, frozenModel);
        }
        catch (error) {
            if (error instanceof LocalModelProviderError)
                throw new QueueServiceError('model-invalid', error.message);
            throw error;
        }
    };
}
function createChannelInputModelResolver(input, sessionSystem) {
    return async ({ sessionId, input: userInput }) => {
        const session = await sessionSystem.repositories.sessions.get(sessionId);
        if (!session || session.sessionKind !== 'channel')
            return undefined;
        return agentHostModelFromQueue(await resolveChannelAgentQueueModelAtAdmission({
            config: input.modelConfig.read(),
            agents: input.agentService,
            session,
            targetAgentId: await channelTargetAgentId(sessionSystem, sessionId, userInput.channelContext?.targetAgentId),
        }));
    };
}
async function resolveChannelAgentQueueModelAtAdmission(input) {
    try {
        return await resolveChannelAgentQueueModel(input);
    }
    catch (error) {
        if (error instanceof ChannelAgentModelSelectionError) {
            throw new QueueServiceError('model-invalid', error.message, error.details);
        }
        throw error;
    }
}
function requireExecutionSessionSystem(getSessionSystem) {
    const sessionSystem = getSessionSystem();
    if (!sessionSystem) {
        throw new Error('Session model reader unavailable before composition completes');
    }
    return sessionSystem;
}
function trustedFrozenChannelRequeueModel(session, queueInput) {
    if (session.sessionKind !== 'channel' ||
        queueInput?.queuePlacement !== 'front' ||
        queueInput.immediateSendBatch === undefined ||
        queueInput.model?.frozen !== true) {
        return undefined;
    }
    return queueInput.model;
}
async function channelTargetAgentId(sessionSystem, sessionId, targetAgentId) {
    const explicitTarget = targetAgentId?.trim();
    if (explicitTarget)
        return explicitTarget;
    const binding = await sessionSystem.repositories.sessions.getSessionAgentDefinition(sessionId);
    return binding?.definition.definitionVersion === 2
        ? binding.definition.ownerInstanceId
        : undefined;
}
function createQueueSubmissionRejections(input, sessionSystem) {
    return createQueueSubmissionRejectionDelivery({
        messages: sessionSystem.messages.repository,
        sessions: sessionSystem.repositories.sessions,
        stream: sessionSystem.stream,
        publish: input.publishGlobalEvent,
        formatModelInvalid: input.formatChannelModelInvalid,
        onModelRejected: (event) => {
            input.logger.warn({
                stage: 'model_invalid',
                sessionId: event.sessionId,
                ...(event.clientRequestId ? { clientRequestId: event.clientRequestId } : {}),
                ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
                ...(event.error.model ? { model: event.error.model } : {}),
                ...(event.error.modelSource ? { modelSource: event.error.modelSource } : {}),
                error: event.error.message,
            }, 'channel model admission rejected');
        },
        onDisplayWriteFailure: (event) => reportQueueSubmissionRejectionWriteFailure(input, event),
        nowMs: input.nowMs,
    });
}
function reportQueueSubmissionRejectionWriteFailure(input, event) {
    const error = describeError(event.error);
    const fields = {
        stage: 'display_write_failed',
        sessionId: event.sessionId,
        ...(event.clientRequestId ? { clientRequestId: event.clientRequestId } : {}),
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        error,
    };
    input.logger.warn(fields, 'channel model rejection display write failed');
    input.baseProduct.executor.reportFailure?.('channel-model-admission', `stage=display_write_failed;sessionId=${event.sessionId};clientRequestId=${event.clientRequestId ?? ''};dedupeKey=${event.dedupeKey ?? ''};error=${error}`);
}
function createSessionBackfillDiagnostics(input) {
    return {
        reportAgentDefinitionSkip: (entry) => {
            input.logger.warn({
                code: entry.code,
                reason: entry.reason,
                sessionId: entry.sessionId,
                agentName: entry.agentName,
                status: entry.status,
                sessionKind: entry.sessionKind,
            }, 'startup_backfill_agent_definition_skipped');
            input.reportFailure?.('startup-backfill', `owner=session-system;stage=startup-backfill;reason=${entry.reason};code=${entry.code};sessionId=${entry.sessionId};agentName=${entry.agentName}`);
        },
    };
}
function createProjectHistoryRepairOptions(input) {
    return {
        rootProjectHistoryRepairDiagnostics: createRootProjectHistoryRepairDiagnostics({
            logger: input.logger,
        }),
        legacyDefaultProjectHistoryRepairDiagnostics: createLegacyDefaultProjectHistoryRepairDiagnostics({ logger: input.logger }),
        archivedProjectSidebarBaselineDiagnostics: createArchivedProjectSidebarBaselineDiagnostics({
            logger: input.logger,
        }),
        getAgentOwnerIdentity: createAgentOwnerIdentityReader(input.agentService),
    };
}
function createAgentOwnerIdentityReader(agentService) {
    return async (agentName) => {
        try {
            const document = await agentService.getConfigDocument(`agent:${agentName}`);
            return {
                exactOwnerName: document.exactOwnerName,
                ownerKind: document.ownerKind,
                ...(document.ownerInstanceId ? { ownerInstanceId: document.ownerInstanceId } : {}),
            };
        }
        catch {
            // Historical repair is evidence-bound: an unreadable current owner is not proof.
            return undefined;
        }
    };
}
function createRootProjectHistoryRepairDiagnostics(input) {
    return {
        reportSummary: (summary) => input.logger.info({
            scanned: summary.scanned,
            repaired: summary.repaired,
            repairedSessionIds: summary.repairedSessionIds,
            failed: summary.failed,
            skipped: summary.skipped,
        }, 'startup_root_project_history_repair_summary'),
        reportFailure: (entry) => input.logger.warn({
            stage: entry.stage,
            error: entry.error,
            ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
            ...(entry.agentName ? { agentName: entry.agentName } : {}),
        }, 'startup_root_project_history_repair_failed'),
    };
}
function createLegacyDefaultProjectHistoryRepairDiagnostics(input) {
    return {
        reportSummary: (summary) => input.logger.info({
            scanned: summary.scanned,
            repaired: summary.repaired,
            repairedSessionIds: summary.repairedSessionIds,
            failed: summary.failed,
            skipped: summary.skipped,
        }, 'startup_legacy_default_project_history_repair_summary'),
        reportFailure: (entry) => input.logger.warn({
            stage: entry.stage,
            reason: entry.reason,
            ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
            ...(entry.agentName ? { agentName: entry.agentName } : {}),
        }, 'startup_legacy_default_project_history_repair_failed'),
    };
}
function createArchivedProjectSidebarBaselineDiagnostics(input) {
    return {
        reportSummary: (summary) => {
            if (!summary.applied)
                return;
            input.logger.info({ hiddenProjectIds: summary.hiddenProjectIds }, 'startup_archived_project_sidebar_baseline_applied');
        },
        reportFailure: (error) => input.logger.warn({ error }, 'startup_archived_project_sidebar_baseline_failed'),
    };
}
function createRuntimePinService(input, sessionSystem) {
    return initializePinService({
        db: input.db,
        // The lookup isolates one broken agent.md (AgentConfigError) per pinned
        // ref so a single invalid Agent cannot 500 the sidebar/pin aggregates;
        // see createPinnedAgentLookup for the layering rationale.
        agents: {
            get: createPinnedAgentLookup({ agentService: input.agentService, logger: input.logger }),
        },
        sessions: sessionSystem.repositories.sessions,
        projects: sessionSystem.projects.service,
        projectRepository: sessionSystem.repositories.projects,
        ...(input.compatibility.legacyMigration?.readPinnedItemsOrder
            ? { legacyOrder: input.compatibility.legacyMigration.readPinnedItemsOrder }
            : {}),
        legacyPinnedAgents: () => input.agentService.listLegacyPinnedAgentRefs(),
        nowMs: input.nowMs,
    });
}
/**
 * Binds the three Agent-model ports the Agent service needs from ModelSystem.
 *
 * Extracted from `createProductionSessionComposition` to keep that function
 * within its size budget; the binding order carries no meaning, but all three
 * must be bound before the HTTP surface accepts Agent reads or writes.
 *
 * - preview diagnostics: observability for reads that degraded silently
 * - effective resolver: best-effort preview, degrades to `undefined`
 * - candidate validator: strict save gate, rejects instead of degrading
 */
function bindAgentConfigModelPorts(ports) {
    // Unexpected preview failures are invisible to the user by design (the
    // Config GET still succeeds with no effective model), so this sink is the
    // only way a degraded Agent detail page can be diagnosed after the fact.
    ports.agentService.bindConfigPreviewDiagnostics((event) => {
        ports.logger.warn({
            event: 'agent_config_effective_model_preview_failed',
            agent_name: event.exactOwnerName,
            stage: event.stage,
            error_name: event.errorName,
            error_message: event.errorMessage,
            ...(event.errorStack === undefined ? {} : { error_stack: event.errorStack }),
        }, 'Agent Config effective-model preview failed; returning the configuration without it');
    });
    ports.agentService.bindEffectiveConfigResolver(async ({ profile, configuredModelSelection }) => {
        const selection = profile.configSelection?.model
            ? profile.configSelection
            : configuredModelSelection;
        const resolved = previewAgentModelSelection({
            config: ports.modelConfig.read(),
            sources: selection.model
                ? [
                    {
                        source: 'agent-config-preview',
                        selection,
                        requireCatalog: true,
                        allowCustomProviderPrefixFallback: true,
                        defaultMissingEffortOff: true,
                    },
                ]
                : [],
        });
        return resolved
            ? {
                providerId: resolved.providerId,
                modelId: resolved.modelId,
                ...(resolved.effort ? { effort: resolved.effort } : {}),
                ...(resolved.contextWindow === undefined
                    ? {}
                    : { contextWindow: resolved.contextWindow }),
                ...(resolved.maxOutputTokens === undefined
                    ? {}
                    : { maxOutputTokens: resolved.maxOutputTokens }),
            }
            : undefined;
    });
    // Strict counterpart of the preview resolver above. Same catalog rules and
    // the same `sources: []` fallback, but it reports *why* the selection is
    // unusable instead of degrading to `undefined`, so a save can be rejected
    // with an actionable message.
    ports.agentService.bindCandidateModelValidator(async ({ exactOwnerName, configuredModelSelection }) => {
        // An absent `model` is NOT an error: the Agent inherits the runtime
        // default, which is how `definitionOnly` Agents and most Custom Agents
        // are created. Passing no source lets the resolver apply that default,
        // and only a runtime with no default at all yields `undefined`.
        const sources = configuredModelSelection.model
            ? [
                {
                    source: 'agent-config-save',
                    selection: configuredModelSelection,
                    requireCatalog: true,
                    allowCustomProviderPrefixFallback: true,
                    defaultMissingEffortOff: true,
                },
            ]
            : [];
        // `resolveEffectiveAgentModelSelection` returns `undefined` only for
        // MODEL_SELECTION_INCOMPLETE (nothing configured anywhere) and throws
        // `AgentModelSelectionError` when a selection is present but unusable
        // — removed model, disabled catalog entry, missing provider. Both are
        // user-fixable and become a 422; anything else is a genuine defect and
        // is deliberately left to propagate.
        try {
            const resolved = resolveEffectiveAgentModelSelection({
                config: ports.modelConfig.read(),
                sources,
            });
            if (resolved)
                return { ok: true };
            ports.logger.warn({
                event: 'agent_config_model_rejected',
                agent_name: exactOwnerName,
                reason: 'not_configured',
                has_explicit_model: Boolean(configuredModelSelection.model),
            }, 'Rejecting Agent write: no Agent model and no runtime default are configured');
            return { ok: false, reason: 'not_configured' };
        }
        catch (error) {
            if (!(error instanceof AgentModelSelectionError))
                throw error;
            ports.logger.warn({
                event: 'agent_config_model_rejected',
                agent_name: exactOwnerName,
                reason: 'unavailable',
                model: configuredModelSelection.model,
                selection_error_code: error.code,
            }, 'Rejecting Agent write: selected model cannot be resolved against the current catalog');
            return { ok: false, reason: 'unavailable', detail: error.message };
        }
    });
}
/** The channel Agent's effective model selection, as the model provider application reads it. */
async function resolveChannelSelection(input, agentName) {
    const selection = await previewChannelAgentModelSelection({
        config: input.modelConfig.read(),
        agents: input.agentService,
        agentName,
    });
    return selection
        ? {
            providerId: selection.providerId,
            modelId: selection.modelId,
            ...(selection.reasoning === undefined ? {} : { reasoning: selection.reasoning }),
            ...(selection.contextWindow === undefined ? {} : { contextLimit: selection.contextWindow }),
            ...(selection.effort === undefined ? {} : { effort: selection.effort }),
        }
        : undefined;
}
//# sourceMappingURL=runtime-session-composition.js.map