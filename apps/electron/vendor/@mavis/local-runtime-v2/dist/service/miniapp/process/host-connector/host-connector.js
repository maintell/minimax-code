import { randomUUID } from 'node:crypto';
import { miniAppPermissionId } from '@mavis/shared/miniapp-surface';
import { ConnectorGatewayError, } from '../../../host-connector-system/index.js';
import { bindMiniAppIpcChannel, encodeMiniAppIpcMessage, sendMiniAppIpcMessage, } from '../node-runtime/ipc-transport.js';
import { raceWithSignal } from './host-connector-abort.js';
import { createHostAgentSession } from './host-connector-agent.js';
import { createHostToolSession } from './host-connector-tool.js';
import { createHostConnectorGatewayRelease, HostConnectorSessionLifecycle, } from './host-connector-quiesce.js';
import { HostConnectorCancelledError, HostConnectorProtocolError, HostConnectorRequestTimeoutError, normalizeGatewayError, notPermittedWireError, providerWireError, serviceRestartedWireError, staleToolWireError, unavailableWireError, } from './host-connector-errors.js';
import { hasExactKeys, hasHostConnectorRequestCapacity, isAgentMethod, isAgentSessionReadMethod, isAgentStreamMethod, isBoundedIdentifier, isCancelMethod, isRecord, isRequestId, isToolMethod, REQUEST_MAX_BYTES, RESPONSE_MAX_BYTES, } from './host-connector-wire.js';
export { createMiniAppHostConnectorRuntimeClient, } from './host-connector-client.js';
function requireHostRequestAdmission(id, method, highestRequestId, requests) {
    const numericId = BigInt(id);
    if (numericId <= highestRequestId ||
        !hasHostConnectorRequestCapacity(method, requests.values())) {
        throw new HostConnectorProtocolError('Host Connector request ordering is invalid');
    }
    return numericId;
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
function registerActiveHostRequest(requests, id, controller, method) {
    let resolveCompletion;
    const completion = new Promise((resolve) => {
        resolveCompletion = resolve;
    });
    const request = {
        method,
        controller,
        completion,
        endsOnCutover: isAgentStreamMethod(method) || isAgentSessionReadMethod(method),
        dispatched: false,
        complete: () => {
            requests.delete(id);
            resolveCompletion();
        },
    };
    requests.set(id, request);
    return request;
}
/**
 * Agent turns, observers and session reads never hold a cutover open: once it commits they are
 * cancelled, so the retired generation receives no more of the user's sessions.
 */
function abortAgentRequests(requests) {
    for (const request of requests.values()) {
        if (request.endsOnCutover) {
            request.controller.abort(new HostConnectorCancelledError('Mini App Agent run cancelled'));
        }
    }
}
/**
 * A forced cutover stops waiting for dispatched work that missed the drain deadline. Responses
 * still publish, so each child caller gets its terminal outcome (unknown after dispatch for a
 * call) before the root stops.
 */
function abortDispatchedRequests(requests) {
    for (const request of requests.values()) {
        if (request.dispatched)
            request.controller.abort();
    }
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
    const connectorSwitches = createConnectorSwitchView(options.permissionSwitches, input.pluginId);
    let handshakeStarted = false;
    let fatalReported = false;
    let publishResponses = true;
    let retirePromise;
    const makeToolRef = options.makeToolRef ?? randomUUID;
    const makeInvocationId = options.makeInvocationId ?? randomUUID;
    const timeouts = hostSessionTimeouts(options);
    const writer = createHostResponseWriter(input.transport, () => publishResponses && !lifecycle.isRetired() && input.transport.connected !== false);
    const enqueueResponse = writer.enqueue;
    const { agent, tool, releaseBindings } = createHostSessionBindings({
        options,
        input,
        lifecycle,
        makeInvocationId: () => requireInvocationId(makeInvocationId()),
        enqueueResponse,
    });
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
        if (isCancelMethod(frame.method)) {
            cancelHostRequest(requests, frame.id, highestRequestId);
            return;
        }
        highestRequestId = requireHostRequestAdmission(frame.id, frame.method, highestRequestId, requests);
        const controller = new AbortController();
        const request = registerActiveHostRequest(requests, frame.id, controller, frame.method);
        request.execution = runTimedHostRequest({
            frame,
            controller,
            timeoutMs: isAgentStreamMethod(frame.method) ? undefined : requestTimeoutMs(frame, timeouts),
            dispatch,
            fail,
            complete: request.complete,
        });
    }
    async function dispatch(frame, signal) {
        if (isAgentMethod(frame.method)) {
            const markDispatched = () => markHostRequestDispatched(requests, frame.id);
            return agent.handle({ ...frame, method: frame.method }, signal, markDispatched);
        }
        if (isToolMethod(frame.method)) {
            const markDispatched = () => markHostRequestDispatched(requests, frame.id);
            return tool.handle({ ...frame, method: frame.method }, signal, markDispatched);
        }
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
        await dispatchHostConnectorCall({
            id: frame.id,
            toolRef: callParams.toolRef,
            arguments: callParams.arguments,
            signal,
            refs,
            isPermitted: connectorSwitches.permits,
            gateway: options.gateway,
            pluginId: input.pluginId,
            processGeneration: input.processGeneration,
            makeInvocationId,
            admissionGate: () => lifecycle.gate(),
            markDispatched: () => markHostRequestDispatched(requests, frame.id),
            enqueueResponse,
            respond,
            respondError,
        });
    }
    async function list(id, signal) {
        try {
            const inventory = await listHostConnectorTools({
                gateway: options.gateway,
                session: input,
                signal,
                makeToolRef,
                previousRefs: refsByHandle,
                markDispatched: () => markHostRequestDispatched(requests, id),
            });
            ({ refs, refsByHandle } = inventory);
            const tools = connectorSwitches.visible(inventory.tools);
            await respond(id, { tools, partial: inventory.partial });
        }
        catch (error) {
            await respondError(id, normalizeGatewayError(error));
        }
    }
    const respond = (id, result) => enqueueResponse({ v: 1, id, ok: true, result });
    const respondError = (id, error) => enqueueResponse({ v: 1, id, ok: false, error });
    async function retire() {
        if (!lifecycle.beginRetirement())
            return;
        abortAgentRequests(requests);
        const pending = requestCompletions(requests);
        if (!(await settleWithin(Promise.allSettled(pending), timeouts.graceMs))) {
            publishResponses = false;
            for (const request of requests.values())
                request.controller.abort();
        }
        await settleWithin(Promise.allSettled([...requestCompletions(requests), writer.idle()]), timeouts.settleMs);
        lifecycle.markRetired();
        refs.clear();
        refsByHandle.clear();
        detach();
        releaseBindings();
    }
    function teardown() {
        publishResponses = false;
        for (const request of requests.values())
            request.controller.abort();
        refs.clear();
        refsByHandle.clear();
        detach();
        releaseBindings();
    }
    function fail(error) {
        if (fatalReported || lifecycle.isRetired())
            return;
        fatalReported = true;
        lifecycle.beginRetirement();
        teardown();
        retirePromise ??= retire();
        input.onFatal(error instanceof Error ? error : new HostConnectorProtocolError('Host Connector failed'));
    }
    return {
        startHandshake() {
            if (!lifecycle.isRetired())
                handshakeStarted = true;
        },
        activate() {
            lifecycle.activate();
            agent.activate();
        },
        beginQuiesce(quiesceInput) {
            const attempt = lifecycle.beginQuiesce({
                pending: dispatchedRequestCompletions(requests),
                deadlineMs: quiesceInput.deadlineMs,
                signal: quiesceInput.signal,
                // Agent turns are aborted only once the switch is final: a `busy` or resumed quiesce
                // leaves the old generation running, and its in-flight turns must survive that.
                commit: (forced) => {
                    abortAgentRequests(requests);
                    if (forced)
                        abortDispatchedRequests(requests);
                    refs.clear();
                    refsByHandle.clear();
                    releaseBindings();
                },
            });
            return attempt;
        },
        retire() {
            retirePromise ??= retire();
            return retirePromise;
        },
        close() {
            teardown();
            retirePromise ??= retire();
            return retirePromise;
        },
    };
}
/**
 * The `connector:<provider>` switches as one session applies them. A switched-off provider is
 * hidden from `list` but its refs stay valid: calls with them are refused until it is back on.
 */
