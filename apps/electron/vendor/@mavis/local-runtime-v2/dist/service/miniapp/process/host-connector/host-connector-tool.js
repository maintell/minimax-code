import { ConnectorGatewayError } from '../../../host-connector-system/index.js';
import { MINIAPP_TOOL_ERROR_MESSAGES, MiniAppToolError, MINIAPP_TOOL_REQUEST_MAX_NAMES, } from '../../contracts.js';
import { raceWithSignal } from './host-connector-abort.js';
import { HostConnectorCancelledError, HostConnectorError, HostConnectorProtocolError, HostConnectorRequestTimeoutError, normalizeGatewayError, serviceRestartedWireError, } from './host-connector-errors.js';
import { hasExactKeys, isBoundedIdentifier, isMiniAppToolNameWithinLimit, isRecord, } from './host-connector-wire.js';
function toolWireError(code, options = {}) {
    return {
        code,
        message: MINIAPP_TOOL_ERROR_MESSAGES[code],
        disposition: options.disposition ?? 'not_dispatched',
        retryable: options.retryable ?? false,
        ...(options.invocationId ? { invocationId: options.invocationId } : {}),
    };
}
/** Child side: the same fixed shapes the Host would send, raised locally. */
export function toolClientError(code, options = {}) {
    const wire = toolWireError(code, options);
    return new HostConnectorError(wire.code, wire.message, wire.disposition, {
        retryable: wire.retryable,
        ...(wire.invocationId ? { invocationId: wire.invocationId } : {}),
    });
}
export function encodeToolRequestParams(names) {
    if (!isRequestNames(names))
        throw toolClientError('INVALID_ARGUMENTS');
    return { names: [...names] };
}
/** Child side: `approvalRequired` becomes the documented error, carrying the current state. */
export function toolRequestOutcome(value) {
    const result = value;
    if (!result.approvalRequired)
        return result.permissions;
    throw Object.assign(toolClientError('TOOL_APPROVAL_REQUIRED'), {
        permissions: result.permissions,
    });
}
function isRequestNames(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.length <= MINIAPP_TOOL_REQUEST_MAX_NAMES &&
        new Set(value).size === value.length &&
        value.every(isMiniAppToolNameWithinLimit));
}
const TOOL_VERDICTS = new Set(['allow', 'ask', 'deny']);
function isToolRequestResult(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['permissions', 'approvalRequired']) &&
        typeof value.approvalRequired === 'boolean' &&
        isRecord(value.permissions) &&
        Object.values(value.permissions).every((verdict) => TOOL_VERDICTS.has(verdict)));
}
export function encodeToolCallParams(name, arguments_) {
    if (!isMiniAppToolNameWithinLimit(name) || !isRecord(arguments_)) {
        throw toolClientError('INVALID_ARGUMENTS');
    }
    return { name, arguments: arguments_ };
}
/** Child side: shape check of a `tool.*` result; anything else is a protocol error. */
export function decodeToolResult(method, value) {
    if (method === 'tool.request') {
        if (isToolRequestResult(value))
            return value;
    }
    else if (method === 'tool.list') {
        if (isRecord(value) &&
            hasExactKeys(value, ['tools', 'partial']) &&
            Array.isArray(value.tools) &&
            value.tools.every(isListedTool) &&
            typeof value.partial === 'boolean') {
            return value;
        }
    }
    else if (isToolCallResult(value)) {
        return value;
    }
    throw new HostConnectorProtocolError('Mini App tool result is invalid');
}
const TOOL_OWNER_KEY = { connector: 'provider', mcp: 'server' };
function toolOwnerKey(value) {
    if (typeof value.kind !== 'string' || !Object.hasOwn(TOOL_OWNER_KEY, value.kind))
        return undefined;
    const owner = TOOL_OWNER_KEY[value.kind];
    return owner && typeof value[owner] === 'string' ? owner : undefined;
}
function isListedTool(value) {
    if (!isRecord(value))
        return false;
    const owner = toolOwnerKey(value);
    if (owner === undefined)
        return false;
    return (isMiniAppToolNameWithinLimit(value.name) &&
        typeof value.tool === 'string' &&
        TOOL_VERDICTS.has(value.permission) &&
        hasOptionalString(value, 'description') &&
        hasExactKeys(value, [
            'name',
            'kind',
            owner,
            'tool',
            'inputSchema',
            'permission',
            ...('description' in value ? ['description'] : []),
        ]));
}
function hasOptionalString(value, key) {
    return !(key in value) || typeof value[key] === 'string';
}
function isToolCallResult(value) {
    if (!isRecord(value) || !isBoundedIdentifier(value.invocationId))
        return false;
    if (value.kind === 'connector')
        return hasExactKeys(value, ['invocationId', 'kind', 'value']);
    return (value.kind === 'mcp' &&
        hasExactKeys(value, [
            'invocationId',
            'kind',
            'isError',
            'content',
            ...('structuredContent' in value ? ['structuredContent'] : []),
        ]) &&
        typeof value.isError === 'boolean' &&
        Array.isArray(value.content) &&
        (!('structuredContent' in value) || isRecord(value.structuredContent)));
}
/** Raised by the dispatch hook when the generation stopped admitting new work. */
class ToolDispatchGateClosedError extends Error {
    gate;
    name = 'ToolDispatchGateClosedError';
    constructor(gate) {
        super('Mini App tool dispatch gate is closed');
        this.gate = gate;
    }
}
/**
 * Host-side `tool.*` handling for one generation-bound connector session. `tool.call` follows the
 * `connector.call` lifecycle: refused before a receipt, admitted with an invocation id, drained by
 * a quiesce once dispatched, and never retried.
 */
