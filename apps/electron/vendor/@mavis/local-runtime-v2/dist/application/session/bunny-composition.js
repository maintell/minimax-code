import { BUNNY_AGENT_NAME, isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { isBunnyVerdictGateEnabledInConfig } from '@mavis/config';
import { assignmentTaskId, createMainSessionIndex, sweepSessionOrphans, } from '../../service/session-system/index.js';
import { assistantReplyProgress, isUserSourcedWakeReason, } from '../../service/turn-system/index.js';
import { initializeBunny, createBunnyResetData, createBunnyFeedbackReport, createBunnyRoundBudgetObserver, recordingBunnyTraceSink, BunnyTelemetry, BunnyTraceStore, BunnyWorklineService, markBunnyFirstUse, } from '../../service/bunny/index.js';
import { createRuntimeGlobalEventWriter } from '../events.js';
import { initializeAssignments, clearDeliveryBaselines, createAssignmentFacts, exportDeliveryBaselines, ownContextState, ownGoalState, readAssignmentAssets, resolveApprovalProject, sessionCreateProject, spaceContextKey, } from '../../service/assignment/index.js';
import { SPACE_CONTEXT_NOTICE_HINT } from '../../service/coordinator-text/index.js';
import { toAssignmentStateView } from './wire.js';
import { BunnyTurnSilenceObserver } from './bunny-turn-silence.js';
import { createBunnyBackgroundReplyChannel } from './bunny-background-reply-channel.js';
import { scopeCoordinatorTurnObservers, scopeCoordinatorTurnTiming, } from './coordinator-turn-scope.js';
import { bindLateBunnyState, composeBunnyStateDelivery, } from './assignment-snapshot-product.js';
import { clearWorkingStateLedger, exportWorkingStateLedger, } from '../../service/working-state/index.js';
import { resolvePluginServiceLogger } from './plugin-service-logger.js';
import { resolveSavedAgentModelReplacement, } from '../../service/model-system/index.js';
import { withBunnyTaskEffort } from './bunny-model-defaults.js';
import { bunnyRootParticipant } from './bunny-root-participant.js';
import { createBunnySteerTiming } from './bunny-steer-timing.js';
import { TaskModelLoginRequiredError } from './bunny-task-model-check.js';
import { taskModelTools } from './bunny-task-model-tools.js';
function spaceTools(system, worklines, assignments, requireCaller) {
    return {
        listWorklines: async ({ callerSessionId }) => {
            await requireCaller(callerSessionId);
            const tasks = await assignments.list(BUNNY_AGENT_NAME, 10000);
            return {
                spaces: (await worklines.list()).map((space) => ({
                    ...space,
                    unfinishedTasks: tasks.filter((task) => task.worklineId === space.id && !task.assignment?.completion).length,
                })),
            };
        },
        getWorkline: async ({ callerSessionId, spaceId }) => {
            await requireCaller(callerSessionId);
            const detail = await worklines.get(spaceId);
            const tasks = (await assignments.list(BUNNY_AGENT_NAME, 10000)).filter((task) => task.worklineId === spaceId && !task.assignment?.completion);
            const { artifacts } = await system.artifactCatalog.list({ spaceId, limit: 10 });
            return { ...detail, tasks: tasks.map(toAssignmentStateView), assets: artifacts };
        },
    };
}
/**
 * The assignment lifecycle tools bound for Bunny's mavis commands. `called` hears a send once its
 * message was admitted (a rejected one is rolled back) and a stop that took effect.
 * @internal Exported only for focused tests.
 */
export function assignmentTools(service, dispatched, called = () => undefined, triggerOf = () => 'unknown') {
    return {
        summarizeAssignments: (input) => service.summarize(input),
        claimAssignmentVerdict: (input) => service.claimVerdict(input),
        cancelAssignment: async ({ reason, ...input }) => ({
            assignment: toAssignmentStateView(await service.setCompletion({
                ...input,
                summary: reason,
                state: 'cancelled',
                by: 'assigner',
            })),
        }),
        stopAssignment: async (input) => {
            const stopped = await service.stop(input);
            called('stop');
            return { assignment: toAssignmentStateView(stopped) };
        },
        resolveAssignmentProject: (caller, toolName, args) => resolveApprovalProject(service, caller, toolName, args),
        // Not a Bunny tool: session_create of any Agent names its project through it.
        resolveSessionProject: (project) => sessionCreateProject(service, project),
        createAssignment: async (input, signal) => {
            signal?.throwIfAborted();
            const accepted = await service.createFromTool({
                ...input,
                trigger: triggerOf(input.callerTurnId),
            });
            if (!accepted.reused)
                dispatched(input);
            return accepted;
        },
        prepareAssignment: async (input, signal) => {
            signal?.throwIfAborted();
            const prepared = await service.prepareSend(input);
            // The session adapter calls this once the message was admitted.
            const admitted = () => called('send', input.reason);
            return Object.assign(prepared, { admitted });
        },
    };
}
/**
 * Bunny creates a space whenever a task it dispatches belongs to none, in any Turn: a Turn woken
 * by a task report or a schedule creates one too. A goal it changes is absorbed.
 */
function worklineTools(worklines, requireCaller, goalChanged) {
    return {
        createWorkline: async ({ callerSessionId, ...input }) => {
            await requireCaller(callerSessionId);
            return { space: await worklines.create(input) };
        },
        updateWorkline: async ({ callerSessionId, workline_id, ...input }) => {
            await requireCaller(callerSessionId);
            const space = await worklines.update(workline_id, input);
            if (input.goal !== undefined)
                goalChanged(space.id, space.goal ?? '');
            return { space };
        },
    };
}
/** A changed summary lists the space's open tasks so Bunny notifies each one itself (S9). */
async function openSpaceTasks(assignments, spaceId) {
    return (await assignments.list('bunny', 10000))
        .filter((task) => task.worklineId === spaceId && !task.assignment?.completion)
        .map((task) => ({
        sessionId: task.session.sessionId,
        title: task.session.title,
        state: task.state,
    }));
}
/** context.md's `<summary>` is Bunny's to write; a stale revision is a conflict, never an overwrite. */
function spaceContextTools(options) {
    const { worklines, requireCaller } = options;
    const space = async (callerSessionId, spaceId) => {
        await requireCaller(callerSessionId);
        return (await worklines.get(spaceId)).space.id;
    };
    return {
        readSpaceContext: async ({ callerSessionId, spaceId }) => {
            const { goal, summary, revision, directory } = worklines.readContext(await space(callerSessionId, spaceId));
            return { goal, summary, revision, directory };
        },
        writeSpaceContext: async ({ callerSessionId, spaceId, summary, sections, revision }) => {
            const id = await space(callerSessionId, spaceId);
            const written = await worklines.writeContext(id, sections ? { sections, revision } : { summary: summary ?? '', revision });
            options.written(id, { summary: written.summary, revision: written.revision });
            if (!written.changed)
                return { revision: written.revision, changed: false };
            const openTasks = await openSpaceTasks(options.assignments, id);
            return openTasks.length
                ? { revision: written.revision, changed: true, openTasks, hint: SPACE_CONTEXT_NOTICE_HINT }
                : { revision: written.revision, changed: true, openTasks };
        },
    };
}
/** Records Bunny's own context.md writes and goal changes in the delivery baseline (spec 9.2). */
function lateAbsorb() {
    let absorb;
    return {
        bind: (value) => {
            absorb = value;
        },
        context: (spaceId, written) => absorb?.(spaceContextKey(spaceId), (delivered) => ownContextState(delivered, written)),
        goal: (spaceId, goal) => absorb?.(spaceContextKey(spaceId), (delivered) => ownGoalState(delivered, goal)),
    };
}
/** Bunny's delta-block delivery, and the rewind that clears its baseline (spec 9.4). */
function composeBunnyState(options, sessionSystem, owners, input) {
    if (!options.bunnyState)
        return undefined;
    const telemetry = options.telemetry;
    const composed = composeBunnyStateDelivery({
        ...input,
        bunnyDb: options.bunnyDb,
        dataDir: options.dataDir,
        sessionSystem,
        inspection: owners.turnSystem.inspection,
        prefixes: options.bunnyState.prefixes,
        ...(options.workingState ? { workingState: options.workingState } : {}),
        ...(options.bunnyState.conversationSearch
            ? { conversationSearch: options.bunnyState.conversationSearch }
            : {}),
        ...(telemetry
            ? {
                trace: telemetry.stateTrace,
                failure: (error) => telemetry.failure({ scope: 'delivery_baseline', error }),
            }
            : {}),
        ...(options.bunnyState.getBunnyContextConfig
            ? { getBunnyContextConfig: options.bunnyState.getBunnyContextConfig }
            : {}),
        ...(options.bunnyState.memoryUnreadable
            ? { memoryUnreadable: options.bunnyState.memoryUnreadable }
            : {}),
        ...(options.bunnyState.emergencyTrace
            ? { emergencyTrace: options.bunnyState.emergencyTrace }
            : {}),
    });
    const unsubscribe = options.eventBus.subscribe({
        next: (event) => {
            if (event.type !== 'message.rewind')
                return;
            if (options.mayCoordinate?.(event.payload.sessionId) === false)
                return;
            composed.delivery.clear(event.payload.sessionId);
        },
    });
    return { ...composed, unsubscribe };
}
/**
 * Local reconciliation in ready(), before startup recovery resumes any task: each space's
 * meta.json is rewritten from its database row. A failure only defers the repair to the next
 * startup; it never blocks Bunny from starting.
 */
async function reconcileSpaceMirrors(sessionSystem, logger, sessionLinks) {
    try {
        await sessionSystem.artifactCatalog.library.reconcileSpaceMirrors({ sessionLinks });
    }
    catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Space meta.json reconciliation failed; it runs again at the next startup');
    }
}
function sessionOrphanGuard(options) {
    return {
        mainDatabaseSafeMode: options.mainDatabaseSafeMode === true,
        persistedStateRecovered: options.recoverPersistedState !== false,
    };
}
/**
 * Startup backstop for C1: assignment tasks whose Session is gone from the main database are
 * deleted before assignment recovery resumes any of them. A failure is logged and only defers
 * the sweep; reads already filter such tasks out.
 */
