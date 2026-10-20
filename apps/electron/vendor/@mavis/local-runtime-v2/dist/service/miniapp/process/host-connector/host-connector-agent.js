import { isMiniAppAgentPermissionDecision, isMiniAppAgentQuestionMode, readMiniAppAgentAnswers, } from '@mavis/shared/miniapp-surface';
import { isMiniAppAgentBusyReason, MINIAPP_AGENT_ERROR_CODES, MiniAppAgentError, } from '../../agent/contracts.js';
import { readMiniAppAgentModelSelection } from '../../agent/model-selection.js';
import { detach } from '../../../channel-system/settle.js';
import { HostConnectorProtocolError } from './host-connector-errors.js';
import { hasExactKeys, isBoundedIdentifier, isRecord, } from './host-connector-wire.js';
const AGENT_ERROR_MESSAGES = {
    NOT_PERMITTED: 'Mini App Agent access is not permitted',
    BUSY: 'Mini App Agent is busy',
    SESSION_NOT_FOUND: 'Mini App Agent session was not found',
    INVALID_ARGUMENTS: 'Mini App Agent arguments are invalid',
    AGENT_UNAVAILABLE: 'Mini App Agent is unavailable',
    REQUEST_CANCELLED: 'Mini App Agent run was cancelled',
    AGENT_OUTCOME_UNKNOWN: 'Mini App Agent outcome is unknown after dispatch',
    REQUEST_NOT_FOUND: 'Mini App Agent request was not found or already settled',
};
const AGENT_ERROR_CODES = new Set(MINIAPP_AGENT_ERROR_CODES);
/** Event frames buffered per run before later ones are dropped; the terminal frame is never dropped. */
const MAX_QUEUED_AGENT_EVENTS = 256;
/** Events the child must act on; never dropped for the queue bound. */
const INTERACTION_EVENT_TYPES = new Set([
    'permission.requested',
    'question.requested',
]);
export function agentClientError(code, retryable = false) {
    return new MiniAppAgentError(code, AGENT_ERROR_MESSAGES[code], retryable);
}
export function encodeAgentRunParams(input) {
    if (!isRecord(input) ||
        typeof input.text !== 'string' ||
        (input.sessionId !== undefined && !isBoundedIdentifier(input.sessionId)) ||
        (input.agent !== undefined && !isBoundedIdentifier(input.agent))) {
        throw agentClientError('INVALID_ARGUMENTS');
    }
    return {
        text: input.text,
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...encodeAgentModel(input.model),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
    };
}
function encodeAgentModel(model) {
    if (model === undefined)
        return {};
    const selection = readMiniAppAgentModelSelection(model);
    if (!selection)
        throw agentClientError('INVALID_ARGUMENTS');
    return { model: selection };
}
/** A present `model` must decode; the child client already refuses malformed ones. */
function decodeAgentModel(params) {
    if (!('model' in params))
        return {};
    const selection = readMiniAppAgentModelSelection(params.model);
    if (!selection)
        throw new HostConnectorProtocolError('Host Connector request is invalid');
    return { model: selection };
}
export function encodeAgentCreateParams(input) {
    if (input === undefined)
        return {};
    if (!isRecord(input) || (input.agent !== undefined && !isBoundedIdentifier(input.agent))) {
        throw agentClientError('INVALID_ARGUMENTS');
    }
    return input.agent === undefined ? {} : { agent: input.agent };
}
function decodeAgentCreateParams(params) {
    if (!params ||
        !hasOptionalKeys(params, [], ['agent']) ||
        !isOptional(params, 'agent', isBoundedIdentifier)) {
        throw new HostConnectorProtocolError('Host Connector request is invalid');
    }
    return typeof params.agent === 'string' ? { agent: params.agent } : {};
}
function decodeAgentRunParams(params) {
    if (!params ||
        !hasOptionalKeys(params, ['text'], ['sessionId', 'observe', 'model', 'agent']) ||
        typeof params.text !== 'string' ||
        !isOptional(params, 'sessionId', isBoundedIdentifier) ||
        !isOptional(params, 'agent', isBoundedIdentifier) ||
        !isOptional(params, 'observe', isBoolean)) {
        throw new HostConnectorProtocolError('Host Connector request is invalid');
    }
    return {
        params: {
            text: params.text,
            ...(typeof params.sessionId === 'string' ? { sessionId: params.sessionId } : {}),
            ...decodeAgentModel(params),
            ...(typeof params.agent === 'string' ? { agent: params.agent } : {}),
        },
        observe: params.observe === true,
    };
}
export function encodeAgentReplyParams(input) {
    if (!isRecord(input) ||
        !isBoundedIdentifier(input.sessionId) ||
        !isBoundedIdentifier(input.requestId) ||
        !isMiniAppAgentPermissionDecision(input.decision)) {
        throw agentClientError('INVALID_ARGUMENTS');
    }
    return { sessionId: input.sessionId, requestId: input.requestId, decision: input.decision };
}
function decodeAgentReplyParams(params) {
    if (!params ||
        !hasExactKeys(params, ['sessionId', 'requestId', 'decision']) ||
        !isBoundedIdentifier(params.sessionId) ||
        !isBoundedIdentifier(params.requestId) ||
        !isMiniAppAgentPermissionDecision(params.decision)) {
        throw new HostConnectorProtocolError('Host Connector request is invalid');
    }
    return { sessionId: params.sessionId, requestId: params.requestId, decision: params.decision };
}
export function encodeAgentAnswerParams(input) {
    const answers = isRecord(input) ? readMiniAppAgentAnswers(input.answers) : null;
    if (!isRecord(input) ||
        !answers ||
        !isBoundedIdentifier(input.sessionId) ||
        !isBoundedIdentifier(input.requestId)) {
        throw agentClientError('INVALID_ARGUMENTS');
    }
    return {
        sessionId: input.sessionId,
        requestId: input.requestId,
        answers,
        ...encodeAgentModel(input.model),
    };
}
function decodeAgentAnswerParams(params) {
    const answers = params ? readMiniAppAgentAnswers(params.answers) : null;
    if (!params ||
        !answers ||
        !hasOptionalKeys(params, ['sessionId', 'requestId', 'answers'], ['observe', 'model']) ||
        !isBoundedIdentifier(params.sessionId) ||
        !isBoundedIdentifier(params.requestId) ||
        !isOptional(params, 'observe', isBoolean)) {
        throw new HostConnectorProtocolError('Host Connector request is invalid');
    }
    return {
        params: {
            sessionId: params.sessionId,
            requestId: params.requestId,
            answers,
            ...decodeAgentModel(params),
        },
        observe: params.observe === true,
    };
}
function isAgentRunResult(value) {
    return (isRecord(value) &&
        hasOptionalKeys(value, ['sessionId', 'status'], ['turnId', 'model', 'text', 'error', 'pendingQuestion']) &&
        isBoundedIdentifier(value.sessionId) &&
        isOptional(value, 'turnId', isBoundedIdentifier) &&
        isOptional(value, 'model', isModelSelection) &&
        isRunStatus(value.status) &&
        isOptional(value, 'text', isString) &&
        isOptional(value, 'error', isResultError) &&
        isOptional(value, 'pendingQuestion', isPendingQuestion));
}
/**
 * Child side: decodes the terminal result of any `agent.*` request. `agent.reply` settles with
 * `result: null`; anything else is a protocol error.
 */
