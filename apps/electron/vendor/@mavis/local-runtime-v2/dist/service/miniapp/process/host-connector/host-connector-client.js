import { format } from 'node:util';
import { bindMiniAppIpcChannel, encodeMiniAppIpcMessage, sendMiniAppIpcMessage, } from '../node-runtime/ipc-transport.js';
import { agentClientError, decodeAgentResult, decodeAgentRunEvent, decodeAgentWireError, encodeAgentAnswerParams, encodeAgentCreateParams, encodeAgentReplyParams, encodeAgentRunParams, } from './host-connector-agent.js';
import { HostConnectorError, HostConnectorProtocolError, isSafeHostConnectorDiagnosticConstraint, isSafeHostConnectorDiagnosticPath, } from './host-connector-errors.js';
import { hasExactKeys, hasHostConnectorRequestCapacity, isAgentMethod, isAgentShortMethod, isAgentTurnMethod, isBoundedIdentifier, isRecord, isRequestId, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, } from './host-connector-wire.js';
/** Child-side implementation injected into `start(context)`. */
export function createMiniAppHostConnectorRuntimeClient(options) {
    const pending = new Map();
    let nextRequestId = 1n;
    let closed = false;
    let writeTail = Promise.resolve();
    const detach = bindMiniAppIpcChannel(options.transport, {
        type: 'miniapp:connector',
        maxBytes: RESPONSE_MAX_BYTES,
        onMessage: handleResponse,
        onFatal: fatal,
    });
    function fatal(error) {
        if (closed)
            return;
        closed = true;
        const normalized = error instanceof Error ? error : new HostConnectorProtocolError('Host Connector failed');
        for (const [id, entry] of pending) {
            entry.abortCleanup?.();
            entry.reject(disconnectedError(id, entry));
        }
        pending.clear();
        detach();
        options.onFatal?.(normalized);
    }
    function handleResponse(value) {
        if (!isRecord(value) || value.v !== 1 || !isRequestId(value.id)) {
            throw new HostConnectorProtocolError('Host Connector response envelope is invalid');
        }
        const entry = pending.get(value.id);
        if (!entry)
            throw new HostConnectorProtocolError('Host Connector response id is unknown');
        if (value.receipt === 'admitted') {
            recordAdmissionReceipt(value, entry);
            return;
        }
        if ('event' in value) {
            deliverAgentEvent(value, entry);
            return;
        }
        const outcome = decodeChildOutcome(entry, value);
        settle(value.id, entry, outcome.error, outcome.result);
    }
    function settle(id, entry, error, result) {
        pending.delete(id);
        entry.abortCleanup?.();
        if (error)
            entry.reject(error);
        else
            entry.resolve(result);
    }
    function send(method, params, signal, onEvent) {
        if (closed)
            return Promise.reject(childUnavailableError(method));
        if (signal?.aborted)
            return Promise.reject(childCancelledError(method));
        if (!hasHostConnectorRequestCapacity(method, pending.values())) {
            return Promise.reject(childUnavailableError(method, true));
        }
        const id = allocateRequestId();
        let frame;
        try {
            frame = encodeMiniAppIpcMessage('miniapp:connector', { v: 1, id, method, params }, REQUEST_MAX_BYTES);
        }
        catch {
            return Promise.reject(childEncodeError(method));
        }
        return new Promise((resolve, reject) => {
            const entry = {
                method,
                resolve,
                reject,
                written: false,
                ...(onEvent ? { onEvent } : {}),
            };
            pending.set(id, entry);
            const onAbort = () => {
                if (!entry.written) {
                    settle(id, entry, childCancelledError(method));
                    return;
                }
                enqueueWrite(async () => {
                    if (pending.has(id)) {
                        await sendMiniAppIpcMessage(options.transport, encodeMiniAppIpcMessage('miniapp:connector', { v: 1, id, method: isAgentMethod(method) ? 'agent.cancel' : 'connector.cancel' }, REQUEST_MAX_BYTES));
                    }
                });
            };
            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true });
                entry.abortCleanup = () => signal.removeEventListener('abort', onAbort);
            }
            enqueueWrite(async () => {
                if (!pending.has(id))
                    return;
                await sendMiniAppIpcMessage(options.transport, frame, () => {
                    entry.written = true;
                });
                if (signal?.aborted)
                    onAbort();
            });
        });
    }
    function enqueueWrite(operation) {
        writeTail = runChildWrite(writeTail, operation, fatal);
    }
    function allocateRequestId() {
        if (nextRequestId > 18446744073709551615n) {
            throw new HostConnectorProtocolError('Host Connector request ids exhausted');
        }
        const value = nextRequestId.toString();
        nextRequestId += 1n;
        return value;
    }
    const client = Object.freeze({
        async list(callOptions) {
            return (await send('connector.list', {}, callOptions?.signal));
        },
        async call(toolRef, arguments_, callOptions) {
            if (!isBoundedIdentifier(toolRef) || !isRecord(arguments_)) {
                throw invalidArgumentsError();
            }
            return (await send('connector.call', { toolRef, arguments: arguments_ }, callOptions?.signal));
        },
    });
    async function sendAgentTurn(method, params, turnOptions) {
        const onEvent = typeof turnOptions?.onEvent === 'function' ? turnOptions.onEvent : undefined;
        // Without `observe` the Host runs the turn with no listener, so its approvals are denied.
        const wireParams = onEvent ? { ...params, observe: true } : params;
        return (await send(method, wireParams, turnOptions?.signal, onEvent));
    }
    const agent = Object.freeze({
        async run(input, runOptions) {
            return sendAgentTurn('agent.run', encodeAgentRunParams(input), runOptions);
        },
        async reply(input) {
            await send('agent.reply', encodeAgentReplyParams(input));
        },
        async answer(input, answerOptions) {
            return sendAgentTurn('agent.answer', encodeAgentAnswerParams(input), answerOptions);
        },
        async models() {
            return (await send('agent.models', {}));
        },
        async agents() {
            return (await send('agent.agents', {}));
        },
        async create(input) {
            return (await send('agent.create', encodeAgentCreateParams(input)));
        },
    });
    return {
        client,
        agent,
        close() {
            fatal(new HostConnectorProtocolError('Host Connector client closed'));
        },
    };
}
async function runChildWrite(previous, operation, fatal) {
    try {
        await previous;
        await operation();
    }
    catch (error) {
        fatal(error);
    }
}
function decodeChildOutcome(entry, value) {
    const success = value.ok === true;
    const keys = success ? ['v', 'id', 'ok', 'result'] : ['v', 'id', 'ok', 'error'];
    if (!hasExactKeys(value, keys)) {
        throw new HostConnectorProtocolError('Host Connector response shape is invalid');
    }
    if (success) {
        const result = decodeChildResult(entry.method, value.result);
        assertInvocationIdentity(entry, result);
        return { result };
    }
    if (isAgentMethod(entry.method))
        return { error: decodeAgentWireError(value.error) };
    const error = decodeWireError(value.error);
    assertInvocationIdentity(entry, error);
    return { error };
}
function deliverAgentEvent(value, entry) {
    if (!hasExactKeys(value, ['v', 'id', 'event'])) {
        throw new HostConnectorProtocolError('Host Connector notification shape is invalid');
    }
    if (!isAgentTurnMethod(entry.method))
        return;
    const event = decodeAgentRunEvent(value.event);
    if (!event)
        return;
    try {
        entry.onEvent?.(event);
    }
    catch (error) {
        // A Mini App callback failure must not tear down the shared connector channel or end the
        // run, but the author still needs to see it; child stderr is collected into runtime logs.
        reportAgentEventHandlerError(error);
    }
}
function reportAgentEventHandlerError(error) {
    try {
        process.stderr.write(`${format('[miniapp] agent onEvent handler threw', error)}\n`);
    }
    catch {
        // Diagnostics are best-effort; a broken stderr must not fail the run either.
    }
}
function decodeChildResult(method, value) {
    if (isAgentMethod(method))
        return decodeAgentResult(method, value);
    if (!isRecord(value))
        throw new HostConnectorProtocolError('Host Connector result is invalid');
    if (method === 'connector.list') {
        if (!hasExactKeys(value, ['tools', 'partial']) ||
            !Array.isArray(value.tools) ||
            typeof value.partial !== 'boolean') {
            throw new HostConnectorProtocolError('Host Connector inventory is invalid');
        }
        return value;
    }
    if (!hasExactKeys(value, ['invocationId', 'value']) || !isBoundedIdentifier(value.invocationId)) {
        throw new HostConnectorProtocolError('Host Connector call result is invalid');
    }
    return value;
}
function decodeWireError(value) {
    if (!isWireErrorEnvelope(value)) {
        throw new HostConnectorProtocolError('Host Connector error is invalid');
    }
    const diagnostic = 'diagnostic' in value ? decodeWireDiagnostic(value.diagnostic) : undefined;
    if ((value.code === 'INVALID_ARGUMENTS' || diagnostic) && !isInvalidArgumentsWireError(value)) {
        throw new HostConnectorProtocolError('Host Connector error is invalid');
    }
    return new HostConnectorError(value.code, value.message, value.disposition, {
        retryable: value.retryable,
        ...(typeof value.invocationId === 'string' ? { invocationId: value.invocationId } : {}),
        ...(diagnostic ? { diagnostic } : {}),
    });
}
function isWireErrorEnvelope(value) {
    if (!isRecord(value))
        return false;
    return (hasExactKeys(value, [
        'code',
        'message',
        'disposition',
        'retryable',
        ...('invocationId' in value ? ['invocationId'] : []),
        ...('diagnostic' in value ? ['diagnostic'] : []),
    ]) &&
        typeof value.code === 'string' &&
        typeof value.message === 'string' &&
        isHostConnectorDisposition(value.disposition) &&
        typeof value.retryable === 'boolean' &&
        (!('invocationId' in value) || isBoundedIdentifier(value.invocationId)));
}
function isHostConnectorDisposition(value) {
    return ['not_dispatched', 'provider_reported', 'unknown_after_dispatch'].includes(String(value));
}
function isInvalidArgumentsWireError(value) {
    return (value.code === 'INVALID_ARGUMENTS' &&
        value.message === 'Connector arguments are invalid' &&
        value.disposition === 'not_dispatched' &&
        !value.retryable);
}
function decodeWireDiagnostic(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['issues']) ||
        !Array.isArray(value.issues) ||
        value.issues.length === 0 ||
        value.issues.length > 4) {
        throw new HostConnectorProtocolError('Host Connector error diagnostic is invalid');
    }
    return { issues: value.issues.map(decodeWireDiagnosticIssue) };
}
function decodeWireDiagnosticIssue(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['path', 'constraint', ...('limit' in value ? ['limit'] : [])]) ||
        !isSafeHostConnectorDiagnosticPath(value.path) ||
        !isSafeHostConnectorDiagnosticConstraint(value.constraint) ||
        ('limit' in value && (typeof value.limit !== 'number' || !Number.isFinite(value.limit)))) {
        throw new HostConnectorProtocolError('Host Connector error diagnostic is invalid');
    }
    return {
        path: value.path,
        constraint: value.constraint,
        ...('limit' in value ? { limit: value.limit } : {}),
    };
}
function recordAdmissionReceipt(value, entry) {
    if (entry.method === 'connector.list' ||
        isAgentShortMethod(entry.method) ||
        entry.invocationId ||
        !hasExactKeys(value, ['v', 'id', 'receipt', 'invocationId']) ||
        !isBoundedIdentifier(value.invocationId)) {
        throw new HostConnectorProtocolError('Host Connector admission receipt is invalid');
    }
    entry.invocationId = value.invocationId;
}
function assertInvocationIdentity(entry, value) {
    if (entry.method !== 'connector.call')
        return;
    let actual;
    if (value instanceof HostConnectorError)
        actual = value.invocationId;
    else if (isRecord(value) && typeof value.invocationId === 'string') {
        actual = value.invocationId;
    }
    if (entry.invocationId === actual)
        return;
    throw new HostConnectorProtocolError('Host Connector invocation identity is invalid');
}
function disconnectedError(id, request) {
    if (isAgentMethod(request.method)) {
        return request.written
            ? agentClientError('AGENT_OUTCOME_UNKNOWN')
            : agentClientError('AGENT_UNAVAILABLE', true);
    }
    return request.method === 'connector.call' && request.written
        ? new HostConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'Host Connector transport ended after dispatch became possible', 'unknown_after_dispatch', { retryable: false, invocationId: request.invocationId ?? id })
        : unavailableError(true);
}
function childUnavailableError(method, retryable = false) {
    return isAgentMethod(method)
        ? agentClientError('AGENT_UNAVAILABLE', retryable)
        : unavailableError(retryable);
}
function childCancelledError(method) {
    return isAgentMethod(method) ? agentClientError('REQUEST_CANCELLED') : cancelledError();
}
function childEncodeError(method) {
    if (isAgentMethod(method))
        return agentClientError('INVALID_ARGUMENTS');
    return method === 'connector.call'
        ? invalidArgumentsError()
        : new HostConnectorProtocolError('Host Connector list request is invalid');
}
function unavailableError(retryable = false) {
    return new HostConnectorError('CONNECTOR_UNAVAILABLE', 'Host Connector is unavailable', 'not_dispatched', { retryable });
}
function cancelledError() {
    return new HostConnectorError('REQUEST_CANCELLED', 'Host Connector request was cancelled', 'not_dispatched', { retryable: false });
}
function invalidArgumentsError() {
    return new HostConnectorError('INVALID_ARGUMENTS', 'Host Connector arguments must fit one JSON frame', 'not_dispatched', { retryable: false });
}
//# sourceMappingURL=host-connector-client.js.map