async function sweepAssignmentOrphans(options, sessionSystem, logger, signal) {
    if (signal.aborted)
        return;
    try {
        const outcome = await sweepSessionOrphans({
            guard: sessionOrphanGuard(options),
            sessions: createMainSessionIndex(options.db),
            rows: sessionSystem.repositories.assignmentCleanup,
        });
        if (outcome.status === 'skipped')
            logger.info({ reason: outcome.reason }, 'Assignment orphan sweep skipped');
        else if (outcome.deleted > 0)
            logger.info(outcome, 'Removed tasks of deleted Sessions');
    }
    catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Assignment orphan sweep failed; it runs again at the next startup');
    }
}
/** How many recent Turns are remembered; a dispatch runs in the Turn itself. */
const USER_INPUT_TURN_LIMIT = 64;
/**
 * The recent Bunny Turns that took the user's own input, newest last, and what woke each
 * recent Turn, for the trigger of the tasks it dispatches.
 */
export class UserInputTurns {
    turns = new Set();
    wakes = new Map();
    record(turnId) {
        this.turns.delete(turnId);
        this.turns.add(turnId);
        if (this.turns.size > USER_INPUT_TURN_LIMIT) {
            const oldest = this.turns.values().next().value;
            if (oldest !== undefined)
                this.turns.delete(oldest);
        }
    }
    /** A Turn was prepared with these wake reasons. */
    woke(turnId, reasons) {
        this.wakes.delete(turnId);
        this.wakes.set(turnId, dispatchTriggerOf(reasons));
        if (this.wakes.size > USER_INPUT_TURN_LIMIT) {
            const oldest = this.wakes.keys().next().value;
            if (oldest !== undefined)
                this.wakes.delete(oldest);
        }
    }
    /** What woke the Turn that dispatched a task; the user's input counts first. */
    trigger(turnId) {
        if (!turnId)
            return 'unknown';
        if (this.turns.has(turnId))
            return 'user';
        return this.wakes.get(turnId) ?? 'unknown';
    }
}
/**
 * A dispatching Turn's trigger: the user's input, then a task report it followed up on, then a
 * cron run; any other wake reads as other.
 * @internal Exported only for focused tests.
 */