export function createHostToolSession(input) {
    const { identity, lifecycle } = input;
    let session = input.gateway && identity.toolPolicy?.kind === 'allowlist'
        ? input.gateway.open({
            caller: { pluginId: identity.pluginId, processGeneration: identity.processGeneration },
        })
        : undefined;
    const respondError = (id, error) => input.enqueueResponse({ v: 1, id, ok: false, error });
    const gateError = (invocationId) => {
        const gate = lifecycle.gate();
        if (gate === 'service-restarted')
            return serviceRestartedWireError(invocationId);
        return gate === 'open' ? undefined : toolWireError('TOOL_UNAVAILABLE', { invocationId });
    };
    async function list(frame, active, signal, markDispatched) {
        if (!frame.params || !hasExactKeys(frame.params, []))
            throw protocolParamsError();
        const refusal = gateError();
        if (refusal)
            return respondError(frame.id, refusal);
        let dispatched = false;
        try {
            const inventory = await raceWithSignal(active.list({
                signal,
                onDispatch: () => {
                    dispatched = true;
                    markDispatched();
                },
            }), signal);
            return await respondBounded(frame.id, inventory, toolWireError('TOOL_RESULT_TOO_LARGE'));
        }
        catch (error) {
            return respondError(frame.id, hostToolWireError(error, signal, undefined, dispatched));
        }
    }
    async function call(frame, active, signal, markDispatched) {
        const refusal = gateError() ?? (lifecycle.isActive() ? undefined : toolWireError('TOOL_UNAVAILABLE'));
        if (refusal)
            return respondError(frame.id, refusal);
        const { params } = frame;
        const denied = active.admit(params.name);
        if (denied)
            return respondError(frame.id, projectToolError(denied));
        const invocationId = input.makeInvocationId();
        await input.enqueueResponse({ v: 1, id: frame.id, receipt: 'admitted', invocationId });
        const closed = gateError(invocationId);
        if (closed)
            return respondError(frame.id, closed);
        let dispatched = false;
        try {
            const result = await active.call({
                name: params.name,
                arguments: params.arguments,
                invocationId,
                clientRequestId: frame.id,
                signal,
                onDispatch: () => {
                    const gate = lifecycle.gate();
                    if (gate !== 'open')
                        throw new ToolDispatchGateClosedError(gate);
                    dispatched = true;
                    markDispatched();
                },
            });
            return await respondBounded(frame.id, { invocationId, ...result }, toolWireError('TOOL_RESULT_TOO_LARGE', {
                disposition: 'unknown_after_dispatch',
                invocationId,
            }));
        }
        catch (error) {
            return respondError(frame.id, hostToolWireError(error, signal, invocationId, dispatched));
        }
    }
    async function request(frame, active, signal) {
        const refusal = gateError();
        if (refusal)
            return respondError(frame.id, refusal);
        try {
            const result = await active.request({ names: frame.names, signal });
            return await respondBounded(frame.id, result, toolWireError('TOOL_RESULT_TOO_LARGE'));
        }
        catch (error) {
            return respondError(frame.id, hostToolWireError(error, signal, undefined, false));
        }
    }
    async function respondBounded(id, result, tooLarge) {
        const frame = { v: 1, id, ok: true, result };
        if (!fitsFrame(frame, input.maxFrameBytes))
            return respondError(id, tooLarge);
        return input.enqueueResponse(frame);
    }
    return {
        release() {
            const released = session;
            session = undefined;
            released?.release();
        },
        async handle(frame, signal, markDispatched) {
            // A malformed frame is a protocol error even when tools are not granted.
            const params = frame.method === 'tool.call' ? decodeCallParams(frame.params) : undefined;
            const names = frame.method === 'tool.request' ? decodeRequestNames(frame.params) : undefined;
            const active = session;
            if (!active) {
                await respondError(frame.id, toolWireError('TOOL_NOT_PERMITTED'));
                return;
            }
            if (params)
                await call({ id: frame.id, params }, active, signal, markDispatched);
            else if (names)
                await request({ id: frame.id, names }, active, signal);
            else
                await list(frame, active, signal, markDispatched);
        },
    };
}
function decodeCallParams(params) {
    if (!params ||
        !hasExactKeys(params, ['name', 'arguments']) ||
        !isMiniAppToolNameWithinLimit(params.name) ||
        !isRecord(params.arguments)) {
        throw protocolParamsError();
    }
    return { name: params.name, arguments: params.arguments };
}
/** Shape only; the gateway answers a bad name list with `INVALID_ARGUMENTS`. */
function decodeRequestNames(params) {
    if (!params || !hasExactKeys(params, ['names']) || !Array.isArray(params.names)) {
        throw protocolParamsError();
    }
    return params.names;
}
function projectToolError(error) {
    return toolWireError(error.code, { disposition: error.disposition, retryable: error.retryable });
}
/**
 * Host-side messages may carry internal detail; the child only gets fixed text. The code names the
 * cause; the disposition alone says whether the tool may have run.
 */
