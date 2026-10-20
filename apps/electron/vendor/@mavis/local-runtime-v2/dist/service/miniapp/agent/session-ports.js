import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import { LocalModelProviderError, resolveRequestedSessionModel, } from '../../model-system/index.js';
import { MINIAPP_AGENT_NAME, MINIAPP_AGENT_PURPOSE_PREFIX, MiniAppAgentError, } from './contracts.js';
import { modelSelectionFromRecord, sessionModelFields } from './model-selection.js';
import { createFrameProjector } from './session-ports-projection.js';
/** Upper bound on delegated-session hops walked to find a Mini App root. */
const MAX_MINIAPP_ROOT_HOPS = 16;
/** Binds the Mini App Agent gateway to SessionSystem records/stream and TurnSystem steering. */
export function createMiniAppAgentSessionPorts(options) {
    return {
        async createSession({ pluginId, agentName, workspaceDir, createDir, hostSessionId, model, contextWindow, }) {
            if (createDir)
                await mkdir(workspaceDir, { recursive: true });
            const session = await options.records.createInternalSession({
                agentName,
                sessionType: 'branch',
                sessionKind: 'conversation',
                visibility: 'hidden',
                purpose: `${MINIAPP_AGENT_PURPOSE_PREFIX}${pluginId}`,
                workspaceDir,
                isDefaultWorkspace: false,
                miniAppOrigin: {
                    pluginId,
                    createdAtMs: options.nowMs(),
                    ...(hostSessionId ? { hostSessionId } : {}),
                },
                // Shown as the side-panel tab label; the gateway has no plugin display name.
                title: pluginId,
                ...sessionModelFields(model),
                ...(contextWindow === undefined ? {} : { effectiveModelContextWindow: contextWindow }),
            });
            return { sessionId: session.sessionId };
        },
        listModels: () => listModelOptions(options),
        listAgents: () => listAgentOptions(options),
        defaultSessionModel: () => resolveDefaultSessionModel(options),
        resolveModel: async (requested) => requested
            ? resolveRequestedModel(options, requested)
            : (await resolveDefaultSessionModel(options)).selection,
        readSessionModel: (sessionId) => readSessionModel(options, sessionId),
        setSessionModel: (sessionId, model) => beforeDispatch(options, { stage: 'set-session-model', sessionId }, async () => {
            await options.lifecycle.mutateSession(sessionId, {
                ...sessionModelFields(model),
                effectiveModelContextWindow: null,
                effectiveModelMaxOutputTokens: null,
            });
        }),
        async getOwner(sessionId) {
            return (await options.repository.get(sessionId))?.miniAppOrigin?.pluginId;
        },
        resolveMiniAppRoot: (sessionId) => resolveMiniAppRoot(options, sessionId),
        resolveHostSession: (sessionId) => beforeDispatch(options, { stage: 'resolve-host-session', sessionId }, async () => {
            const session = await options.repository.get(sessionId);
            if (!session)
                return undefined;
            const { agentName, workspaceDir, isDefaultWorkspace } = session;
            // Same reading as the session wire projection: only an explicit `true` is the default.
            const model = modelSelectionFromRecord(session);
            return {
                agentName,
                workspaceDir,
                isDefaultWorkspace: isDefaultWorkspace === true,
                model,
            };
        }),
        runTurn: (input) => runMiniAppAgentTurn(options, input),
        answerQuestion: (input) => answerMiniAppAgentQuestion(options, input),
        replyPermission: (input) => replyMiniAppAgentPermission(options, input),
        subscribePermissionAsks: (listener) => options.eventBus.subscribe({
            next(event) {
                if (event.type === 'permission.ask')
                    listener(projectPermissionAsk(event.payload));
            },
        }),
    };
}
async function listModelOptions(options) {
    return (await options.models.list())
        .filter((entry) => entry.enabled)
        .map((entry) => ({
        providerId: entry.providerId,
        modelId: entry.modelId,
        displayName: entry.displayName,
        ...(entry.supportedVariants?.length ? { variants: [...entry.supportedVariants] } : {}),
        ...(entry.effortOptions?.length
            ? {
                thinking: {
                    efforts: [...entry.effortOptions],
                    ...(entry.defaultEffort ? { default: entry.defaultEffort } : {}),
                },
            }
            : {}),
    }));
}
async function listAgentOptions(options) {
    const byName = new Map();
    for (const agent of await options.agents.list({ includeAliases: false })) {
        const name = agent.canonicalViewName;
        if (byName.has(name))
            continue;
        byName.set(name, {
            name,
            displayName: agent.displayName || name,
            primary: name === MINIAPP_AGENT_NAME,
        });
    }
    return [...byName.values()];
}
/** Same validation as the composer. */
async function resolveRequestedModel(options, requested) {
    return (await resolveSelection(options, requested)).selection;
}
/**
 * The runtime default as the turn system would run it with no session model: the global
 * variant, thinking and context window apply (`variant: ''` is thinking off and is kept).
 */