export function dispatchTriggerOf(reasons) {
    if (reasons.some(isUserSourcedWakeReason))
        return 'user';
    if (reasons.includes('task_report'))
        return 'task_report';
    if (reasons.includes('cron'))
        return 'cron';
    return 'other';
}
/**
 * Bunny's Turn state port, also recording each Turn that takes the user's own
 * input: woken by a message or a questionnaire answer, or given a steered
 * user message while it runs.
 */
function recordingUserInputTurns(port, turns) {
    return {
        ...port,
        prepare: (input) => {
            turns.woke(input.turnId, input.wakeReasons);
            if (input.wakeReasons.some(isUserSourcedWakeReason))
                turns.record(input.turnId);
            return port.prepare(input);
        },
        steeredRecallPointers: (input) => {
            turns.record(input.turnId);
            return port.steeredRecallPointers?.(input) ?? '';
        },
    };
}
/**
 * Bunny owners are composed after the Turn System, which reads them per call.
 * Bunny's Turn observers are reached for Bunny's own Sessions only.
 */
export function bindLateBunnyOwners(ownership, timing = {}) {
    let owners;
    const get = () => {
        if (!owners)
            throw new Error('Bunny owners are not bound');
        return owners;
    };
    const traceStore = new BunnyTraceStore();
    const telemetry = new BunnyTelemetry({
        trace: recordingBunnyTraceSink(traceStore, timing.trajectory),
        ...(timing.metrics ? { metrics: timing.metrics } : {}),
        ...(timing.logger ? { logger: timing.logger } : {}),
        taskIdOf: assignmentTaskId,
    });
    const state = bindLateBunnyState({ traceStore, telemetry });
    const userInputTurns = new UserInputTurns();
    const observers = scopeCoordinatorTurnObservers(ownership, {
        silence: new BunnyTurnSilenceObserver({ turnEnded: state.turnEnded }),
        state: state.observer,
    });
    return {
        bind: (value) => {
            owners = value;
            if (value.bunnyState)
                state.bind(value.bunnyState);
        },
        /**
         * Bunny's delta block, frozen prefix and trace (spec 8, 9, 17.1). Its Turn state port also
         * records each Turn that takes the user's own input.
         */
        state: { ...state, port: recordingUserInputTurns(state.port, userInputTurns) },
        userInputTurns,
        /** False for a Session whose Agent does not coordinate, or that does not exist. */
        mayCoordinate: observers.mayCoordinate,
        ports: {
            bunnyPermissionMode: () => get().bunny.permissionMode(),
            resolveAssignmentProject: (caller, toolName, args) => resolveApprovalProject(get().assignments, caller, toolName, args),
            // A Turn can settle before the owners are bound; nothing is published then.
            assignmentTurnSettled: (sessionId) => owners?.assignments.turnSettled(sessionId),
            bunnyStateObserver: observers.state,
            bunnyTurnSilence: observers.silence,
            /**
             * Bunny's Turn timing: the steering metrics, and the main request that lets the state
             * trace run after it.
             */
            bunnyTurnTiming: scopeCoordinatorTurnTiming(withRequestSent(createBunnySteerTiming(timing), telemetry), observers.mayCoordinate),
            /** The round budget's per-Turn summary: log and trace. */
            bunnyRoundBudgetSummary: createBunnyRoundBudgetObserver(telemetry),
            /**
             * Whether a Turn is the one checking a task report, read from the task graph. Before the
             * owners are bound there is no graph to read, so such a Turn records no review rather
             * than one it cannot see.
             *
             * `bunnyReferencedSessionRead` is deliberately not supplied here: the consumption probe
             * that answers it is delivered separately, and until it is wired every Turn records
             * `unavailable` — never `not_read`.
             */
            bunnyReviewRound: async (turn) => owners?.assignments.reviewRoundCounts(turn.sessionId, turn.turnId),
        },
    };
}
/**
 * Bunny's Turn timing port, also telling the state trace when the main request went out:
 * at the Turn's first streamed reply event, which arrives only after the provider took the
 * request. A prepared request may still wait for model access and credentials, so the trace is
 * never built before the request is on its way. Only a Turn whose trace still waits reads the
 * event, so a streaming Turn parses nothing more after its first reply event.
 * @internal Exported only for focused tests.
 */
