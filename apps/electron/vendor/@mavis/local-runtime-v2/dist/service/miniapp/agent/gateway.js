import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isMiniAppAgentPermissionDecision, MINIAPP_AGENT_MAX_TEXT_LENGTH, } from '@mavis/shared/miniapp-surface';
import { detach } from '../../channel-system/settle.js';
import { MINIAPP_AGENT_NAME, MINIAPP_AGENT_QUEUE_FACTOR, MiniAppAgentError, } from './contracts.js';
import { readMiniAppAgentModelSelection } from './model-selection.js';
const MAX_REQUEST_ID_LENGTH = 256;
const AUDIT_MESSAGE = 'Mini App Agent run';
/**
 * Host-side admission for Mini App Agent runs: policy, per-plugin run slots with a bounded FIFO
 * of waiting calls, ownership, audit.
 */
export function createMiniAppAgentGateway(options) {
    const state = {
        options,
        arenas: new Map(),
        listeners: new Map(),
        panels: new Map(),
    };
    return {
        bind(next) {
            state.unsubscribeAsks?.();
            state.ports = next;
            state.unsubscribeAsks = next.subscribePermissionAsks((ask) => forwardAsk(state, ask));
        },
        registerArena: (arena) => registerArena(state, arena),
        async run(caller, input, runOptions = {}) {
            const requested = readRequestedModel(input.model);
            const agent = readRequestedAgent(input.agent, input.sessionId);
            return startTurn(state, {
                caller,
                operation: 'run',
                sessionId: input.sessionId,
                runOptions,
                ...requested.call,
                ...agent.call,
                start: (bound, turn) => bound.runTurn({ ...turn, text: input.text }),
            }, invalidText(input.text) ?? requested.invalid ?? agent.invalid);
        },
        async answer(caller, input, runOptions = {}) {
            const requested = readRequestedModel(input.model);
            return startTurn(state, {
                caller,
                operation: 'answer',
                sessionId: input.sessionId,
                runOptions,
                ...requested.call,
                start: (bound, turn) => bound.answerQuestion({ ...turn, requestId: input.requestId, answers: input.answers }),
            }, invalidAnswer(input) ?? requested.invalid);
        },
        models: (caller) => listModelOptions(state, caller),
        agents: (caller) => listAgentOptions(state, caller),
        create: (caller, input = {}) => createBoundSession(state, caller, input.agent),
        reply: (caller, input) => replyPermission(state, caller, input),
        open: (caller, input) => openSession(state, caller, input),
        panelOpened({ sessionId, hostSessionId }) {
            const hosts = state.panels.get(sessionId) ?? new Set();
            hosts.add(hostSessionId);
            state.panels.set(sessionId, hosts);
            state.options.logger.info({ sessionId, hostSessionId }, 'Mini App Agent session shown in a side panel');
        },
        panelClosed({ sessionId, hostSessionId }) {
            const hosts = state.panels.get(sessionId);
            if (!hosts)
                return;
            hosts.delete(hostSessionId);
            if (hosts.size === 0)
                state.panels.delete(sessionId);
        },
        async shouldDenyApproval(sessionId, lineage) {
            // No Mini App run can exist before bind, so nothing here can be a Mini App ask.
            if (!state.ports)
                return false;
            const root = await resolveApprovalRoot(state.ports, sessionId, lineage);
            return root !== undefined && !canAnswer(state, root);
        },
    };
}
/**
 * The Mini App root an ask belongs to. The Turn's lineage spares the storage walk for every
 * root session; only a delegated child (or a caller without lineage) walks up to its root.
 */
async function resolveApprovalRoot(ports, sessionId, lineage) {
    if (lineage?.miniApp)
        return sessionId;
    // An ordinary root session or a SideChat (`parentSessionId: null`) is never a Mini App ask.
    if (lineage && !lineage.parentSessionId)
        return undefined;
    return (await ports.resolveMiniAppRoot(sessionId))?.rootSessionId;
}
/**
 * Someone can answer an ask of this Mini App root: the run that owns it registered `onEvent`,
 * or the Host reported it shown in a chat side panel. Where it was created is not evidence.
 */