async function resolveDefaultSessionModel(options) {
    const config = options.modelConfig();
    return resolveSelection(options, {
        ...(config.defaultModelVariant === undefined ? {} : { variant: config.defaultModelVariant }),
        ...(config.defaultModelThinking === undefined ? {} : { thinking: config.defaultModelThinking }),
        ...(config.defaultModelContextWindow === undefined
            ? {}
            : { contextLimit: config.defaultModelContextWindow }),
    });
}
async function resolveSelection(options, requested) {
    try {
        const config = options.modelConfig();
        const resolved = resolveRequestedSessionModel(config, requested);
        if (!resolved.providerId || !resolved.modelId) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', 'Model is not available: the runtime default model is not configured');
        }
        // A retired official model was already replaced above. The Mini App API
        // still validates its arguments up front: a model no route lists is an
        // input error for the caller rather than a Turn left to fail upstream.
        const availability = resolveModelAvailability({
            config,
            providerId: resolved.providerId,
            modelId: resolved.modelId,
            preset: getRuntimePresetKey(),
            source: 'explicit_request',
        });
        if (!availability.available) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', `Model is not available: ${availability.message}`);
        }
        return {
            selection: {
                providerId: resolved.providerId,
                modelId: resolved.modelId,
                ...(typeof resolved.variant === 'string' ? { variant: resolved.variant } : {}),
                ...(resolved.thinking?.effort ? { thinking: { effort: resolved.thinking.effort } } : {}),
            },
            ...(resolved.contextLimit === undefined ? {} : { contextWindow: resolved.contextLimit }),
        };
    }
    catch (error) {
        if (error instanceof LocalModelProviderError) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', `Model is not available: ${error.message}`);
        }
        throw error;
    }
}
function readSessionModel(options, sessionId) {
    return beforeDispatch(options, { stage: 'read-session-model', sessionId }, async () => {
        const record = await options.repository.get(sessionId);
        return record ? modelSelectionFromRecord(record) : undefined;
    });
}
/**
 * The model a turn is about to be dispatched with. A record predating the model snapshot has
 * none stored, so the turn runs on the runtime default, which is what it is reported as.
 */