export function withRequestSent(timing, telemetry) {
    if (!telemetry)
        return timing;
    return {
        hostStarted: (turn) => timing.hostStarted(turn),
        mainRequestPrepared: (turn) => timing.mainRequestPrepared(turn),
        steeringPreemption: (turn, result) => timing.steeringPreemption?.(turn, result),
        steeringAdmitted: (input) => timing.steeringAdmitted?.(input),
        steeringConsumed: (input) => timing.steeringConsumed?.(input),
        steeringDiscarded: (input) => timing.steeringDiscarded?.(input),
        observeRuntimeEvent: (input) => {
            const turn = { sessionId: input.context.sessionId, turnId: input.context.turnId };
            if (telemetry.awaitsRequest(turn) && assistantReplyProgress(input.event))
                telemetry.requestSent(turn);
            return timing.observeRuntimeEvent?.(input);
        },
    };
}
function composeBunnyFeedback(options, sessionSystem, owners, nowMs) {
    return createBunnyFeedbackReport({
        db: options.db,
        bunnyDb: options.bunnyDb,
        dataDir: options.dataDir,
        system: sessionSystem,
        latestTurnActivity: (sessionId) => owners.turnSystem.inspection?.latestTurnActivity?.(sessionId) ?? Promise.resolve(undefined),
        handoffHeader: options.handoffHeader,
        ...(options.trace ? { trace: options.trace } : {}),
        nowMs,
    });
}
/**
 * The saved task model as a create selection. A model its official route no
 * longer lists becomes that provider's delivered default (parameters reset),
 * so a retired MiniMax model never silently turns into another provider's
 * Runtime default.
 */