function canAnswer(state, rootSessionId) {
    return state.listeners.has(rootSessionId) || state.panels.has(rootSessionId);
}
function registerArena(state, arena) {
    const previous = state.arenas.get(arena.pluginId);
    if (previous)
        releaseEntry(previous);
    const maxConcurrent = arena.policy.kind === 'allowlist' ? arena.policy.maxConcurrent : 0;
    const entry = {
        processGeneration: arena.processGeneration,
        policy: arena.policy,
        maxConcurrent,
        maxQueued: maxConcurrent * MINIAPP_AGENT_QUEUE_FACTOR,
        inflight: new Set(),
        runningSessions: new Set(),
        queue: [],
    };
    state.arenas.set(arena.pluginId, entry);
    return () => {
        releaseEntry(entry);
        if (state.arenas.get(arena.pluginId) === entry)
            state.arenas.delete(arena.pluginId);
    };
}
/** Nothing waits on a released arena: queued calls are cancelled, in-flight runs aborted. */
function releaseEntry(entry) {
    for (const queued of entry.queue.splice(0))
        queued.cancel();
    for (const controller of entry.inflight)
        controller.abort();
}
function reject(state, caller, error, fields = {}) {
    state.options.logger.warn({
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        source: caller.source,
        phase: 'rejected',
        errorCode: error.code,
        ...fields,
    }, AUDIT_MESSAGE);
    return error;
}
/**
 * Fails closed until bound, then checks the caller's arena and its policy. A caller of an
 * older generation (its page `runId` is stale or the Node process restarted) is unavailable,
 * not refused: the current generation may run.
 */