async function modelBeforeDispatch(options, sessionId) {
    const recorded = await readSessionModel(options, sessionId);
    return (recorded ??
        beforeDispatch(options, { stage: 'resolve-default-model', sessionId }, async () => {
            return (await resolveDefaultSessionModel(options)).selection;
        }));
}
/** A failure before anything was dispatched: nothing ran, so the caller may retry. */
async function beforeDispatch(options, context, lookup) {
    try {
        return await lookup();
    }
    catch (error) {
        if (error instanceof MiniAppAgentError)
            throw error;
        options.logger.warn({ ...context, ...errorFields(error) }, 'Mini App Agent lookup failed before dispatch');
        throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent session is unavailable', true);
    }
}
/** Unknown outcome: something may have run or been recorded, so a blind retry is not safe. */
function outcomeUnknown(message) {
    return new MiniAppAgentError('AGENT_OUTCOME_UNKNOWN', message);
}
function errorFields(error) {
    return error instanceof Error
        ? { errorName: error.name, error: error.message }
        : { errorName: typeof error, error: String(error) };
}
/** Walks delegated child sessions up to the Mini App session that owns them (bounded, cycle-safe). */
async function resolveMiniAppRoot(options, sessionId) {
    const seen = new Set();
    let current = sessionId;
    while (current) {
        if (seen.has(current) || seen.size > MAX_MINIAPP_ROOT_HOPS) {
            options.logger.warn({ sessionId, hops: seen.size, cycle: seen.has(current) }, 'Mini App root lookup stopped at the hop limit or a cycle');
            return undefined;
        }
        seen.add(current);
        const record = await options.repository.get(current);
        const pluginId = record?.miniAppOrigin?.pluginId;
        if (pluginId)
            return { rootSessionId: current, pluginId };
        current = record?.parentSessionId;
    }
    return undefined;
}
/** Reads the next frame unless `stop` settles first; an unread frame stays for the next read. */
async function read(source, stop) {
    source.pending ??= source.current.next();
    const result = await Promise.race([source.pending, stop]);
    if (typeof result !== 'symbol')
        source.pending = undefined;
    return result;
}
/** How long a cancelled run waits for its own terminal so the session is idle afterwards. */
const ABORT_SETTLE_TIMEOUT_MS = 15_000;
/** How long an answer waits for the continuation turn it should start. */
const CONTINUATION_START_TIMEOUT_MS = 15_000;
async function runMiniAppAgentTurn(options, input) {
    const model = await modelBeforeDispatch(options, input.sessionId);
    const follow = { ...input, model };
    // Subscribe before steering; the iterator buffers frames until the turnId is known.
    return withTurnStream(options, input, async (source, aborted) => {
        const startedAtMs = options.nowMs();
        const turnId = await activateTurn(options, input);
        return followOwnedTurn(options, follow, { source, turnId, aborted, startedAtMs });
    });
}
/** Opens the session stream and the abort watch for one run; both are released when it settles. */
async function withTurnStream(options, input, follow) {
    const source = {
        current: options.stream.resume({ sessionId: input.sessionId, waitForTerminal: true }),
    };
    const aborted = abortPromise(input.signal);
    try {
        return await follow(source, aborted.promise);
    }
    finally {
        aborted.dispose();
        await source.current.return?.();
    }
}
/**
 * Answers the questionnaire the session paused on and follows the continuation turn the
 * answer starts. The stream is subscribed before replying, and the continuation is the
 * first turn-scoped frame that follows. An answer the runtime saved without starting a
 * continuation settles `finished` without a turn; one whose continuation is not observed
 * within the bound has an unknown outcome (the turn may still start later).
 */