/**
 * Whether config.yaml turns the async review gate on, read from the model-system view of the
 * runtime config.
 *
 * The `bunny` section is not part of that view, so the value is widened in here; the rule itself
 * lives in `@mavis/config` with the two other readers, so the three cannot drift. A host that
 * injects no runtime config leaves the gate off, which is today's behaviour.
 */
function readBunnyVerdictGate(config) {
    return isBunnyVerdictGateEnabledInConfig(config);
}
function bunnyTaskSelection(model, config, logger) {
    const replacement = config ? resolveSavedAgentModelReplacement(config, model) : undefined;
    if (replacement) {
        logger.warn({
            event: 'bunny_task_model_replaced',
            from: `${model.providerId}/${model.modelId}`,
            to: `${replacement.providerId}/${replacement.modelId}`,
        }, 'Bunny task model is no longer available; using the provider default');
        return { ...replacement };
    }
    const { effort, ...selection } = model;
    return { ...selection, ...(effort ? { thinking: { effort } } : {}) };
}
/** What Bunny initialization stops, backs up and clears (spec 2.3). */
function composeBunnyResetData(options, sessionSystem, owners) {
    return createBunnyResetData({ db: options.db, bunnyStore: options.bunnyStore, dataDir: options.dataDir }, sessionSystem, async (sessionId) => {
        const result = await owners.turnSystem.turns.abort({ sessionId, reason: 'bunny-reset' });
        if (result.status === 'abort-timeout' || result.status === 'turn-mismatch')
            throw new Error(`Bunny reset could not stop session: ${sessionId} (${result.status})`);
    }, {
        deleteRoutine: owners.cron
            ? async (cronId) => owners.cron.service.deleteDefinition({ cronId }, { mutationSource: 'system' })
            : undefined,
        restoreRoutine: owners.cron
            ? (command) => owners.cron.service.createDefinition(command, { mutationSource: 'system' })
            : undefined,
        owners: [
            ...(options.workingState
                ? [
                    {
                        name: 'workingState',
                        snapshot: () => exportWorkingStateLedger(options.bunnyDb),
                        clear: clearWorkingStateLedger,
                    },
                ]
                : []),
            // Bunny initialization starts every main conversation over with a full state (spec 2.3).
            {
                name: 'deliveryBaseline',
                snapshot: () => exportDeliveryBaselines(options.bunnyDb),
                clear: clearDeliveryBaselines,
            },
        ],
    });
}
/** Saving a task model checks what a task would run: a retired official model as its replacement. */
function withTaskModelCheck(owners, logger) {
    const check = owners.taskModelCheck;
    if (!check)
        return {};
    return {
        validateTaskModel: async (model) => {
            try {
                await check(bunnyTaskSelection(model, owners.modelConfig?.(), logger));
            }
            catch (error) {
                // Signing in is the user's state, not the model's: the dispatch on it says so then.
                if (error instanceof TaskModelLoginRequiredError)
                    return;
                throw error;
            }
        },
    };
}
/**
 * The model a task Bunny dispatches runs on: the task model the user saved, else Apollo's
 * `agent_config.bunny.default_task_model` while the setting was never written at all, else the
 * Runtime default; with the task default effort when none was chosen (requirement 5.1). Only the
 * user picks it: a model named on Bunny's behalf is ignored (MCT-202611-KWIJTTR0). A task model the
 * user saved, or cleared on purpose, is never replaced by the remote default.
 * Other assigners keep the model they named.
 */