export function decodeAgentResult(method, value) {
    const decoded = AGENT_RESULT_DECODERS[method](value);
    if (decoded)
        return decoded.value;
    throw new HostConnectorProtocolError('Mini App Agent result is invalid');
}
const AGENT_RESULT_DECODERS = {
    'agent.reply': (value) => (value === null ? { value: undefined } : undefined),
    'agent.models': (value) => (isAgentModels(value) ? { value } : undefined),
    'agent.agents': (value) => (isAgentAgents(value) ? { value } : undefined),
    'agent.create': (value) => isRecord(value) && hasExactKeys(value, ['sessionId']) && isBoundedIdentifier(value.sessionId)
        ? { value: { sessionId: value.sessionId } }
        : undefined,
    'agent.run': decodeAgentTurnResult,
    'agent.answer': decodeAgentTurnResult,
};
function decodeAgentTurnResult(value) {
    return isAgentRunResult(value) ? { value: projectAgentResult(value) } : undefined;
}
function isModelSelection(value) {
    return readMiniAppAgentModelSelection(value) !== null;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every(isString);
}
function isModelOption(value) {
    return (isRecord(value) &&
        hasOptionalKeys(value, ['providerId', 'modelId', 'displayName'], ['variants', 'thinking']) &&
        isString(value.providerId) &&
        isString(value.modelId) &&
        isString(value.displayName) &&
        isOptional(value, 'variants', isStringArray) &&
        isOptional(value, 'thinking', isThinkingOption));
}
function isThinkingOption(value) {
    return (isRecord(value) &&
        hasOptionalKeys(value, ['efforts'], ['default']) &&
        isStringArray(value.efforts) &&
        isOptional(value, 'default', isString));
}
function isAgentModels(value) {
    return (isRecord(value) &&
        hasOptionalKeys(value, ['models', 'default'], ['host']) &&
        Array.isArray(value.models) &&
        value.models.every(isModelOption) &&
        isModelSelection(value.default) &&
        isOptional(value, 'host', isModelSelection));
}
function isAgentAgents(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['agents']) &&
        Array.isArray(value.agents) &&
        value.agents.every((agent) => isRecord(agent) &&
            hasExactKeys(agent, ['name', 'displayName', 'primary']) &&
            isString(agent.name) &&
            isString(agent.displayName) &&
            isBoolean(agent.primary)));
}
/**
 * Child side: unknown `type`s (a newer Host) are ignored; a known type with a bad shape is a
 * protocol error.
 */
