/**
 * Channel Connection ↔ transport binding glue (compensation + logging).
 *
 * Migration copy (MR2): v1 `channels/channel-connection-binding.ts`, imports
 * remapped to v2 channel-system modules. Response construction stays byte-
 * compatible with the v1 connection routes.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { LocalImConnectionError } from '../../../binding/im-connection-types.js';
import { json, readFirstString } from '../http-helpers.js';
export function logConnectionBindingState(link, state, detail = {}) {
    const fields = {
        operation: 'binding',
        state,
        connectionId: link.connectionId,
        channel: link.channel,
        agentName: link.agentName,
        ...(detail.status !== undefined ? { status: detail.status } : {}),
        ...(detail.code ? { code: detail.code } : {}),
    };
    if (state === 'failed') {
        logger.warn(fields, 'Channel Connection binding failed');
        return;
    }
    logger.info(fields, 'Channel Connection binding state changed');
}
export async function resolveImConnectionLink(input, body, channel, resolveWriteAgent) {
    const connectionId = readFirstString(body, ['connectionId', 'connection_id']);
    if (!connectionId)
        return undefined;
    return resolveImConnectionId({
        input,
        connectionId,
        channel,
        requestedAgentName: readExplicitAgentName(body),
        resolveWriteAgent,
    });
}
export async function resolveImConnectionId(request) {
    const { input, connectionId, channel, requestedAgentName, resolveWriteAgent } = request;
    const store = input.infra.imConnectionStore;
    if (!store) {
        return connectionError(503, 'CHANNEL_CONNECTIONS_UNAVAILABLE', 'Channel Connections require the Local Runtime V2 Conversation composition.');
    }
    const connection = await store.getConnection(connectionId);
    if (!connection)
        return connectionError(404, 'CHANNEL_CONNECTION_NOT_FOUND', 'Channel Connection not found.');
    if (connection.channel !== channel) {
        return connectionError(409, 'CHANNEL_CONNECTION_CHANNEL_MISMATCH', 'Channel mismatch.');
    }
    if (requestedAgentName) {
        const resolvedAgentName = await resolveWriteAgent(input.infra, requestedAgentName, channel);
        if (resolvedAgentName !== connection.agentName) {
            return connectionError(409, 'CHANNEL_CONNECTION_AGENT_MISMATCH', 'The requested Agent does not match this Channel Connection.');
        }
    }
    return {
        connectionId: connection.connectionId,
        channel: connection.channel,
        agentName: connection.agentName,
        store,
    };
}
/**
 * Capture the adapter transport view before bind. Snapshotting is important:
 * adapters own this map and may mutate it in place during a successful bind.
 */