function createConnectorSwitchView(switches, pluginId) {
    let providersByRef = new Map();
    const isOn = (provider) => switches?.isEnabled(pluginId, miniAppPermissionId('connector', provider)) ?? true;
    return {
        /** Records which provider each listed ref belongs to; returns the tools the user allows. */
        visible(tools) {
            providersByRef = new Map(tools.map(({ toolRef, provider }) => [toolRef, provider]));
            return tools.filter(({ provider }) => isOn(provider));
        },
        permits(toolRef) {
            const provider = providersByRef.get(toolRef);
            return provider === undefined || isOn(provider);
        },
    };
}
/** Agent and tool handlers sharing the session's lifecycle, identity and response queue. */
function createHostSessionBindings(binding) {
    const { options, input, lifecycle, makeInvocationId, enqueueResponse } = binding;
    const releaseGateway = createHostConnectorGatewayRelease(options.gateway, input);
    const agent = createHostAgentSession({
        gateway: options.agentGateway,
        identity: input,
        lifecycle,
        makeInvocationId,
        maxFrameBytes: RESPONSE_MAX_BYTES,
        enqueueResponse,
        ...(options.logger ? { logger: options.logger } : {}),
    });
    const tool = createHostToolSession({
        gateway: options.toolGateway,
        identity: input,
        lifecycle,
        makeInvocationId,
        maxFrameBytes: RESPONSE_MAX_BYTES,
        enqueueResponse,
    });
    return {
        agent,
        tool,
        releaseBindings: () => {
            releaseGateway();
            agent.release();
            tool.release();
        },
    };
}
async function dispatchHostConnectorCall(input) {
    const handle = input.refs.get(input.toolRef);
    if (!handle) {
        await input.respondError(input.id, staleToolWireError());
        return;
    }
    if (!input.isPermitted(input.toolRef)) {
        await input.respondError(input.id, notPermittedWireError());
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
        mcpToolMs: Math.max(1, options.mcpToolRequestTimeoutMs ?? 120_000),
    };
}
/**
 * `tool.call` / `tool.request` wait for the user's approval, so the tool gateway bounds each of
 * their phases itself; `tool.list` discovers MCP servers and gets the MCP bound.
 */