export function decodeAgentRunEvent(value) {
    const event = copyAgentRunEvent(value);
    if (event)
        return event;
    if (isRecord(value) && typeof value.type === 'string' && !agentEventShape(value.type)) {
        return undefined;
    }
    throw new HostConnectorProtocolError('Mini App Agent event is invalid');
}
const isString = (field) => typeof field === 'string';
const isBoolean = (field) => typeof field === 'boolean';
const TEXT_EVENT = { required: ['text'], valid: (value) => isString(value.text) };
const AGENT_EVENT_SHAPES = {
    'run.queued': {
        required: ['position'],
        turnId: 'absent',
        sessionIdOptional: true,
        valid: (value) => typeof value.position === 'number' &&
            Number.isSafeInteger(value.position) &&
            value.position >= 1,
    },
    'turn.started': { required: ['model'], valid: (value) => isModelSelection(value.model) },
    'text.delta': TEXT_EVENT,
    'message.committed': TEXT_EVENT,
    'tool.started': { required: ['name'], valid: (value) => isString(value.name) },
    'tool.finished': {
        required: ['name', 'ok'],
        valid: (value) => isString(value.name) && typeof value.ok === 'boolean',
    },
    'permission.requested': {
        required: ['requestId', 'toolName', 'reason'],
        optional: ['toolInput'],
        turnId: 'optional',
        valid: (value) => isBoundedIdentifier(value.requestId) &&
            isString(value.toolName) &&
            isString(value.reason) &&
            isOptional(value, 'toolInput', isString),
    },
    'question.requested': {
        required: ['requestId', 'mode', 'request'],
        turnId: 'optional',
        valid: (value) => isBoundedIdentifier(value.requestId) &&
            isMiniAppAgentQuestionMode(value.mode) &&
            isQuestionnaireRequest(value.request),
    },
    'turn.finished': {
        required: ['status'],
        optional: ['text', 'error'],
        valid: (value) => isRunStatus(value.status) &&
            isOptional(value, 'text', isString) &&
            isOptional(value, 'error', isResultError),
    },
};
function hasAgentEventEnvelope(value, shape) {
    const sessionKey = shape.sessionIdOptional ? 'optional' : 'required';
    const turnKey = shape.turnId ?? 'required';
    const required = [
        'type',
        ...(sessionKey === 'required' ? ['sessionId'] : []),
        ...(turnKey === 'required' ? ['turnId'] : []),
        ...shape.required,
    ];
    const optional = [
        ...(sessionKey === 'optional' ? ['sessionId'] : []),
        ...(turnKey === 'optional' ? ['turnId'] : []),
        ...(shape.optional ?? []),
    ];
    return (isOptional(value, 'sessionId', isBoundedIdentifier) &&
        isOptional(value, 'turnId', isBoundedIdentifier) &&
        hasOptionalKeys(value, required, optional));
}
function agentEventShape(type) {
    return Object.prototype.hasOwnProperty.call(AGENT_EVENT_SHAPES, type)
        ? AGENT_EVENT_SHAPES[type]
        : undefined;
}
/**
 * Exact-key copy of a known event; anything else is `undefined` so the Host never sends it.
 * An `undefined` field counts as absent, as it would after JSON encoding.
 */