async function answerMiniAppAgentQuestion(options, input) {
    const { sessionId, requestId } = input;
    const { agentName, pending } = await beforeDispatch(options, { stage: 'answer-lookup', sessionId, requestId }, async () => {
        const name = (await options.repository.get(sessionId))?.agentName;
        return {
            agentName: name,
            pending: name ? await pendingQuestionOf(options, name, sessionId) : undefined,
        };
    });
    // A request id of another session (even of the same agent) is never settled from here.
    if (!agentName || pending?.requestId !== requestId) {
        throw new MiniAppAgentError('REQUEST_NOT_FOUND', 'Mini App Agent question is not pending');
    }
    const model = await modelBeforeDispatch(options, sessionId);
    const follow = { ...input, model };
    return withTurnStream(options, input, async (source, aborted) => {
        const startedAtMs = options.nowMs();
        const reply = await replyQuestion(options, agentName, input);
        if (reply.injected === false)
            return { status: 'finished' };
        const first = await awaitContinuation(source, aborted);
        if (first === TIMED_OUT) {
            options.logger.warn({
                stage: 'answer-continuation',
                sessionId,
                requestId,
                timeoutMs: CONTINUATION_START_TIMEOUT_MS,
            }, 'Mini App Agent answer continuation turn was not observed');
            throw outcomeUnknown('Mini App Agent answer was recorded but the follow-up turn was not observed');
        }
        if (first === ABORTED) {
            return finish(follow, await abortUnidentifiedTurn(options, sessionId, source));
        }
        source.current = prepend(first, source.current);
        return followOwnedTurn(options, follow, {
            source,
            turnId: first.turnId,
            aborted,
            startedAtMs,
        });
    });
}
async function awaitContinuation(source, aborted) {
    const deadline = timeoutPromise(CONTINUATION_START_TIMEOUT_MS);
    try {
        return await nextTurnFrame(source, Promise.race([aborted, deadline.promise]));
    }
    finally {
        deadline.dispose();
    }
}
async function replyQuestion(options, agentName, input) {
    try {
        return await options.questionnaires.reply({
            agentName,
            requestId: input.requestId,
            answers: [...input.answers],
            submittedAt: options.nowMs(),
        });
    }
    catch (error) {
        // These statuses are raised before the answer is saved, so nothing was dispatched. Any
        // other failure (e.g. 503 QUESTIONNAIRE_CONTINUATION_NOT_STARTED, raised after the answer
        // was persisted) propagates and is reported as an unknown outcome.
        const status = readNumber(error, 'status');
        if (status === 400) {
            throw new MiniAppAgentError('INVALID_ARGUMENTS', 'Mini App Agent answers were rejected');
        }
        if (status === 404 || status === 409 || status === 410) {
            throw new MiniAppAgentError('REQUEST_NOT_FOUND', 'Mini App Agent question is not pending');
        }
        throw error;
    }
}
async function pendingQuestionOf(options, agentName, sessionId) {
    const request = await options.questionnaires.getPending({ agentName, sessionId });
    return request
        ? { requestId: request.id, mode: request.mode ?? 'questionnaire', request }
        : undefined;
}
async function replyMiniAppAgentPermission(options, input) {
    // Nothing is decided until `permissions.reply`; a failed lookup before it may be retried.
    const decidable = await beforeDispatch(options, { stage: 'reply-lookup', sessionId: input.sessionId, requestId: input.requestId }, () => isRaisedUnderSameRoot(options, input));
    if (!decidable)
        return 'skipped';
    const result = await options.permissions.reply({
        requestIds: [input.requestId],
        decision: input.decision,
    });
    return result.processed.includes(input.requestId) ? 'processed' : 'skipped';
}
/** Approval request ids are global; only a request raised under the same root may be decided. */
async function isRaisedUnderSameRoot(options, input) {
    const root = await resolveMiniAppRoot(options, input.sessionId);
    if (!root)
        return false;
    const pending = await options.permissions.listPending();
    const request = pending.find((entry) => entry.requestId === input.requestId);
    if (!request)
        return false;
    // Raised by the named session or the root itself: its root is already known.
    if (request.sessionId === input.sessionId || request.sessionId === root.rootSessionId) {
        return true;
    }
    const owner = await resolveMiniAppRoot(options, request.sessionId);
    return owner?.rootSessionId === root.rootSessionId;
}
function projectPermissionAsk(payload) {
    return {
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        toolName: payload.toolName,
        reason: payload.reason,
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
        ...(payload.toolInput === undefined ? {} : { toolInput: payload.toolInput }),
    };
}
async function followOwnedTurn(options, input, run) {
    try {
        return await followTurn(options, input, run);
    }
    catch (error) {
        // A Mini App Agent error here is raised after the turn ended or after its abort was
        // requested; anything else means the dispatched turn is no longer observed, so do not
        // leave it running without a caller.
        if (!(error instanceof MiniAppAgentError)) {
            await abortQuietly(options, input.sessionId, run.turnId);
        }
        throw error;
    }
}
async function abortQuietly(options, sessionId, turnId) {
    try {
        await options.turns.abort({ sessionId, turnId, reason: 'miniapp-stream-lost' });
    }
    catch (error) {
        // Best effort; the original failure is what the caller sees.
        options.logger.warn({ stage: 'abort-unobserved-turn', sessionId, turnId, ...errorFields(error) }, 'Mini App Agent could not abort a turn it no longer observes');
    }
}
async function activateTurn(options, input) {
    const { sessionId } = input;
    const requestId = randomUUID();
    const steered = await options.turns.steer({
        sessionId,
        input: { text: input.text },
        producerId: `miniapp:${sessionId}`,
        idempotencyKey: requestId,
        provenance: {
            source: 'miniapp',
            routingFingerprint: `miniapp:${sessionId}:${requestId}`,
        },
    });
    if (!steered.delivered) {
        throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Mini App Agent turn was rejected', true);
    }
    // A steered delivery merged the text into a turn this run does not own.
    if (steered.mode !== 'activated') {
        throw new MiniAppAgentError('BUSY', 'Mini App Agent session is busy', true, 'session_busy');
    }
    return steered.turnId;
}
async function followTurn(options, input, run) {
    const { sessionId } = input;
    const { source, turnId } = run;
    const projector = createFrameProjector(sessionId, turnId, input.model);
    for (;;) {
        const next = await read(source, run.aborted);
        if (next === ABORTED) {
            const abort = await options.turns.abort({ sessionId, turnId, reason: 'miniapp-cancelled' });
            const terminal = await settleAbortedTurn(options, sessionId, source, turnId);
            return finish(input, confirmCancelled(options, { sessionId, turnId, abort, terminal }));
        }
        if (next.done)
            throw new Error('Session stream ended before the Mini App Agent turn terminal');
        const frame = next.value;
        // Frames without a turnId are session-level; frames of other turns are not this run's.
        if (frame.turnId !== undefined && frame.turnId !== turnId) {
            await resumeAfterStaleTerminal(options, sessionId, source, frame);
            continue;
        }
        if (frame.kind === 'turn-terminal') {
            return settleTerminal(options, input, run, frame.data);
        }
        emit(input.onEvent, projector.project(frame));
    }
}
/**
 * The resume iterator closes on any turn-terminal; a stale one from an earlier turn must not
 * end this run, so continue from its cursor (the ring replays what followed).
 */