function requestTimeoutMs(frame, timeouts) {
    if (frame.method === 'tool.call' || frame.method === 'tool.request')
        return undefined;
    return frame.method === 'tool.list' ? timeouts.mcpToolMs : timeouts.requestMs;
}
async function runTimedHostRequest(input) {
    const timer = input.timeoutMs === undefined
        ? undefined
        : setTimeout(() => input.controller.abort(new HostConnectorRequestTimeoutError('Host Connector request timed out')), input.timeoutMs);
    timer?.unref();
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
        providerAllowlist: input.session.providers,
        caller: {
            kind: 'host-process',
            pluginId: input.session.pluginId,
            processGeneration: input.session.processGeneration,
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
function cancelHostRequest(requests, id, highestRequestId) {
    const request = requests.get(id);
    if (request) {
        request.controller.abort(new HostConnectorCancelledError('Request cancelled'));
    }
    else if (BigInt(id) > highestRequestId) {
        throw new HostConnectorProtocolError('Host Connector cancel id is unknown');
    }
}
function createHostResponseWriter(transport, shouldPublish) {
    let tail = Promise.resolve();
    return {
        enqueue(value) {
            const operation = writeHostResponse(tail, shouldPublish, transport, value);
            tail = ignoreFailure(operation);
            return operation;
        },
        idle: () => tail,
    };
}
async function writeHostResponse(previous, shouldPublish, transport, value) {
    await previous;
    if (!shouldPublish())
        return;
    await sendMiniAppIpcMessage(transport, encodeMiniAppIpcMessage('miniapp:connector', value, RESPONSE_MAX_BYTES));
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
    if (isCancelMethod(value.method) && hasExactKeys(value, ['v', 'id', 'method'])) {
        return { id: value.id, method: value.method };
    }
    if (!isParamsMethod(value.method) ||
        !hasExactKeys(value, ['v', 'id', 'method', 'params']) ||
        !isRecord(value.params)) {
        throw protocolParamsError();
    }
    return { id: value.id, method: value.method, params: value.params };
}
function isParamsMethod(value) {
    return (value === 'connector.list' ||
        value === 'connector.call' ||
        (typeof value === 'string' && (isAgentMethod(value) || isToolMethod(value))));
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
function protocolParamsError() {
    return new HostConnectorProtocolError('Host Connector request is invalid');
}
function requireInvocationId(value) {
    if (!isBoundedIdentifier(value)) {
        throw new HostConnectorProtocolError('Host Connector invocation id is invalid');
    }
    return value;
}
//# sourceMappingURL=host-connector.js.map