function authorize(state, caller) {
    if (!state.ports) {
        throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent is not available');
    }
    const arena = state.arenas.get(caller.pluginId);
    const refused = (reason) => reject(state, caller, new MiniAppAgentError('NOT_PERMITTED', 'Mini App is not permitted to run the Agent'), { reason });
    // No arena: never authorized, or retired / revoked.
    if (!arena)
        throw refused('no-arena');
    if (!allowsRun(arena.policy))
        throw refused('policy');
    if (arena.processGeneration !== caller.processGeneration) {
        throw reject(state, caller, new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent caller is out of date', true), { reason: 'generation-mismatch' });
    }
    return { bound: state.ports, arena };
}
function admit(state, call, invalid) {
    const { caller, sessionId } = call;
    const admitted = authorize(state, caller);
    if (invalid !== undefined) {
        throw reject(state, caller, new MiniAppAgentError('INVALID_ARGUMENTS', invalid));
    }
    if (sessionId !== undefined && admitted.arena.runningSessions.has(sessionId)) {
        throw busy(state, call, 'session_busy');
    }
    return admitted;
}
function busy(state, call, reason) {
    const message = reason === 'session_busy'
        ? 'Mini App Agent session is already running'
        : 'Too many Mini App Agent runs are waiting';
    return reject(state, call.caller, new MiniAppAgentError('BUSY', message, true, reason), {
        reason,
    });
}
/**
 * Admits a `run` / `answer` into a free slot, or queues it behind the calls already waiting so
 * runs start in strict FIFO order.
 */
async function startTurn(state, call, invalid) {
    const admitted = admit(state, call, invalid);
    const { arena } = admitted;
    const slot = arena.inflight.size < arena.maxConcurrent && arena.queue.length === 0
        ? occupy(arena, call.sessionId)
        : await enqueue(state, arena, call);
    return execute(state, admitted, call, slot);
}
function occupy(arena, sessionId, queuedAt) {
    const controller = new AbortController();
    arena.inflight.add(controller);
    if (sessionId !== undefined)
        arena.runningSessions.add(sessionId);
    return { controller, ...(queuedAt === undefined ? {} : { queuedAt }) };
}
/** Hands each free slot to the oldest waiting call; a refused call leaves the slot to the next. */
function drain(arena) {
    while (arena.inflight.size < arena.maxConcurrent) {
        const next = arena.queue.shift();
        if (!next)
            return;
        next.dequeue();
    }
}
/**
 * Waits for a slot. The slot is taken synchronously in `drain`, so no later call can overtake;
 * leaving the queue (caller abort, arena release) settles as `REQUEST_CANCELLED`.
 */
function enqueue(state, arena, call) {
    const { signal } = call.runOptions;
    if (arena.queue.length >= arena.maxQueued) {
        throw busy(state, call, 'queue_full');
    }
    if (signal?.aborted)
        throw cancelledWhileQueued(state, call);
    const position = arena.queue.length + 1;
    return new Promise((resolve, rejectWait) => {
        const leave = () => signal?.removeEventListener('abort', onAbort);
        const entry = {
            dequeue() {
                leave();
                const { sessionId } = call;
                // An earlier waiting call for the same session started first.
                if (sessionId !== undefined && arena.runningSessions.has(sessionId)) {
                    rejectWait(busy(state, call, 'session_busy'));
                    return;
                }
                resolve(occupy(arena, sessionId, position));
            },
            cancel() {
                leave();
                rejectWait(cancelledWhileQueued(state, call));
            },
        };
        const onAbort = () => {
            const index = arena.queue.indexOf(entry);
            if (index === -1)
                return;
            arena.queue.splice(index, 1);
            entry.cancel();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        arena.queue.push(entry);
        notifyQueued(state, call, position);
    });
}
function cancelledWhileQueued(state, call) {
    return reject(state, call.caller, new MiniAppAgentError('REQUEST_CANCELLED', 'Mini App Agent run was cancelled'), {
        stage: 'queue',
        operation: call.operation,
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
    });
}
/** `run.queued` precedes admission, so it names a session only when the call continues one. */
function notifyQueued(state, call, position) {
    const { onEvent } = call.runOptions;
    if (!onEvent)
        return;
    const { sessionId } = call;
    try {
        onEvent({ type: 'run.queued', ...(sessionId === undefined ? {} : { sessionId }), position });
    }
    catch (error) {
        state.options.logger.warn({ pluginId: call.caller.pluginId, position, errorName: errorName(error) }, 'Mini App Agent listener threw on run.queued');
    }
}
/** Registers the run's caller as the one who answers its asks, for the run's duration. */
function listen(state, sessionId, onEvent) {
    if (!onEvent)
        return { dispose: () => undefined };
    const listener = { onEvent };
    state.listeners.set(sessionId, listener);
    return {
        onEvent: (event) => {
            if ('turnId' in event && event.turnId)
                listener.turnId = event.turnId;
            onEvent(event);
        },
        dispose: () => {
            if (state.listeners.get(sessionId) === listener)
                state.listeners.delete(sessionId);
        },
    };
}
/**
 * Routes an ask to the run of its Mini App root; an ask of a delegated child session keeps
 * the child's `sessionId`, which is what the author replies with.
 */
function forwardAsk(state, ask) {
    const direct = state.listeners.get(ask.sessionId);
    if (direct) {
        deliverAsk(state, direct, ask);
        return;
    }
    const ports = state.ports;
    // Only an in-flight run can answer; skip the ancestry walk for every other session's ask.
    if (!ports || state.listeners.size === 0)
        return;
    detach(forwardDelegatedAsk(state, ports, ask));
}
async function forwardDelegatedAsk(state, ports, ask) {
    try {
        const root = await ports.resolveMiniAppRoot(ask.sessionId);
        const listener = root && state.listeners.get(root.rootSessionId);
        if (listener)
            deliverAsk(state, listener, ask);
    }
    catch (error) {
        state.options.logger.warn({
            stage: 'ask-routing',
            sessionId: ask.sessionId,
            requestId: ask.requestId,
            ...(ask.turnId ? { turnId: ask.turnId } : {}),
            errorName: errorName(error),
            error: error instanceof Error ? error.message : String(error),
        }, 'Mini App Agent permission ask routing failed');
    }
}
function deliverAsk(state, listener, ask) {
    const turnId = ask.turnId ?? listener.turnId;
    try {
        listener.onEvent({
            type: 'permission.requested',
            sessionId: ask.sessionId,
            ...(turnId === undefined ? {} : { turnId }),
            requestId: ask.requestId,
            toolName: ask.toolName,
            ...(ask.toolInput === undefined ? {} : { toolInput: ask.toolInput }),
            reason: ask.reason,
        });
    }
    catch (error) {
        // A listener failure must not break the approval publisher.
        state.options.logger.warn({
            sessionId: ask.sessionId,
            requestId: ask.requestId,
            errorName: errorName(error),
        }, 'Mini App Agent listener threw on ask');
    }
}
async function execute(state, admitted, call, slot) {
    const { bound, arena } = admitted;
    const { runOptions } = call;
    const { controller, queuedAt } = slot;
    let runningSessionId = call.sessionId;
    let listener;
    const signal = runOptions.signal
        ? AbortSignal.any([controller.signal, runOptions.signal])
        : controller.signal;
    try {
        // Before the session exists: an unusable model must not leave a new session behind.
        const requested = await resolveRequestedModel(state, bound, call);
        const { sessionId, agentName, model } = await resolveSession(state, bound, call, requested);
        if (runningSessionId === undefined) {
            runningSessionId = sessionId;
            arena.runningSessions.add(sessionId);
        }
        if (signal.aborted) {
            // The session may be new and hidden; leave a trace of it with the cancel.
            throw reject(state, call.caller, new MiniAppAgentError('REQUEST_CANCELLED', 'Mini App Agent run was cancelled'), {
                stage: 'admission',
                operation: call.operation,
                sessionId,
                cancelledAfterCreate: agentName !== undefined,
            });
        }
        // A new session is created with the requested model already; only an existing one is switched.
        if (call.sessionId !== undefined) {
            await saveSessionModel(state, bound, call, { sessionId, model: requested });
        }
        listener = listen(state, sessionId, runOptions.onEvent);
        const turn = { sessionId, signal, ...(listener.onEvent ? { onEvent: listener.onEvent } : {}) };
        return await dispatch(state, call, { sessionId, agentName, model: requested ?? model, queuedAt }, () => call.start(bound, turn));
    }
    finally {
        listener?.dispose();
        arena.inflight.delete(controller);
        if (runningSessionId !== undefined)
            arena.runningSessions.delete(runningSessionId);
        drain(arena);
    }
}
/**
 * Checks the model the call asked for like the composer does, once the call holds its slot and
 * before its session is created. `INVALID_ARGUMENTS` reaches the caller as it is.
 */
async function resolveRequestedModel(state, bound, call) {
    if (!call.model)
        return undefined;
    try {
        return await bound.resolveModel(call.model);
    }
    catch (error) {
        throw modelFailure(state, call, error, {
            stage: 'resolve-model',
            ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        });
    }
}
/** Persists the resolved model on the (now existing) session; a failure leaves nothing dispatched. */
async function saveSessionModel(state, bound, call, target) {
    const { sessionId, model } = target;
    if (!model)
        return;
    try {
        await bound.setSessionModel(sessionId, model);
    }
    catch (error) {
        throw modelFailure(state, call, error, { stage: 'set-session-model', sessionId });
    }
}
/**
 * A failure before the session ran anything: a `MiniAppAgentError` (e.g. INVALID_ARGUMENTS) reaches
 * the caller as it is, anything else is a retryable `AGENT_UNAVAILABLE`.
 */
function setupFailure(state, caller, error, context) {
    if (!(error instanceof MiniAppAgentError))
        return unavailable(state, caller, error, context);
    return reject(state, caller, error, { ...context, errorName: errorName(error) });
}
function modelFailure(state, call, error, context) {
    return setupFailure(state, call.caller, error, { ...context, operation: call.operation });
}
async function dispatch(state, call, admission, start) {
    const { options } = state;
    const { caller } = call;
    const { sessionId, agentName, model, queuedAt } = admission;
    const startedAtMs = options.nowMs();
    const audit = {
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        source: caller.source,
        sessionId,
        operation: call.operation,
    };
    const logTerminal = (fields) => options.logger.info({ ...audit, phase: 'terminal', ...fields, durationMs: options.nowMs() - startedAtMs }, AUDIT_MESSAGE);
    options.logger.info({
        ...audit,
        phase: 'admission',
        ...(agentName ? { agentName } : {}),
        ...(model ? { model: `${model.providerId}/${model.modelId}` } : {}),
        ...(queuedAt === undefined ? {} : { queued: true, position: queuedAt }),
    }, AUDIT_MESSAGE);
    try {
        const result = await start();
        logTerminal({ status: result.status });
        return { sessionId, ...result };
    }
    catch (error) {
        // The turn may already be dispatched, so an unexpected failure cannot be reported as not run.
        const failure = error instanceof MiniAppAgentError
            ? error
            : new MiniAppAgentError('AGENT_OUTCOME_UNKNOWN', 'Mini App Agent run outcome is unknown');
        logTerminal({
            status: 'error',
            stage: 'turn',
            errorCode: failure.code,
            errorName: errorName(error),
        });
        throw failure;
    }
}
/** A Mini App never writes the user's permission rules: only `allowOnce` / `deny` pass. */
async function replyPermission(state, caller, input) {
    const { bound } = authorize(state, caller);
    const invalid = invalidReply(input);
    if (invalid !== undefined) {
        throw reject(state, caller, new MiniAppAgentError('INVALID_ARGUMENTS', invalid));
    }
    await requireOwnedTree(state, bound, caller, input.sessionId);
    let outcome;
    try {
        outcome = await bound.replyPermission(input);
    }
    catch (error) {
        // Only a failure before the decision was dispatched arrives as a Mini App Agent error;
        // anything else may have applied the decision.
        const failure = error instanceof MiniAppAgentError
            ? error
            : new MiniAppAgentError('AGENT_OUTCOME_UNKNOWN', 'Mini App Agent reply outcome is unknown');
        throw reject(state, caller, failure, {
            stage: 'reply',
            operation: 'reply',
            sessionId: input.sessionId,
            requestId: input.requestId,
            decision: input.decision,
            errorName: errorName(error),
        });
    }
    state.options.logger.info({
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        source: caller.source,
        sessionId: input.sessionId,
        operation: 'reply',
        decision: input.decision,
        outcome,
    }, AUDIT_MESSAGE);
    if (outcome === 'skipped') {
        throw new MiniAppAgentError('REQUEST_NOT_FOUND', 'Mini App Agent request is not pending');
    }
}
/**
 * Any root session this plugin owns may be shown in the caller's host chat side panel, whichever
 * chat or Node run created it; a delegated child never qualifies.
 */
async function openSession(state, caller, input) {
    const { bound } = authorize(state, caller);
    const { hostSessionId } = caller;
    if (!hostSessionId) {
        throw reject(state, caller, new MiniAppAgentError('NOT_PERMITTED', 'Mini App is not open in a chat session'));
    }
    const { sessionId } = input;
    if (!isId(sessionId)) {
        throw reject(state, caller, new MiniAppAgentError('INVALID_ARGUMENTS', 'Mini App Agent open needs a sessionId'));
    }
    let root;
    try {
        root = await bound.resolveMiniAppRoot(sessionId);
    }
    catch (error) {
        throw unavailable(state, caller, error, { stage: 'open-lookup', sessionId });
    }
    // Any session this plugin owns may be shown in the chat the Mini App is open in now;
    // where it was created only decides its agent and working directory.
    if (root?.rootSessionId !== sessionId || root.pluginId !== caller.pluginId) {
        throw reject(state, caller, new MiniAppAgentError('SESSION_NOT_FOUND', 'Mini App Agent session not found'));
    }
    state.options.logger.info({
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        source: caller.source,
        sessionId,
        operation: 'open',
    }, AUDIT_MESSAGE);
    return { sessionId, hostSessionId };
}
/** `run` / `answer` continue the Mini App session itself, never one of its delegated children. */
async function requireOwned(state, bound, caller, sessionId) {
    await requireOwner(state, caller, sessionId, () => bound.getOwner(sessionId));
}
/** A permission ask may come from the Mini App session or any session it delegated to. */
async function requireOwnedTree(state, bound, caller, sessionId) {
    await requireOwner(state, caller, sessionId, async () => (await bound.resolveMiniAppRoot(sessionId))?.pluginId);
}
async function requireOwner(state, caller, sessionId, readOwner) {
    let owner;
    try {
        owner = await readOwner();
    }
    catch (error) {
        throw unavailable(state, caller, error, { stage: 'ownership', sessionId });
    }
    if (owner !== caller.pluginId) {
        throw reject(state, caller, new MiniAppAgentError('SESSION_NOT_FOUND', 'Mini App Agent session not found'));
    }
}
/**
 * `agentName` is set only for a newly created session; continuing never changes the agent or
 * the working directory, both bound at creation.
 */
async function resolveSession(state, bound, call, requestedModel) {
    const { caller, sessionId } = call;
    if (sessionId !== undefined) {
        await requireOwned(state, bound, caller, sessionId);
        return { sessionId };
    }
    return bindNewSession(state, bound, caller, {
        agent: call.agent,
        operation: call.operation,
        model: requestedModel,
    });
}
/** Creates the session a first `run` would, in the agent / directory / model the caller's context gives. */
async function bindNewSession(state, bound, caller, request) {
    const { pluginId, hostSessionId } = caller;
    try {
        const context = await creationContext(state, bound, caller, request.agent);
        const { agentName, workspaceDir, createDir } = context;
        const model = request.model ?? context.model;
        // The default's limit belongs to the default selection only, not to a model the call chose.
        const contextWindow = request.model ? undefined : context.contextWindow;
        const created = await bound.createSession({
            pluginId,
            agentName,
            workspaceDir,
            createDir,
            model,
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(hostSessionId ? { hostSessionId } : {}),
        });
        return { sessionId: created.sessionId, agentName, model };
    }
    catch (error) {
        throw setupFailure(state, caller, error, {
            stage: 'create-session',
            operation: request.operation,
        });
    }
}
/** `create`: a session bound like a first `run`'s, with no turn and no run slot. */
async function createBoundSession(state, caller, agent) {
    const { bound } = authorize(state, caller);
    const requested = readRequestedAgent(agent, undefined);
    if (requested.invalid !== undefined) {
        throw reject(state, caller, new MiniAppAgentError('INVALID_ARGUMENTS', requested.invalid));
    }
    const { sessionId, agentName, model } = await bindNewSession(state, bound, caller, {
        agent: requested.call.agent,
        operation: 'create',
    });
    state.options.logger.info({
        pluginId: caller.pluginId,
        processGeneration: caller.processGeneration,
        source: caller.source,
        sessionId,
        operation: 'create',
        phase: 'admission',
        agentName,
        model: `${model.providerId}/${model.modelId}`,
    }, AUDIT_MESSAGE);
    return { sessionId };
}
async function listModelOptions(state, caller) {
    const { bound } = authorize(state, caller);
    try {
        const [models, fallback] = await Promise.all([bound.listModels(), bound.resolveModel()]);
        const host = caller.hostSessionId
            ? await bound.resolveHostSession(caller.hostSessionId)
            : undefined;
        return { models, default: fallback, ...(host ? { host: host.model ?? fallback } : {}) };
    }
    catch (error) {
        throw setupFailure(state, caller, error, { stage: 'list-models', operation: 'models' });
    }
}
async function listAgentOptions(state, caller) {
    const { bound } = authorize(state, caller);
    try {
        return { agents: await bound.listAgents() };
    }
    catch (error) {
        throw setupFailure(state, caller, error, { stage: 'list-agents', operation: 'agents' });
    }
}
/** The chosen agent must be one the runtime offers; checked where the session is about to be bound. */
async function requireKnownAgent(bound, agent) {
    const agents = await bound.listAgents();
    if (!agents.some((option) => option.name === agent)) {
        throw new MiniAppAgentError('INVALID_ARGUMENTS', 'Mini App Agent agent is not available');
    }
}
/**
 * A new session follows its host chat: that chat's agent (or the chosen one), and its project
 * directory when the chat has one that still exists. Without a host chat: the default (or chosen)
 * agent and the plugin directory. The model is the host chat's, else the runtime default.
 */
async function creationContext(state, bound, caller, agent) {
    if (agent !== undefined)
        await requireKnownAgent(bound, agent);
    const { pluginId, hostSessionId } = caller;
    const host = hostSessionId ? await bound.resolveHostSession(hostSessionId) : undefined;
    if (!host?.agentName) {
        const agentName = agent ?? MINIAPP_AGENT_NAME;
        if (hostSessionId) {
            state.options.logger.info({ pluginId, hostSessionId, agentName, workspaceSource: 'plugin' }, 'Mini App Agent host chat session not found; using the default agent');
        }
        return pluginWorkspace(state, pluginId, agentName, await bound.defaultSessionModel());
    }
    return hostCreationContext(state, bound, caller, { host, agentName: agent ?? host.agentName });
}
async function hostCreationContext(state, bound, caller, target) {
    const { host, agentName } = target;
    const { pluginId, hostSessionId } = caller;
    const model = host.model ? { selection: host.model } : await bound.defaultSessionModel();
    const projectDir = host.isDefaultWorkspace ? '' : host.workspaceDir;
    if (!projectDir)
        return pluginWorkspace(state, pluginId, agentName, model);
    if (await isDirectory(projectDir)) {
        return {
            agentName,
            workspaceDir: projectDir,
            createDir: false,
            ...creationModel(model),
        };
    }
    state.options.logger.info({ pluginId, hostSessionId, agentName, workspaceSource: 'plugin' }, 'Mini App Agent host chat project directory is gone; using the plugin directory');
    return pluginWorkspace(state, pluginId, agentName, model);
}
function creationModel(model) {
    return {
        model: model.selection,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    };
}
function pluginWorkspace(state, pluginId, agentName, model) {
    return {
        agentName,
        ...creationModel(model),
        // Must stay under `agents/<agentName>/miniapps`: the rest of dataDir is private runtime state
        // the agent cannot read back (see fs-permission `isProtectedRuntimeRead`). A host chat's
        // project directory is an ordinary working directory and needs no such exemption.
        workspaceDir: join(state.options.dataDir, 'agents', agentName, 'miniapps', encodeURIComponent(pluginId)),
        createDir: true,
    };
}
async function isDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
function unavailable(state, caller, error, context) {
    // Every caller fails before a turn is dispatched, so the request can be retried as a whole.
    return reject(state, caller, new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent session is unavailable', true), { ...context, errorName: errorName(error) });
}
function errorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
function allowsRun(policy) {
    return policy.kind === 'allowlist' && policy.capabilities.includes('session.run');
}
function invalidText(text) {
    return typeof text === 'string' && text.trim() && text.length <= MINIAPP_AGENT_MAX_TEXT_LENGTH
        ? undefined
        : 'Mini App Agent text must be non-empty and bounded';
}
/** `model` is optional; once given, it must have the contract shape (availability is checked later). */
function readRequestedModel(value) {
    if (value === undefined)
        return { call: {} };
    const model = readMiniAppAgentModelSelection(value);
    return model
        ? { call: { model } }
        : {
            call: {},
            invalid: 'Mini App Agent model must be { providerId, modelId, variant?, thinking?: { effort } }',
        };
}
/**
 * `agent` is optional and only chooses the agent of a session that is being created; once given it
 * must be a non-empty string (that it names an offered agent is checked later).
 */
function readRequestedAgent(value, sessionId) {
    if (value === undefined)
        return { call: {} };
    if (sessionId !== undefined) {
        return { call: {}, invalid: 'Mini App Agent agent can only be chosen when creating a session' };
    }
    return typeof value === 'string' && value.trim()
        ? { call: { agent: value } }
        : { call: {}, invalid: 'Mini App Agent agent must be a non-empty agent name' };
}
function invalidAnswer(input) {
    if (!isId(input.sessionId) || !isId(input.requestId) || !Array.isArray(input.answers)) {
        return 'Mini App Agent answer needs a sessionId, a requestId and an answers list';
    }
    return undefined;
}
function invalidReply(input) {
    if (!isId(input.sessionId) || !isId(input.requestId)) {
        return 'Mini App Agent reply needs a sessionId and a requestId';
    }
    return isMiniAppAgentPermissionDecision(input.decision)
        ? undefined
        : 'Mini App Agent reply decision must be allowOnce or deny';
}
function isId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
}
//# sourceMappingURL=gateway.js.map