async function resumeAfterStaleTerminal(options, sessionId, source, frame) {
    if (frame.kind !== 'turn-terminal' || !frame.cursor)
        return;
    await source.current.return?.();
    source.current = options.stream.resume({
        sessionId,
        afterCursor: frame.cursor,
        waitForTerminal: true,
    });
}
/** A turn that ended on a questionnaire it raised reports it before `turn.finished`. */
async function settleTerminal(options, input, run, data) {
    const { sessionId } = input;
    const { turnId } = run;
    const result = await terminalResult(options, sessionId, turnId, data);
    if (result.status === 'aborted')
        return finish(input, result);
    let question;
    try {
        question = await findPendingQuestion(options, input, run);
    }
    catch (error) {
        options.logger.warn({ stage: 'pending-question-lookup', sessionId, turnId, ...errorFields(error) }, 'Mini App Agent pending questionnaire lookup failed');
        // The turn did end: deliver its terminal, but not as proof that nothing is pending.
        finish(input, result);
        throw outcomeUnknown('The Agent turn ended, but whether a question is pending could not be determined; ' +
            'inspect the session, then continue with run({ sessionId }) or answer');
    }
    if (!question)
        return finish(input, result);
    emit(input.onEvent, [
        {
            type: 'question.requested',
            sessionId,
            turnId,
            requestId: question.requestId,
            mode: question.mode,
            request: question.request,
        },
    ]);
    return finish(input, { ...result, pendingQuestion: question });
}
/**
 * Only a questionnaire created during this turn is its question; an older one left unanswered
 * is not re-reported.
 */