function copyAgentRunEvent(raw) {
    if (!isRecord(raw) || typeof raw.type !== 'string')
        return undefined;
    const value = Object.fromEntries(Object.entries(raw).filter(([, field]) => field !== undefined));
    const shape = agentEventShape(raw.type);
    if (!shape || !hasAgentEventEnvelope(value, shape) || !shape.valid(value))
        return undefined;
    // Every field is now a validated primitive except `error`, whose exact keys were checked,
    // and the questionnaire `request`, whose size the response frame bound limits.
    return {
        ...value,
        ...(isRecord(value.error) ? { error: { ...value.error } } : {}),
        ...(raw.type === 'turn.started' ? { model: readMiniAppAgentModelSelection(value.model) } : {}),
    };
}
export function decodeAgentWireError(value) {
    if (!isRecord(value) ||
        !hasOptionalKeys(value, ['code', 'message', 'retryable'], ['reason']) ||
        !AGENT_ERROR_CODES.has(String(value.code)) ||
        typeof value.message !== 'string' ||
        typeof value.retryable !== 'boolean' ||
        !isOptional(value, 'reason', (reason) => value.code === 'BUSY' && isMiniAppAgentBusyReason(reason))) {
        throw new HostConnectorProtocolError('Mini App Agent error is invalid');
    }
    return new MiniAppAgentError(value.code, value.message, value.retryable, value.reason);
}
/** Malformed params are a protocol error, raised before any response is written. */
function decodeAgentRequest(method, params) {
    if (method === 'agent.reply')
        return { method, params: decodeAgentReplyParams(params) };
    if (method === 'agent.create')
        return { method, params: decodeAgentCreateParams(params) };
    if (method === 'agent.models' || method === 'agent.agents') {
        if (!params || !hasExactKeys(params, [])) {
            throw new HostConnectorProtocolError('Host Connector request is invalid');
        }
        return { method };
    }
    if (method === 'agent.answer')
        return { method, ...decodeAgentAnswerParams(params) };
    return { method, ...decodeAgentRunParams(params) };
}
/** Host-side `agent.*` handling for one generation-bound connector session. */
export function createHostAgentSession(input) {
    const { identity, lifecycle } = input;
    let releaseArena;
    let released = false;
    const admissionError = () => {
        const gate = lifecycle.gate();
        if (gate === 'service-restarted')
            return agentWireError('AGENT_UNAVAILABLE', true);
        return gate === 'open' && lifecycle.isActive()
            ? undefined
            : agentWireError('AGENT_UNAVAILABLE');
    };
    const respondError = (id, error) => input.enqueueResponse({ v: 1, id, ok: false, error });
    /** Policy and lifecycle admission; answers the request itself when refused. */
    const admit = async (id) => {
        const gateway = input.gateway;
        const refusal = !gateway || identity.agentPolicy?.kind !== 'allowlist'
            ? agentWireError('NOT_PERMITTED')
            : admissionError();
        if (refusal)
            await respondError(id, refusal);
        return refusal ? undefined : gateway;
    };
    return {
        /** Registers the arena once; a released session never re-registers. */
        activate() {
            const policy = identity.agentPolicy;
            if (released || releaseArena || !input.gateway || policy?.kind !== 'allowlist')
                return;
            releaseArena = input.gateway.registerArena({
                pluginId: identity.pluginId,
                processGeneration: identity.processGeneration,
                policy,
            });
        },
        release() {
            released = true;
            const release = releaseArena;
            releaseArena = undefined;
            release?.();
        },
        /**
         * Runs one `agent.*` request. `agent.run` / `agent.answer` follow a turn (admitted receipt,
         * events, terminal); the others are short and mark dispatch so a quiesce drains them.
         */
        async handle(frame, signal, markDispatched) {
            const request = decodeAgentRequest(frame.method, frame.params);
            const gateway = await admit(frame.id);
            if (!gateway)
                return;
            if (isShortAgentRequest(request)) {
                await settleShortHostAgent({
                    id: frame.id,
                    operation: () => startShortAgentOperation(gateway, processCaller(identity), request),
                    signal,
                    markDispatched,
                    respond: input.enqueueResponse,
                });
                return;
            }
            const invocationId = input.makeInvocationId();
            await input.enqueueResponse({ v: 1, id: frame.id, receipt: 'admitted', invocationId });
            const after = admissionError();
            if (after) {
                await respondError(frame.id, after);
                return;
            }
            await followHostAgentTurn(input, { id: frame.id, gateway, request, signal });
        },
    };
}
function isShortAgentRequest(request) {
    return request.method !== 'agent.run' && request.method !== 'agent.answer';
}
async function startShortAgentOperation(gateway, caller, request) {
    switch (request.method) {
        case 'agent.reply':
            return gateway.reply(caller, request.params);
        case 'agent.models':
            return projectAgentModels(await gateway.models(caller));
        case 'agent.agents':
            return projectAgentAgents(await gateway.agents(caller));
        case 'agent.create':
            return projectAgentCreate(await gateway.create(caller, request.params));
    }
}
/**
 * Short `agent.*` requests: no receipt or events; the connector request timeout applies.
 * `agent.reply` settles with `null`.
 */