function bunnyTaskModel(bunny, owners, logger, remote) {
    return async (agentName, named) => {
        if (!isBunnyAgentName(agentName))
            return named;
        const config = owners.modelConfig?.();
        const { stored, model } = await bunny.taskModelState();
        const selection = model ? bunnyTaskSelection(model, config, logger) : undefined;
        if (!config)
            return selection;
        // A task model the user saved — or cleared on purpose — is never replaced by a remote default;
        // only a setting that was never written at all may take Apollo's.
        return withBunnyTaskEffort(config, selection, stored ? undefined : remote(), logger);
    };
}
/**
 * Bunny's main conversation. One without a model of its own, fresh or created by initialization,
 * gets Apollo's `agent_config.bunny.default_model` when it sent a usable one, else the Runtime
 * default, at Bunny's default effort, before Bunny uses it (requirement 5.1); a restored backup
 * keeps the model it had.
 *
 * None of that is materialized here. `getRootSessionByAgent` reads through the Root application,
 * whose single participant carries the default for every Root it hands out — the ones `replaceRoot`
 * and `adoptRoot` adopt, and the ones a read has the invariant service repair or create, including
 * a Root a product reads through the shared application without ever passing through this port.
 * See {@link bindBunnyRootParticipant}.
 */
function bunnyRoots(sessionSystem, owners) {
    return {
        hasRoot: async (name) => (await sessionSystem.repositories.sessions.list({
            agentName: name,
            runtime: 'pi-agent',
            sessionType: 'root',
            includeSessionKinds: ['conversation'],
            archived: false,
            includeHidden: true,
        })).length > 0,
        getRootSessionByAgent: (name) => owners.applications.session.root.getRootSessionByAgent(name),
        replaceRoot: async (name) => {
            const next = await sessionSystem.sessions.records.createRootSession({ agentName: name });
            return owners.applications.session.root.replaceRootSessionByAgent(name, next.sessionId);
        },
        adoptRoot: (name, sessionId) => owners.applications.session.root.replaceRootSessionByAgent(name, sessionId),
    };
}
/**
 * Registers the main-conversation model default on the Root application, the one path every Bunny
 * Root takes on both of its timings. Bound once the Bunny owners exist, before any Root is handed
 * out.
 */