async function findPendingQuestion(options, input, run) {
    const { sessionId } = input;
    const agentName = (await options.repository.get(sessionId))?.agentName;
    const question = agentName ? await pendingQuestionOf(options, agentName, sessionId) : undefined;
    const createdAt = question?.request.createdAt;
    return createdAt === undefined || createdAt >= run.startedAtMs ? question : undefined;
}
/** Reads until the first turn-scoped frame, or the `stop` symbol; session-level frames have no turn. */
async function nextTurnFrame(source, stop) {
    for (;;) {
        const next = await read(source, stop);
        if (typeof next === 'symbol')
            return next;
        if (next.done)
            throw new Error('Session stream ended before the Mini App Agent turn started');
        const frame = next.value;
        if (frame.turnId !== undefined)
            return { ...frame, turnId: frame.turnId };
    }
}
/**
 * Cancelled before the continuation turn was seen: wait (bounded) for it to appear, abort it
 * and wait for its terminal, so the session is idle for the next call. Not seeing the turn
 * at all leaves the outcome unknown: it may still start after this call returns.
 */
async function abortUnidentifiedTurn(options, sessionId, source) {
    const deadline = timeoutPromise(ABORT_SETTLE_TIMEOUT_MS);
    let first;
    try {
        first = await nextTurnFrame(source, deadline.promise);
    }
    catch (error) {
        options.logger.warn({ stage: 'cancel-continuation-watch', sessionId, ...errorFields(error) }, 'Mini App Agent lost the stream while waiting for the cancelled continuation turn');
        first = TIMED_OUT;
    }
    finally {
        deadline.dispose();
    }
    if (first === TIMED_OUT) {
        options.logger.warn({ stage: 'cancel-continuation', sessionId, timeoutMs: ABORT_SETTLE_TIMEOUT_MS }, 'Mini App Agent cancelled answer: continuation turn was not observed');
        throw outcomeUnknown('Mini App Agent answer was cancelled but the follow-up turn was not observed');
    }
    const turnId = first.turnId;
    if (first.kind === 'turn-terminal') {
        const terminal = { status: readString(first.data, 'status') };
        return confirmCancelled(options, { sessionId, turnId, terminal });
    }
    const abort = await options.turns.abort({ sessionId, turnId, reason: 'miniapp-cancelled' });
    const terminal = await settleAbortedTurn(options, sessionId, source, turnId);
    return confirmCancelled(options, { sessionId, turnId, abort, terminal });
}
/**
 * A cancel is reported `aborted` only when the runtime acknowledged the abort or the turn's
 * own `aborted` terminal was seen. A timeout, an ended stream, or a turn that was no longer
 * running (it may have finished on its own) does not prove the abort.
 */
function confirmCancelled(options, cancel) {
    const { sessionId, turnId, abort, terminal } = cancel;
    if (abort?.status === 'aborted' || terminal?.status === 'aborted') {
        return { turnId, status: 'aborted' };
    }
    options.logger.warn({
        stage: 'cancel-confirmation',
        sessionId,
        turnId,
        abortStatus: abort?.status ?? 'not-requested',
        terminalStatus: terminal ? (terminal.status ?? 'missing') : 'not-observed',
    }, 'Mini App Agent cancel was not confirmed');
    const observed = terminal?.status;
    throw outcomeUnknown(observed === undefined
        ? 'Mini App Agent run was cancelled but the abort was not confirmed'
        : `Mini App Agent run was cancelled but the turn ended on its own first (terminal status: ${observed}); inspect the session before continuing`);
}
function prepend(frame, rest) {
    let head = frame;
    const iterator = {
        [Symbol.asyncIterator]: () => iterator,
        next() {
            if (!head)
                return rest.next();
            const value = head;
            head = undefined;
            return Promise.resolve({ done: false, value });
        },
        return: () => rest.return?.() ?? Promise.resolve({ done: true, value: undefined }),
    };
    return iterator;
}
/**
 * Waits (bounded) for the aborted turn's own terminal so a follow-up run finds the session
 * idle; undefined when it was not seen (timeout or the stream ended).
 */