async function settleShortHostAgent(short) {
    try {
        const operation = short.operation();
        short.markDispatched();
        const result = await raceAgentSignal(operation, short.signal);
        await short.respond({ v: 1, id: short.id, ok: true, result: result ?? null });
    }
    catch (error) {
        const wireError = error instanceof MiniAppAgentError
            ? projectAgentError(error)
            : agentWireError('AGENT_OUTCOME_UNKNOWN');
        await short.respond({ v: 1, id: short.id, ok: false, error: wireError });
    }
}
async function followHostAgentTurn(input, turn) {
    const events = createAgentEventQueue({
        maxFrameBytes: input.maxFrameBytes,
        enqueueResponse: input.enqueueResponse,
        onRetainedDrop: (event, reason) => reportRetainedDrop(input, turn, event, reason),
    });
    const terminal = await runHostAgent({
        ...turn,
        identity: input.identity,
        notify: events.notify,
    });
    if (events.dropped() > 0) {
        input.logger?.warn({
            pluginId: input.identity.pluginId,
            processGeneration: input.identity.processGeneration,
            droppedEvents: events.dropped(),
        }, 'Mini App Agent run dropped event frames');
    }
    await input.enqueueResponse(terminal);
}
/**
 * A dropped interaction frame leaves the turn waiting on an ask the child never saw, so it is
 * reported now rather than after the turn; a dropped approval is denied so the turn can go on.
 */