function hostToolWireError(error, signal, invocationId, dispatched) {
    const wire = typedToolWireError(error, invocationId, dispatched) ?? untypedToolWireError(dispatched);
    return withAbortCause(withInvocationId(wire, invocationId), signal);
}
/** Errors that carry their own dispatch verdict. */
function typedToolWireError(error, invocationId, dispatched) {
    if (error instanceof MiniAppToolError)
        return projectToolError(error);
    if (error instanceof ToolDispatchGateClosedError) {
        return error.gate === 'service-restarted'
            ? serviceRestartedWireError(invocationId)
            : toolWireError('TOOL_UNAVAILABLE');
    }
    if (!(error instanceof ConnectorGatewayError))
        return undefined;
    const normalized = normalizeGatewayError(error, invocationId, dispatched);
    return normalized.disposition === 'unknown_after_dispatch'
        ? toolWireError('TOOL_OUTCOME_UNKNOWN', { disposition: 'unknown_after_dispatch' })
        : normalized;
}
/** An abort reason or a Host failure without its own verdict. */
function untypedToolWireError(dispatched) {
    return dispatched
        ? toolWireError('TOOL_OUTCOME_UNKNOWN', { disposition: 'unknown_after_dispatch' })
        : toolWireError('TOOL_UNAVAILABLE', { retryable: true });
}
/**
 * A request aborted by its timeout or by `tool.cancel` reports that cause instead of a generic
 * unknown or unavailable outcome. Retrying is safe only when nothing was dispatched.
 */
function withAbortCause(wire, signal) {
    if (!signal.aborted || !ABORT_REPLACEABLE_CODES.has(wire.code))
        return wire;
    const cause = abortCause(signal.reason);
    if (!cause)
        return wire;
    const disposition = wire.disposition === 'not_dispatched' ? 'not_dispatched' : 'unknown_after_dispatch';
    return toolWireError(cause, {
        disposition,
        retryable: cause === 'TOOL_TIMEOUT' && disposition === 'not_dispatched',
        ...(wire.invocationId ? { invocationId: wire.invocationId } : {}),
    });
}
/** Codes that only say "aborted" or "unknown"; an abort cause is more precise. */
const ABORT_REPLACEABLE_CODES = new Set([
    'REQUEST_CANCELLED',
    'TOOL_OUTCOME_UNKNOWN',
    'TOOL_UNAVAILABLE',
]);
function abortCause(reason) {
    if (reason instanceof HostConnectorRequestTimeoutError)
        return 'TOOL_TIMEOUT';
    return reason instanceof HostConnectorCancelledError ? 'REQUEST_CANCELLED' : undefined;
}
function withInvocationId(wire, invocationId) {
    // The child pins the admitted identity; never echo a different one from the Gateway.
    return invocationId ? { ...wire, invocationId } : wire;
}
function fitsFrame(frame, maxBytes) {
    try {
        const json = JSON.stringify({ type: 'miniapp:connector', payload: frame });
        return json !== undefined && Buffer.byteLength(json) <= maxBytes;
    }
    catch {
        return false;
    }
}
function protocolParamsError() {
    return new HostConnectorProtocolError('Host Connector request is invalid');
}
//# sourceMappingURL=host-connector-tool.js.map