import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { detach } from '../../channel-system/settle.js';
import { MINIAPP_AGENT_MAX_STARTS_PER_MINUTE, MINIAPP_AGENT_RATE_PER_SLOT, MINIAPP_AGENT_RATE_WINDOW_MS, MINIAPP_AGENT_NAME, MiniAppAgentError, } from './contracts.js';
import { invalidAnswer, invalidReply, invalidText, isId, readRequestedAgent, readRequestedModel, readWhenBusy, } from './gateway-input.js';
import { bindSlot, createRunSlotPool, drain, hasFreeSlot, joinSlot, occupy, releasePool, releaseSlot, runningSlot, } from './run-slots.js';
import { AUDIT_MESSAGE, BUSY_MESSAGES, READ_PERMISSION, RUN_PERMISSION, authorize, declares, errorName, isSwitchedOn, reject, unavailable, } from './gateway-admission.js';
import { endObservers, getSession, listSessions, observe } from './gateway-reads.js';
/**
 * Host-side admission for Mini App Agent runs: policy, per-plugin run slots with a bounded FIFO
 * of waiting calls, ownership, audit.
 */
export function createMiniAppAgentGateway(options) {
    const state = {
        options,
        arenas: new Map(),
        recentStartsMs: new Map(),
        observers: new Map(),
        listeners: new Map(),
        panels: new Map(),
    };
    return {
        bind(next) {
            state.unsubscribeAsks?.();
            state.ports = next;
            state.unsubscribeAsks = next.subscribePermissionAsks((ask) => forwardAsk(state, ask));
        },
        bindPermissionSwitches(switches) {
            state.unsubscribeSwitches?.();
            state.switches = switches;
            state.unsubscribeSwitches = switches.subscribe((change) => {
                if (!change.enabled)
                    onPermissionRevoked(state, change.pluginId, change.permission);
            });
        },
        registerArena: (arena) => registerArena(state, arena),
        async run(caller, input, runOptions = {}) {
            const requested = readRequestedModel(input.model);
            const agent = readRequestedAgent(input.agent, input.sessionId);
            const whenBusy = readWhenBusy(input.whenBusy, input.sessionId);
            return startTurn(state, {
                caller,
                operation: 'run',
                sessionId: input.sessionId,
                runOptions,
                ...requested.call,
                ...agent.call,
                ...whenBusy.call,
                start: (bound, turn) => bound.runTurn({ ...turn, text: input.text, ...whenBusy.call }),
            }, invalidText(input.text) ?? requested.invalid ?? agent.invalid ?? whenBusy.invalid);
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
        observe: (caller, input, observeOptions) => observe(state, caller, input, observeOptions),
        sessions: (caller) => listSessions(state, caller),
        session: (caller, input) => getSession(state, caller, input),
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
        releaseArena(previous);
    const maxConcurrent = arena.policy.kind === 'allowlist' ? arena.policy.maxConcurrent : 0;
    const entry = {
        ...createRunSlotPool(maxConcurrent),
        processGeneration: arena.processGeneration,
        policy: arena.policy,
        observers: new Set(),
    };
    state.arenas.set(arena.pluginId, entry);
    return () => {
        releaseArena(entry);
        if (state.arenas.get(arena.pluginId) === entry)
            state.arenas.delete(arena.pluginId);
    };
}
/** Nothing waits on a released arena: its run slots are released and its observers end. */
function releaseArena(entry) {
    releasePool(entry);
    for (const controller of entry.observers)
        controller.abort();
}
/**
 * The user switched a permission off. For `agent:session.run` the plugin's in-flight runs are
 * aborted and its waiting calls refused; for `agent:session.read` its observers end (they
 * resolve, like a cancel). The arena stays registered, so switching back on admits new calls
 * without a restart.
 */
function onPermissionRevoked(state, pluginId, permission) {
    if (permission === READ_PERMISSION) {
        endObservers(state, pluginId, permission);
        return;
    }
    if (permission !== RUN_PERMISSION)
        return;
    const arena = state.arenas.get(pluginId);
    if (!arena)
        return;
    // An observer of the plugin's own session may rest on `session.run` alone.
    if (!isSwitchedOn(state, pluginId, 'session.read') || !declares(arena.policy, 'session.read')) {
        endObservers(state, pluginId, permission);
    }
    const queued = arena.queue.splice(0);
    for (const entry of queued)
        entry.refuse();
    for (const controller of arena.calls)
        controller.abort();
    state.options.logger.info({
        pluginId,
        processGeneration: arena.processGeneration,
        permission,
        aborted: arena.calls.size,
        refused: queued.length,
    }, 'Mini App Agent runs stopped by a permission switch');
}
function admit(state, call, invalid) {
    const { caller, sessionId } = call;
    const admitted = authorize(state, caller);
    if (invalid !== undefined) {
        throw reject(state, caller, new MiniAppAgentError('INVALID_ARGUMENTS', invalid));
    }
    if (sessionId !== undefined &&
        call.whenBusy === undefined &&
        admitted.arena.runningSessions.has(sessionId)) {
        throw busy(state, call, 'session_busy');
    }
    return admitted;
}
/**
 * Caps how many turns one plugin may start per minute, counted when a slot is taken or a
 * `whenBusy` call joins one (a call that only waited or was refused does not count), so a runaway
 * page or Node loop cannot keep the Agent busy. The cap scales with `agentConcurrency`.
 */
function rateLimit(state, call, arena) {
    const { pluginId } = call.caller;
    const now = state.options.nowMs();
    const starts = state.recentStartsMs.get(pluginId) ?? [];
    let oldest = starts[0];
    while (oldest !== undefined && now - oldest >= MINIAPP_AGENT_RATE_WINDOW_MS) {
        starts.shift();
        oldest = starts[0];
    }
    const limit = Math.max(MINIAPP_AGENT_MAX_STARTS_PER_MINUTE, MINIAPP_AGENT_RATE_PER_SLOT * arena.maxConcurrent);
    if (starts.length >= limit)
        throw busy(state, call, 'rate_limited');
    starts.push(now);
    state.recentStartsMs.set(pluginId, starts);
}
function busy(state, call, reason) {
    const message = BUSY_MESSAGES[reason];
    return reject(state, call.caller, new MiniAppAgentError('BUSY', message, true, reason), {
        reason,
    });
}
/**
 * Admits a `run` / `answer` into a free slot, or queues it behind the calls already waiting so
 * runs start in strict FIFO order. A `whenBusy` call on a session holding a slot shares it.
 */
async function startTurn(state, call, invalid) {
    const admitted = admit(state, call, invalid);
    const { arena } = admitted;
    const running = runningSlot(arena, call.sessionId);
    let slot;
    if (running)
        slot = joinOrBusy(state, arena, call, { session: running });
    else if (hasFreeSlot(arena))
        slot = takeSlot(state, arena, call);
    else
        slot = await enqueue(state, arena, call);
    return execute(state, admitted, call, slot);
}
/** Takes a free run slot; the per-minute cap is charged here, so only turns that start count. */
function takeSlot(state, arena, call, queuedAt) {
    rateLimit(state, call, arena);
    return occupy(arena, call.sessionId, queuedAt);
}
/**
 * A `whenBusy` call shares its session's slot unless too many joined calls are in flight; joining
 * is charged to the per-minute cap like taking a slot.
 */
function joinOrBusy(state, arena, call, target) {
    if (arena.joined >= arena.maxQueued)
        throw busy(state, call, 'queue_full');
    rateLimit(state, call, arena);
    const slot = joinSlot(arena, target.session, target.queuedAt);
    if (!slot)
        throw busy(state, call, 'queue_full');
    return slot;
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
                try {
                    resolve(takeDequeuedSlot(state, arena, call, position));
                }
                catch (error) {
                    rejectWait(error);
                }
            },
            cancel() {
                leave();
                rejectWait(cancelledWhileQueued(state, call));
            },
            refuse() {
                leave();
                rejectWait(reject(state, call.caller, new MiniAppAgentError('NOT_PERMITTED', 'Mini App is not permitted to run the Agent'), { reason: 'switched-off', stage: 'queue', operation: call.operation }));
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
/**
 * A dequeued call takes the free slot, or joins its session's when an earlier call for that
 * session started meanwhile (only with `whenBusy`; otherwise it is `BUSY`).
 */
function takeDequeuedSlot(state, arena, call, position) {
    const running = runningSlot(arena, call.sessionId);
    if (!running)
        return takeSlot(state, arena, call, position);
    if (call.whenBusy === undefined)
        throw busy(state, call, 'session_busy');
    return joinOrBusy(state, arena, call, { session: running, queuedAt: position });
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
 * The events a call's turn reports to its caller. A call without `whenBusy` answers the session's
 * asks from the start; a `whenBusy` call only once its own text opened a turn (`onOwnTurn`), so
 * text steered into another call's turn never takes that turn's asks.
 */
function followTurn(state, sessionId, call) {
    const { onEvent } = call.runOptions;
    if (call.whenBusy === undefined) {
        const listener = listen(state, sessionId, onEvent);
        return {
            turn: listener.onEvent ? { onEvent: listener.onEvent } : {},
            dispose: listener.dispose,
        };
    }
    let listener;
    return {
        turn: {
            ...(onEvent ? { onEvent: (event) => (listener?.onEvent ?? onEvent)(event) } : {}),
            onOwnTurn: () => {
                listener ??= listen(state, sessionId, onEvent);
            },
        },
        dispose: () => listener?.dispose(),
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
    const { controller, queuedAt, joined } = slot;
    let events;
    const signal = runOptions.signal
        ? AbortSignal.any([controller.signal, runOptions.signal])
        : controller.signal;
    try {
        // Before the session exists: an unusable model must not leave a new session behind.
        const requested = await resolveRequestedModel(state, bound, call);
        const { sessionId, agentName, model } = await resolveSession(state, bound, call, requested);
        if (slot.session.sessionId === undefined)
            bindSlot(arena, slot.session, sessionId);
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
        events = followTurn(state, sessionId, call);
        const turn = {
            sessionId,
            signal,
            ...events.turn,
            beforeDelivery: () => confirmDelivery(state, call.caller, signal),
        };
        return await dispatch(state, call, { sessionId, agentName, model: requested ?? model, queuedAt, joined }, () => call.start(bound, turn));
    }
    finally {
        events?.dispose();
        releaseSlot(arena, slot);
        drain(arena);
    }
}
/**
 * The call was admitted before its lookups; a switch turned off or a cancel since then must stop
 * the text before it reaches a turn.
 */
function confirmDelivery(state, caller, signal) {
    if (!(state.switches?.isEnabled(caller.pluginId, RUN_PERMISSION) ?? true)) {
        throw new MiniAppAgentError('NOT_PERMITTED', 'Mini App is not permitted to run the Agent');
    }
    if (signal.aborted) {
        throw new MiniAppAgentError('REQUEST_CANCELLED', 'Mini App Agent run was cancelled');
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
    const { caller, whenBusy } = call;
    const { sessionId, agentName, model, queuedAt, joined } = admission;
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
        ...(whenBusy ? { whenBusy } : {}),
        ...(joined ? { joined: true } : {}),
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
//# sourceMappingURL=gateway.js.map