function reportRetainedDrop(input, turn, event, reason) {
    if (event.type !== 'permission.requested' && event.type !== 'question.requested')
        return;
    const fields = {
        pluginId: input.identity.pluginId,
        processGeneration: input.identity.processGeneration,
        sessionId: event.sessionId,
        requestId: event.requestId,
        type: event.type,
        reason,
    };
    input.logger?.warn(fields, 'Mini App Agent run dropped an interaction event frame');
    if (event.type === 'permission.requested')
        denyDroppedPermission(input, turn.gateway, event, fields);
}
/**
 * Detached on purpose: the terminal frame must not wait on a reply that takes no signal.
 * Runs after the Gateway's listener callback returns, since that callback is delivering
 * the very ask being denied.
 */
function denyDroppedPermission(input, gateway, event, fields) {
    detach((async () => {
        // Leave the Gateway's listener callback before replying to the ask it is delivering.
        await Promise.resolve();
        try {
            await gateway.reply(processCaller(input.identity), {
                sessionId: event.sessionId,
                requestId: event.requestId,
                decision: 'deny',
            });
        }
        catch (error) {
            input.logger?.warn({ ...fields, errorName: error instanceof Error ? error.name : typeof error }, 'Mini App Agent could not deny a dropped permission request');
        }
    })());
}
/**
 * Per-run event notifier. Oversized, non-JSON or over-budget event frames are dropped and
 * counted; the terminal frame still settles the run. `retained` frames (an approval or a
 * questionnaire the child must answer) skip the budget, since dropping one stalls the turn;
 * if one cannot be sent at all, `onRetainedDrop` hears about it immediately.
 */
function createAgentEventQueue(input) {
    let queuedEvents = 0;
    let droppedEvents = 0;
    const drop = () => {
        droppedEvents += 1;
        return undefined;
    };
    return {
        notify(frame, retained) {
            if (!retained && queuedEvents >= MAX_QUEUED_AGENT_EVENTS)
                return drop();
            const unsendable = unsendableFrameReason(frame, input.maxFrameBytes);
            if (unsendable) {
                if (retained)
                    input.onRetainedDrop(frame.event, unsendable);
                return drop();
            }
            queuedEvents += 1;
            return settleQueuedEvent(input.enqueueResponse(frame), () => {
                queuedEvents -= 1;
            });
        },
        dropped: () => droppedEvents,
    };
}
function unsendableFrameReason(frame, maxFrameBytes) {
    let json;
    try {
        json = JSON.stringify(frame);
    }
    catch {
        return 'serialize_failed';
    }
    if (json === undefined)
        return 'serialize_failed';
    return Buffer.byteLength(json) > maxFrameBytes ? 'oversized' : undefined;
}
function processCaller(identity) {
    return {
        pluginId: identity.pluginId,
        processGeneration: identity.processGeneration,
        source: 'process',
    };
}
async function runHostAgent(run) {
    let terminal = false;
    let notifications;
    // The Gateway denies approvals of a run nobody listens to, so only an observing child gets one.
    const onEvent = (event) => {
        if (terminal)
            return;
        const projected = copyAgentRunEvent(event);
        if (!projected)
            return;
        notifications =
            run.notify({ v: 1, id: run.id, event: projected }, INTERACTION_EVENT_TYPES.has(projected.type)) ?? notifications;
    };
    const options = {
        signal: run.signal,
        ...(run.request.observe ? { onEvent } : {}),
    };
    const caller = processCaller(run.identity);
    try {
        const result = run.request.method === 'agent.run'
            ? await run.gateway.run(caller, run.request.params, options)
            : await run.gateway.answer(caller, run.request.params, options);
        return { v: 1, id: run.id, ok: true, result: projectAgentResult(result) };
    }
    catch (error) {
        return { v: 1, id: run.id, ok: false, error: hostAgentWireError(error, run.signal) };
    }
    finally {
        terminal = true;
        // The shared write queue already orders notifications before the terminal frame.
        await notifications;
    }
}
async function settleQueuedEvent(write, settled) {
    try {
        await ignoreRejection(write);
    }
    finally {
        settled();
    }
}
async function ignoreRejection(operation) {
    try {
        await operation;
    }
    catch {
        // Transport loss is reported by the owning session's channel binding.
    }
}
function hostAgentWireError(error, signal) {
    if (error instanceof MiniAppAgentError)
        return projectAgentError(error);
    return signal.aborted
        ? agentWireError('REQUEST_CANCELLED')
        : agentWireError('AGENT_OUTCOME_UNKNOWN');
}
/**
 * `gateway.reply` takes no signal; a timeout or teardown stops waiting for it, but the
 * decision may still apply, so the caller reports an unknown outcome.
 */