export async function captureConnectionBindingCompensation(api, link) {
    let before;
    try {
        before = snapshotTransportClients(await api.statusClients());
    }
    catch {
        throw compensationUnavailable('The Channel transport cannot be inspected for a safe rollback.');
    }
    return async (clientName) => {
        // A successful bind may refresh a pre-existing adapter record. Only tear
        // down a client that did not exist before this exact bind attempt; deleting
        // a stale or disabled pre-existing record would be an unsafe rollback.
        if (Object.hasOwn(before, clientName))
            return;
        let after;
        try {
            after = await api.statusClients();
        }
        catch {
            throw compensationUnavailable('The Channel transport cannot be inspected for a safe rollback.');
        }
        if (!Object.hasOwn(after, clientName) || !isLiveTransport(after[clientName])) {
            throw compensationUnavailable('The Channel transport identity cannot be verified for a safe rollback.', 502);
        }
        const response = await api.unbind(compensationUnbindRequest(link.channel, link.agentName));
        const payload = await readResponsePayload(response);
        if (!responseSucceeded(response, payload)) {
            throw new LocalImConnectionError(response.status || 502, 'CHANNEL_PLATFORM_COMPENSATION_FAILED', 'The Channel transport could not be rolled back after local persistence failed.');
        }
    };
}
export async function finishConnectionBinding(link, response, compensate) {
    const payload = await readResponsePayload(response);
    if (!responseSucceeded(response, payload)) {
        const code = responseCode(payload, 'CHANNEL_PLATFORM_BIND_FAILED');
        await link.store.markAuthorizationError(link.connectionId, link.channel, code);
        logConnectionBindingState(link, 'failed', { status: response.status, code });
        return responseWithConnectionId(response, payload, link.connectionId);
    }
    const clientName = readFirstString(payload ?? {}, ['clientId', 'client_id']);
    if (!clientName) {
        const code = 'CHANNEL_CLIENT_ID_MISSING';
        await link.store.markAuthorizationError(link.connectionId, link.channel, code);
        logConnectionBindingState(link, 'failed', { status: 502, code });
        return connectionError(502, code, 'The Channel bind response did not return a transport client identity.');
    }
    const persistenceError = await persistConnectionBinding(link, clientName, compensate);
    return persistenceError ?? responseWithConnectionId(response, payload, link.connectionId);
}
export async function finishWeChatStart(link, response, compensate) {
    const payload = await readResponsePayload(response);
    const status = readFirstString(payload ?? {}, ['status'])?.toLowerCase();
    if (!responseSucceeded(response, payload) || status === 'error') {
        const code = responseCode(payload, 'WECHAT_BIND_START_FAILED');
        await link.store.markAuthorizationError(link.connectionId, 'wechat', code);
        logConnectionBindingState(link, 'failed', { status: response.status, code });
        return responseWithConnectionId(response, payload, link.connectionId);
    }
    if (status === 'expired') {
        await link.store.expireAuthorization(link.connectionId);
        logConnectionBindingState(link, 'expired', {
            status: response.status,
            code: responseCode(payload, 'WECHAT_BIND_EXPIRED'),
        });
        return responseWithConnectionId(response, payload, link.connectionId);
    }
    if (status === 'confirmed' || payload?.connected === true) {
        return finishConnectionBinding(link, response, compensate);
    }
    const platformSessionId = readFirstString(payload ?? {}, ['sessionId', 'session_id']);
    if (!platformSessionId) {
        const code = 'WECHAT_BIND_SESSION_MISSING';
        await link.store.markAuthorizationError(link.connectionId, 'wechat', code);
        logConnectionBindingState(link, 'failed', { status: 502, code });
        return connectionError(502, code, 'WeChat bind start did not return a session.');
    }
    await link.store.beginAuthorization({
        connectionId: link.connectionId,
        channel: 'wechat',
        platformSessionId,
    });
    logConnectionBindingState(link, 'pending', { status: response.status });
    return responseWithConnectionId(response, payload, link.connectionId);
}
export async function readResponsePayload(response) {
    let body;
    try {
        body = await response.clone().json();
    }
    catch {
        // Non-JSON body (or an already-consumed stream) → no payload to merge.
        return undefined;
    }
    return body && typeof body === 'object' && !Array.isArray(body)
        ? body
        : undefined;
}
export function responseSucceeded(response, payload) {
    return response.ok && payload?.ok !== false && payload?.status !== 'error';
}
export function responseCode(payload, fallback) {
    return readFirstString(payload ?? {}, ['code']) ?? fallback;
}
export function responseWithConnectionId(response, payload, connectionId) {
    return payload ? json({ ...payload, connectionId }, { status: response.status }) : response;
}
export function connectionError(status, code, error) {
    return json({ ok: false, error, code, localRuntime: true }, { status });
}
export async function persistConnectionBinding(link, clientName, compensate) {
    try {
        await link.store.bind({ connectionId: link.connectionId, clientName });
        logConnectionBindingState(link, 'bound');
        return undefined;
    }
    catch (caught) {
        const persistenceError = caught instanceof LocalImConnectionError
            ? caught
            : new LocalImConnectionError(500, 'CHANNEL_CONNECTION_PERSIST_FAILED', 'The Channel binding could not be persisted locally.');
        await markAuthorizationErrorQuietly(link, persistenceError.code);
        if (compensate) {
            try {
                await compensate(clientName);
            }
            catch (caughtCompensation) {
                const error = caughtCompensation instanceof LocalImConnectionError
                    ? caughtCompensation
                    : new LocalImConnectionError(502, 'CHANNEL_PLATFORM_COMPENSATION_FAILED', 'The Channel transport could not be rolled back after local persistence failed.');
                await markAuthorizationErrorQuietly(link, error.code);
                logConnectionBindingState(link, 'failed', { status: error.status, code: error.code });
                return connectionError(error.status, error.code, error.message);
            }
        }
        logConnectionBindingState(link, 'failed', {
            status: persistenceError.status,
            code: persistenceError.code,
        });
        return connectionError(persistenceError.status, persistenceError.code, persistenceError.message);
    }
}
/**
 * Best-effort store annotation on an already-failing path: a second storage
 * failure must not mask the original error being reported to the caller.
 */
async function markAuthorizationErrorQuietly(link, code) {
    try {
        await link.store.markAuthorizationError(link.connectionId, link.channel, code);
    }
    catch {
        // Intentionally quiet — the caller is already returning the primary error.
    }
}
function readExplicitAgentName(body) {
    return readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']);
}
function snapshotTransportClients(clients) {
    return Object.fromEntries(Object.entries(clients).map(([clientName, status]) => [
        clientName,
        status && typeof status === 'object' && !Array.isArray(status)
            ? { ...status }
            : status,
    ]));
}
function isLiveTransport(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return record.pending !== true && record.connected !== false;
}
function compensationUnbindRequest(channel, agentName) {
    return new Request(`http://local-runtime.test/channel-bridge/${channel}/unbind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentName }),
    });
}
function compensationUnavailable(message, status = 503) {
    return new LocalImConnectionError(status, 'CHANNEL_PLATFORM_COMPENSATION_UNAVAILABLE', message);
}
//# sourceMappingURL=connection-binding.js.map