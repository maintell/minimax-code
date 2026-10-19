import { randomUUID } from 'node:crypto';
import { ConnectorGatewayError, } from '../../../host-connector-system/index.js';
import { bindMiniAppIpcChannel, encodeMiniAppIpcMessage, sendMiniAppIpcMessage, } from '../node-runtime/ipc-transport.js';
import { createHostConnectorGatewayRelease, HostConnectorSessionLifecycle, } from './host-connector-quiesce.js';
import { HostConnectorCancelledError, HostConnectorError, HostConnectorProtocolError, HostConnectorRequestTimeoutError, isSafeHostConnectorDiagnosticConstraint, isSafeHostConnectorDiagnosticPath, normalizeGatewayError, providerWireError, serviceRestartedWireError, staleToolWireError, unavailableWireError, } from './host-connector-errors.js';
const REQUEST_MAX_BYTES = 256 * 1024;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_PENDING = 16;
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
        const success = value.ok === true;
        const keys = success ? ['v', 'id', 'ok', 'result'] : ['v', 'id', 'ok', 'error'];
        if (!hasExactKeys(value, keys)) {
            throw new HostConnectorProtocolError('Host Connector response shape is invalid');
        }
        if (success) {
            const result = decodeChildResult(entry.method, value.result);
            assertInvocationIdentity(entry, result);
            settle(value.id, entry, undefined, result);
            return;
        }
        const decoded = decodeWireError(value.error);
        assertInvocationIdentity(entry, decoded);
        settle(value.id, entry, decoded);
    }
    function settle(id, entry, error, result) {
        pending.delete(id);
        entry.abortCleanup?.();
        if (error)
            entry.reject(error);
        else
            entry.resolve(result);
    }
    function send(method, params, signal) {
        if (closed)
            return Promise.reject(unavailableError());
        if (signal?.aborted)
            return Promise.reject(cancelledError());
        if (pending.size >= MAX_PENDING)
            return Promise.reject(unavailableError(true));
        const id = allocateRequestId();
        let frame;
        try {
            frame = encodeMiniAppIpcMessage('miniapp:connector', { v: 1, id, method, params }, REQUEST_MAX_BYTES);
        }
        catch {
            return Promise.reject(method === 'connector.call'
                ? invalidArgumentsError()
                : new HostConnectorProtocolError('Host Connector list request is invalid'));
        }
        return new Promise((resolve, reject) => {
            const entry = { method, resolve, reject, written: false };
            pending.set(id, entry);
            const onAbort = () => {
                if (!entry.written) {
                    settle(id, entry, cancelledError());
                    return;
                }
                enqueueWrite(async () => {
                    if (pending.has(id)) {
                        await sendMiniAppIpcMessage(options.transport, encodeMiniAppIpcMessage('miniapp:connector', { v: 1, id, method: 'connector.cancel' }, REQUEST_MAX_BYTES));
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
    return {
        client,
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
function markHostRequestDispatched(requests, id) {
    const request = requests.get(id);
    if (request)
        request.dispatched = true;
}
function dispatchedRequestCompletions(requests) {
    return [...requests.values()]
        .filter((request) => request.dispatched)
        .map((request) => request.completion);
}
function requestCompletions(requests) {
    return [...requests.values()].map((request) => request.completion);
}
function registerActiveHostRequest(requests, id, controller) {
    let resolveCompletion;
    const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
    });
    const request = {
        controller,
        completion,
        dispatched: false,
        complete: () => {
            requests.delete(id);
            resolveCompletion();
        },
    };
    requests.set(id, request);
    return request;
}
/** Host-side generation-bound session backed only by the ConnectorGateway seam. */
export function createMiniAppHostConnectorSessionFactory(options) {
    return {
        create(input) {
            options.gateway.registerHostProcess({
                pluginId: input.pluginId,
                processGeneration: input.processGeneration,
            });
            return createHostConnectorSession(options, input);
        },
    };
}
function createHostConnectorSession(options, input) {
    const requests = new Map();
    let highestRequestId = 0n;
    let refs = new Map();
    let refsByHandle = new Map();
    const lifecycle = new HostConnectorSessionLifecycle();
    let handshakeStarted = false;
    let fatalReported = false;
    let publishResponses = true;
    let writeTail = Promise.resolve();
    let retirePromise;
    const releaseGateway = createHostConnectorGatewayRelease(options.gateway, input);
    const makeToolRef = options.makeToolRef ?? randomUUID;
    const makeInvocationId = options.makeInvocationId ?? randomUUID;
    const timeouts = hostSessionTimeouts(options);
    const detach = bindMiniAppIpcChannel(input.transport, {
        type: 'miniapp:connector',
        maxBytes: REQUEST_MAX_BYTES,
        onMessage(value) {
            if (!handshakeStarted) {
                throw new HostConnectorProtocolError('Host Connector request preceded handshake');
            }
            handleFrame(value);
        },
        onFatal: fail,
    });
    function handleFrame(value) {
        const frame = decodeRequest(value);
        if (frame.method === 'connector.cancel') {
            const request = requests.get(frame.id);
            if (request) {
                request.controller.abort(new HostConnectorCancelledError('Request cancelled'));
            }
            else if (BigInt(frame.id) > highestRequestId) {
                throw new HostConnectorProtocolError('Host Connector cancel id is unknown');
            }
            return;
        }
        const numericId = BigInt(frame.id);
        if (numericId <= highestRequestId || requests.size >= MAX_PENDING) {
            throw new HostConnectorProtocolError('Host Connector request ordering is invalid');
        }
        highestRequestId = numericId;
        const controller = new AbortController();
        const request = registerActiveHostRequest(requests, frame.id, controller);
        request.execution = runTimedHostRequest({
            frame,
            controller,
            timeoutMs: timeouts.requestMs,
            dispatch,
            fail,
            complete: request.complete,
        });
    }
    async function dispatch(frame, signal) {
        const gate = lifecycle.gate();
        if (gate !== 'open') {
            await respondError(frame.id, gate === 'service-restarted' ? serviceRestartedWireError() : unavailableWireError());
            return;
        }
        if (frame.method === 'connector.list') {
            if (!frame.params || !hasExactKeys(frame.params, []))
                throw protocolParamsError();
            await list(frame.id, signal);
            return;
        }
        const callParams = decodeCallParams(frame.params);
        if (!lifecycle.isActive()) {
            await respondError(frame.id, unavailableWireError());
            return;
        }
        await call(frame.id, callParams.toolRef, callParams.arguments, signal);
    }
    async function list(id, signal) {
        try {
            const inventory = await listHostConnectorTools({
                gateway: options.gateway,
                pluginId: input.pluginId,
                processGeneration: input.processGeneration,
                providers: input.providers,
                signal,
                makeToolRef,
                previousRefs: refsByHandle,
                markDispatched: () => markHostRequestDispatched(requests, id),
            });
            refs = inventory.refs;
            refsByHandle = inventory.refsByHandle;
            await respond(id, { tools: inventory.tools, partial: inventory.partial });
        }
        catch (error) {
            await respondError(id, normalizeGatewayError(error));
        }
    }
    async function call(id, toolRef, arguments_, signal) {
        await dispatchHostConnectorCall({
            id,
            toolRef,
            arguments: arguments_,
            signal,
            refs,
            gateway: options.gateway,
            pluginId: input.pluginId,
            processGeneration: input.processGeneration,
            makeInvocationId,
            admissionGate: () => lifecycle.gate(),
            markDispatched: () => markHostRequestDispatched(requests, id),
            enqueueResponse,
            respond,
            respondError,
        });
    }
    const respond = (id, result) => enqueueResponse({ v: 1, id, ok: true, result });
    const respondError = (id, error) => enqueueResponse({ v: 1, id, ok: false, error });
    function enqueueResponse(value) {
        const operation = writeHostResponse(writeTail, () => publishResponses && !lifecycle.isRetired() && input.transport.connected !== false, input.transport, value);
        writeTail = ignoreFailure(operation);
        return operation;
    }
    async function retire() {
        if (!lifecycle.beginRetirement())
            return;
        const pending = requestCompletions(requests);
        if (!(await settleWithin(Promise.allSettled(pending), timeouts.graceMs))) {
            publishResponses = false;
            for (const request of requests.values())
                request.controller.abort();
        }
        await settleWithin(Promise.allSettled([...requestCompletions(requests), writeTail]), timeouts.settleMs);
        lifecycle.markRetired();
        refs.clear();
        refsByHandle.clear();
        detach();
        releaseGateway();
    }
    function fail(error) {
        if (fatalReported || lifecycle.isRetired())
            return;
        fatalReported = true;
        lifecycle.beginRetirement();
        publishResponses = false;
        refs.clear();
        refsByHandle.clear();
        for (const request of requests.values())
            request.controller.abort();
        detach();
        releaseGateway();
        retirePromise ??= retire();
        input.onFatal(error instanceof Error ? error : new HostConnectorProtocolError('Host Connector failed'));
    }
    return {
        startHandshake() {
            if (!lifecycle.isRetired())
                handshakeStarted = true;
        },
        activate: () => lifecycle.activate(),
        beginQuiesce(quiesceInput) {
            return lifecycle.beginQuiesce({
                pending: dispatchedRequestCompletions(requests),
                deadlineMs: quiesceInput.deadlineMs,
                signal: quiesceInput.signal,
                commit: () => {
                    refs.clear();
                    refsByHandle.clear();
                    releaseGateway();
                },
            });
        },
        retire() {
            retirePromise ??= retire();
            return retirePromise;
        },
        close() {
            publishResponses = false;
            for (const request of requests.values())
                request.controller.abort();
            refs.clear();
            refsByHandle.clear();
            detach();
            releaseGateway();
            retirePromise ??= retire();
            return retirePromise;
        },
    };
}
async function dispatchHostConnectorCall(input) {
    const handle = input.refs.get(input.toolRef);
    if (!handle) {
        await input.respondError(input.id, staleToolWireError());
        return;
    }
    let invocationId;
    let gatewayPromiseObtained = false;
    try {
        invocationId = requireInvocationId(input.makeInvocationId());
        await input.enqueueResponse({ v: 1, id: input.id, receipt: 'admitted', invocationId });
        const gate = input.admissionGate();
        if (gate !== 'open') {
            await input.respondError(input.id, gate === 'service-restarted'
                ? serviceRestartedWireError(invocationId)
                : { ...unavailableWireError(), invocationId });
            return;
        }
        const call = beginHostConnectorToolCall({
            gateway: input.gateway,
            handle,
            arguments: input.arguments,
            pluginId: input.pluginId,
            processGeneration: input.processGeneration,
            clientRequestId: input.id,
            invocationId,
            signal: input.signal,
        });
        gatewayPromiseObtained = true;
        input.markDispatched();
        const result = await completeHostConnectorToolCall(call, input.signal, invocationId);
        if (result.isError) {
            await input.respondError(input.id, providerWireError(invocationId));
            return;
        }
        await input.respond(input.id, { invocationId, value: result.value });
    }
    catch (error) {
        await input.respondError(input.id, normalizeGatewayError(error, invocationId, gatewayPromiseObtained));
    }
}
function hostSessionTimeouts(options) {
    return {
        graceMs: Math.max(1, options.graceTimeoutMs ?? 4_000),
        settleMs: Math.max(1, options.settleTimeoutMs ?? 1_000),
        requestMs: Math.max(1, options.requestTimeoutMs ?? 30_000),
    };
}
async function runTimedHostRequest(input) {
    const timer = setTimeout(() => input.controller.abort(new HostConnectorRequestTimeoutError('Host Connector request timed out')), input.timeoutMs);
    timer.unref();
    try {
        await input.dispatch(input.frame, input.controller.signal);
    }
    catch (error) {
        input.fail(error);
    }
    finally {
        clearTimeout(timer);
        input.complete();
    }
}
async function listHostConnectorTools(input) {
    const operation = input.gateway.list({
        providerAllowlist: input.providers,
        caller: {
            kind: 'host-process',
            pluginId: input.pluginId,
            processGeneration: input.processGeneration,
        },
        signal: input.signal,
    });
    input.markDispatched();
    const inventory = await raceWithSignal(operation, input.signal);
    const refs = new Map();
    const refsByHandle = new Map();
    const tools = [];
    let partial = inventory.partial;
    for (const tool of inventory.tools) {
        try {
            tools.push(decodeInventoryTool({
                tool,
                refs,
                refsByHandle,
                previousRefs: input.previousRefs,
                makeToolRef: input.makeToolRef,
            }));
        }
        catch (error) {
            if (!(error instanceof HostConnectorProtocolError))
                throw error;
            partial = true;
        }
    }
    return { tools, refs, refsByHandle, partial };
}
function decodeInventoryTool(input) {
    const { tool } = input;
    const inputSchema = parseJson(tool.inputSchemaJson, RESPONSE_MAX_BYTES);
    const outputSchema = tool.outputSchemaJson
        ? parseJson(tool.outputSchemaJson, RESPONSE_MAX_BYTES)
        : undefined;
    const previousRef = input.previousRefs.get(tool.handle);
    const toolRef = previousRef ?? mintToolRef(tool.handle, input.refs, input.makeToolRef);
    if (previousRef && input.refs.has(toolRef)) {
        throw new HostConnectorProtocolError('Host Connector tool reference collided');
    }
    if (previousRef)
        input.refs.set(toolRef, tool.handle);
    input.refsByHandle.set(tool.handle, toolRef);
    return {
        toolRef: toolRef,
        provider: tool.provider,
        name: tool.providerToolName,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema,
        ...(outputSchema === undefined ? {} : { outputSchema }),
    };
}
function beginHostConnectorToolCall(input) {
    return input.gateway.call({
        handle: input.handle,
        arguments: input.arguments,
        caller: {
            kind: 'host-process',
            pluginId: input.pluginId,
            processGeneration: input.processGeneration,
        },
        hostRequest: {
            clientRequestId: input.clientRequestId,
            invocationId: input.invocationId,
        },
        signal: input.signal,
    });
}
async function completeHostConnectorToolCall(operation, signal, invocationId) {
    const result = await raceWithSignal(operation, signal);
    let value;
    try {
        value = result.isError ? null : parseJson(result.resultJson ?? 'null', RESPONSE_MAX_BYTES);
    }
    catch {
        throw new ConnectorGatewayError('CONNECTOR_RESULT_INVALID', 'Connector result was invalid after dispatch', 'unknown_after_dispatch', invocationId);
    }
    return {
        isError: result.isError,
        value,
    };
}
function mintToolRef(handle, target, makeToolRef) {
    for (let attempt = 0; attempt < 32; attempt += 1) {
        const ref = makeToolRef();
        if (isBoundedIdentifier(ref) && !target.has(ref)) {
            target.set(ref, handle);
            return ref;
        }
    }
    throw new HostConnectorProtocolError('Host Connector could not mint a tool ref');
}
async function writeHostResponse(previous, shouldPublish, transport, value) {
    await previous;
    if (!shouldPublish())
        return;
    await sendMiniAppIpcMessage(transport, encodeMiniAppIpcMessage('miniapp:connector', value, RESPONSE_MAX_BYTES));
}
async function raceWithSignal(operation, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    let rejectOnAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        rejectOnAbort = reject;
    });
    const onAbort = () => rejectOnAbort(signal.reason);
    try {
        signal.addEventListener('abort', onAbort, { once: true });
        return await Promise.race([operation, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
async function ignoreFailure(operation) {
    try {
        await operation;
    }
    catch {
        // The owning state machine reports or intentionally suppresses transport failure.
    }
}
function decodeCallParams(params) {
    if (!params ||
        !hasExactKeys(params, ['toolRef', 'arguments']) ||
        !isBoundedIdentifier(params.toolRef) ||
        !isRecord(params.arguments)) {
        throw protocolParamsError();
    }
    return { toolRef: params.toolRef, arguments: params.arguments };
}
function decodeRequest(value) {
    if (!isRecord(value) || value.v !== 1 || !isRequestId(value.id))
        throw protocolParamsError();
    if (value.method === 'connector.cancel' && hasExactKeys(value, ['v', 'id', 'method'])) {
        return { id: value.id, method: value.method };
    }
    if ((value.method !== 'connector.list' && value.method !== 'connector.call') ||
        !hasExactKeys(value, ['v', 'id', 'method', 'params']) ||
        !isRecord(value.params)) {
        throw protocolParamsError();
    }
    return { id: value.id, method: value.method, params: value.params };
}
function decodeChildResult(method, value) {
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
    if (entry.method !== 'connector.call' ||
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
function parseJson(json, maxBytes) {
    if (Buffer.byteLength(json) > maxBytes) {
        throw new HostConnectorProtocolError('Host Connector payload exceeds its frame limit');
    }
    let value;
    try {
        value = JSON.parse(json);
    }
    catch {
        throw new HostConnectorProtocolError('Host Connector payload is not valid JSON');
    }
    return value;
}
async function settleWithin(operation, timeoutMs) {
    let timer;
    const result = await Promise.race([
        resolvesTrue(operation),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
            timer.unref();
        }),
    ]);
    if (timer)
        clearTimeout(timer);
    return result;
}
async function resolvesTrue(operation) {
    await operation;
    return true;
}
function disconnectedError(id, request) {
    return request.method === 'connector.call' && request.written
        ? new HostConnectorError('CONNECTOR_OUTCOME_UNKNOWN', 'Host Connector transport ended after dispatch became possible', 'unknown_after_dispatch', { retryable: false, invocationId: request.invocationId ?? id })
        : unavailableError(true);
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
function protocolParamsError() {
    return new HostConnectorProtocolError('Host Connector request is invalid');
}
function requireInvocationId(value) {
    if (!isBoundedIdentifier(value)) {
        throw new HostConnectorProtocolError('Host Connector invocation id is invalid');
    }
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isBoundedIdentifier(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES);
}
function isRequestId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/u.test(value))
        return false;
    try {
        return BigInt(value) <= 18446744073709551615n;
    }
    catch {
        return false;
    }
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
//# sourceMappingURL=host-connector.js.map