async function settleAbortedTurn(options, sessionId, source, turnId) {
    const deadline = timeoutPromise(ABORT_SETTLE_TIMEOUT_MS);
    try {
        for (;;) {
            const next = await read(source, deadline.promise);
            if (next === TIMED_OUT || next.done)
                return undefined;
            if (next.value.kind === 'turn-terminal' && next.value.turnId === turnId) {
                return { status: readString(next.value.data, 'status') };
            }
            if (next.value.turnId !== turnId) {
                await resumeAfterStaleTerminal(options, sessionId, source, next.value);
            }
        }
    }
    finally {
        deadline.dispose();
    }
}
const TIMED_OUT = Symbol('timed-out');
function timeoutPromise(ms) {
    let timer;
    const promise = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    return { promise, dispose: () => clearTimeout(timer) };
}
const ABORTED = Symbol('aborted');
function abortPromise(signal) {
    if (!signal)
        return { promise: new Promise(() => undefined), dispose: () => undefined };
    let onAbort = () => undefined;
    const promise = new Promise((resolve) => {
        onAbort = () => resolve(ABORTED);
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener('abort', onAbort, { once: true });
    });
    return { promise, dispose: () => signal.removeEventListener('abort', onAbort) };
}
/**
 * The final event carries the settled result, so it is emitted only once that result exists;
 * a result without a turn (nothing ran) has no `turn.finished`.
 */
function finish(input, result) {
    if (result.turnId === undefined)
        return result;
    const reported = { ...result, model: input.model };
    emit(input.onEvent, [
        {
            type: 'turn.finished',
            sessionId: input.sessionId,
            turnId: result.turnId,
            status: result.status,
            ...(result.text === undefined ? {} : { text: result.text }),
            ...(result.error ? { error: result.error } : {}),
        },
    ]);
    return reported;
}
function emit(onEvent, events) {
    if (!onEvent)
        return;
    for (const event of events) {
        try {
            onEvent(event);
        }
        catch {
            // A listener failure must not break the run.
        }
    }
}
async function terminalResult(options, sessionId, turnId, data) {
    const status = readField(data, 'status');
    if (status === 'aborted')
        return { turnId, status: 'aborted' };
    if (status === 'failed') {
        const code = readString(data, 'errorSource');
        return {
            turnId,
            status: 'error',
            error: {
                code: code && TURN_ERROR_CODE_PATTERN.test(code) ? code : 'TURN_FAILED',
                message: 'The Agent turn failed.',
            },
        };
    }
    if (status !== 'completed') {
        // Malformed terminal data says nothing about how the turn ended.
        options.logger.warn({ stage: 'turn-terminal', sessionId, turnId, terminalStatus: status ?? null }, 'Mini App Agent turn terminal has no known status');
        throw outcomeUnknown('Mini App Agent turn ended with an unreadable result');
    }
    const text = finalAssistantText(await options.messages.listTurn(sessionId, turnId));
    return { turnId, status: 'finished', ...(text ? { text } : {}) };
}
/** Runtime error sources are forwarded only when they are short identifiers, never free text. */
const TURN_ERROR_CODE_PATTERN = /^[A-Za-z][\w.-]{0,63}$/;
function finalAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant')
            continue;
        const body = message.msg_content ?? message.msgContent ?? message.content;
        if (typeof body === 'string' && body.trim())
            return body;
    }
    return undefined;
}
function readString(value, key) {
    const field = readField(value, key);
    return typeof field === 'string' ? field : undefined;
}
function readNumber(value, key) {
    const field = readField(value, key);
    return typeof field === 'number' ? field : undefined;
}
function readField(value, key) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    return value[key];
}
//# sourceMappingURL=session-ports.js.map