function bindBunnyRootParticipant(sessionSystem, owners, logger, remote) {
    owners.applications.session.root.bindRootParticipant(bunnyRootParticipant({
        records: sessionSystem.sessions.records,
        modelConfig: () => owners.modelConfig?.(),
        logger,
        remote,
    }));
}
export function composeBunnyOwners(options, sessionSystem, owners, nowMs) {
    const logger = resolvePluginServiceLogger(options.logger);
    const remoteModelDefaults = () => options.getBunnyModelDefaults?.();
    bindBunnyRootParticipant(sessionSystem, owners, logger, remoteModelDefaults);
    let closed = false;
    const publish = createRuntimeGlobalEventWriter({
        isClosed: () => closed,
        nowMs,
        write: (event) => options.eventBus.write(event),
    });
    const bunny = initializeBunny({
        bunnyDb: options.bunnyDb,
        dataDir: options.dataDir,
        agents: {
            requireBuiltin: async (name) => {
                const agent = await options.agentService.getPersistedOwner(name);
                if (agent?.creationSource !== 'builtin')
                    throw new Error('Bunny requires its built-in Agent; remove the conflicting custom Agent first.');
            },
        },
        roots: bunnyRoots(sessionSystem, owners),
        withMemoryLock: options.withMemoryLock,
        resetData: composeBunnyResetData(options, sessionSystem, owners),
        logger,
        ...withTaskModelCheck(owners, logger),
    });
    const worklines = new BunnyWorklineService(sessionSystem.artifactCatalog.library, (workline) => publish({
        type: 'workline.updated',
        payload: { workline: sessionSystem.artifactCatalog.library.getSpace(workline.id).space },
    }));
    // Writes Bunny makes itself never come back as news (spec 9.2).
    const absorbed = lateAbsorb();
    const assignments = initializeAssignments({
        sessions: sessionSystem.repositories.sessions,
        tasks: sessionSystem.repositories.assignmentTasks,
        coordinators: sessionSystem.coordinatorOwnership.roster,
        projects: sessionSystem.repositories.projects,
        records: sessionSystem.sessions.records,
        taskModel: bunnyTaskModel(bunny, owners, logger, remoteModelDefaults),
        ...(owners.taskModelCheck ? { checkModel: owners.taskModelCheck } : {}),
        worklines,
        ...(options.compatibility.sessionV2
            ? { workingDirectory: options.compatibility.sessionV2.workspace.defaultDirectory }
            : {}),
        internalDirectories: () => [options.dataDir],
        assets: async (sessionId, turnId) => readAssignmentAssets(options.db, sessionId, turnId),
        stream: sessionSystem.stream,
        messages: sessionSystem.repositories.messages,
        conversation: owners.runtimeConversation,
        agents: {
            displayName: async (name) => (await options.agentService.get(name)).displayName,
            currentRoot: async (name) => (await sessionSystem.sessions.root.getRootSessionByAgent(name)).sessionId,
        },
        facts: createAssignmentFacts({
            sessions: sessionSystem,
            inspection: owners.turnSystem.inspection,
            ...options.compatibility.peripherals,
            ...(options.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
        }),
        events: options.eventBus,
        logger,
        nowMs,
        // Off unless config.yaml sets bunny.verdictGate: a task Bunny dispatched a review for
        // may only be concluded once that review reported a verdict and Bunny read it.
        verdictGate: () => readBunnyVerdictGate(owners.modelConfig?.()),
    }, (status) => publish({
        type: 'assignment.updated',
        payload: { assignment: toAssignmentStateView(status) },
    }));
    options.bindClosedTaskBackgroundRoute?.({
        deliver: (ownerSessionId, tasks) => assignments.closedTaskBackground.deliver(ownerSessionId, tasks),
        // A wake for background tasks Bunny started from an IM chat also replies there.
        replyChannel: createBunnyBackgroundReplyChannel({
            sessions: sessionSystem.repositories.sessions,
            root: sessionSystem.sessions.root,
            messages: sessionSystem.repositories.messages,
        }),
    });
    const bunnyState = composeBunnyState(options, sessionSystem, owners, {
        stateView: assignments.stateView,
        viewState: () => bunny.viewState(),
        nowMs,
    });
    if (bunnyState)
        absorbed.bind(bunnyState.absorb);
    const requireBunnyCaller = async (id) => {
        const caller = await sessionSystem.repositories.sessions.get(id);
        if (!caller || !isBunnyAgentName(caller.agentName) || caller.archived)
            throw new Error('Only bunny sessions can manage worklines');
    };
    options.compatibility.bindAssignmentTools?.({
        ...worklineTools(worklines, requireBunnyCaller, absorbed.goal),
        ...spaceTools(sessionSystem, worklines, assignments.service, requireBunnyCaller),
        ...taskModelTools({
            bunny,
            ...(owners.listModels ? { listModels: owners.listModels } : {}),
            requireCaller: requireBunnyCaller,
            logger,
        }),
        ...spaceContextTools({
            written: absorbed.context,
            worklines,
            assignments: assignments.service,
            requireCaller: requireBunnyCaller,
        }),
        ...assignmentTools(assignments.service, ({ callerSessionId }) => {
            try {
                markBunnyFirstUse(options.bunnyDb, 'dispatch', nowMs());
            }
            catch (error) {
                options.telemetry?.failure({ scope: 'first_use', error, sessionId: callerSessionId });
            }
        }, (action, reason) => options.telemetry?.assignmentCalled(action, reason), (turnId) => options.userInputTurns?.trigger?.(turnId) ?? 'unknown'),
        isBunnyTask: (sessionId) => sessionSystem.repositories.assignmentTasks.assignerOf(sessionId) === BUNNY_AGENT_NAME,
        confirmBunnyTask: (sessionId) => sessionSystem.repositories.assignmentTasks.storedAssignerOf(sessionId) === BUNNY_AGENT_NAME,
    });
    return {
        services: {
            bunny,
            worklines,
            assignments: assignments.service,
            /** The materialized task state Bunny's handoff headers read (spec 9.6, 12.9). */
            stateView: assignments.stateView,
            bunnyFeedback: composeBunnyFeedback(options, sessionSystem, owners, nowMs),
            ...(bunnyState ? { bunnyState: { delivery: bunnyState.delivery } } : {}),
        },
        /** A startup recovery step; the runtime skips it when persisted state is not recovered. */
        recoverAssignments: async (signal) => {
            // A store that holds nothing has no task to sweep or resume; reading it would create it.
            if (!options.bunnyStore.hasData())
                return;
            // Before recover(), whose service.ready() would resume a task of a deleted Session.
            await sweepAssignmentOrphans(options, sessionSystem, logger, signal);
            await assignments.recover(signal);
        },
        lifecycle(ready, close) {
            let readiness;
            let closing;
            return {
                ready: () => {
                    if (closing)
                        return Promise.resolve();
                    // A failed attempt is not cached, so a later ready() retries the owners.
                    readiness ??= (async () => {
                        // Bunny's own startup steps never fail the runtime; Bunny reports its error and the
                        // rest of the runtime gets ready, as memory's ready already does.
                        try {
                            // A store that holds nothing has no space to list or mirror yet.
                            if (options.bunnyStore.hasData()) {
                                await worklines.list();
                                await reconcileSpaceMirrors(sessionSystem, logger, sessionOrphanGuard(options));
                            }
                        }
                        catch (error) {
                            logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Bunny spaces could not get ready; the rest of the runtime keeps starting');
                        }
                        try {
                            await ready();
                        }
                        catch (error) {
                            readiness = undefined;
                            throw error;
                        }
                    })();
                    return readiness;
                },
                close: () => {
                    closed = true;
                    closing ??= (async () => {
                        try {
                            bunnyState?.unsubscribe();
                            await assignments.close();
                        }
                        finally {
                            await close();
                        }
                    })();
                    return closing;
                },
            };
        },
    };
}
//# sourceMappingURL=bunny-composition.js.map