async function raceAgentSignal(operation, signal) {
    if (signal.aborted)
        throw signal.reason;
    let onAbort;
    try {
        return await Promise.race([
            operation,
            new Promise((_resolve, reject) => {
                onAbort = () => reject(signal.reason);
                signal.addEventListener('abort', onAbort, { once: true });
            }),
        ]);
    }
    finally {
        if (onAbort)
            signal.removeEventListener('abort', onAbort);
    }
}
function agentWireError(code, retryable = false, reason) {
    return { code, message: AGENT_ERROR_MESSAGES[code], retryable, ...(reason ? { reason } : {}) };
}
/** Host-side messages may carry internal detail; the child only gets the fixed text. */
function projectAgentError(error) {
    const reason = error.code === 'BUSY' && isMiniAppAgentBusyReason(error.reason) ? error.reason : undefined;
    return agentWireError(error.code, error.retryable, reason);
}
function projectAgentResult(result) {
    const model = readMiniAppAgentModelSelection(result.model);
    return {
        sessionId: result.sessionId,
        ...(result.turnId ? { turnId: result.turnId } : {}),
        ...(model ? { model } : {}),
        status: result.status,
        ...(result.text === undefined ? {} : { text: result.text }),
        ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}),
        ...(result.pendingQuestion
            ? {
                pendingQuestion: {
                    requestId: result.pendingQuestion.requestId,
                    mode: result.pendingQuestion.mode,
                    request: result.pendingQuestion.request,
                },
            }
            : {}),
    };
}
/** Whitelist copies: a field the runtime adds later must not break the child's strict decoder. */
function projectAgentModels(result) {
    const defaultModel = readMiniAppAgentModelSelection(result.default);
    const host = readMiniAppAgentModelSelection(result.host);
    if (!defaultModel)
        throw new MiniAppAgentError('AGENT_UNAVAILABLE', 'Default model is invalid');
    return {
        models: result.models.map((model) => ({
            providerId: model.providerId,
            modelId: model.modelId,
            displayName: model.displayName,
            ...(model.variants ? { variants: [...model.variants] } : {}),
            ...(model.thinking
                ? {
                    thinking: {
                        efforts: [...model.thinking.efforts],
                        ...(model.thinking.default === undefined ? {} : { default: model.thinking.default }),
                    },
                }
                : {}),
        })),
        default: defaultModel,
        ...(host ? { host } : {}),
    };
}
function projectAgentAgents(result) {
    return {
        agents: result.agents.map((agent) => ({
            name: agent.name,
            displayName: agent.displayName,
            primary: agent.primary,
        })),
    };
}
function projectAgentCreate(result) {
    return { sessionId: result.sessionId };
}
function isRunStatus(value) {
    return value === 'finished' || value === 'error' || value === 'aborted';
}
function isPendingQuestion(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['requestId', 'mode', 'request']) &&
        isBoundedIdentifier(value.requestId) &&
        isMiniAppAgentQuestionMode(value.mode) &&
        isQuestionnaireRequest(value.request));
}
/** Envelope check only; the step list is passed through as the Host chat renders it. */
function isQuestionnaireRequest(value) {
    return (isRecord(value) &&
        value.schemaVersion === 2 &&
        isBoundedIdentifier(value.id) &&
        Array.isArray(value.steps));
}
function isOptional(value, key, check) {
    return !(key in value) || check(value[key]);
}
function isResultError(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['code', 'message']) &&
        typeof value.code === 'string' &&
        typeof value.message === 'string');
}
function hasOptionalKeys(value, required, optional) {
    return hasExactKeys(value, [...required, ...optional.filter((key) => key in value)]);
}
//# sourceMappingURL=host-connector-agent.js.map