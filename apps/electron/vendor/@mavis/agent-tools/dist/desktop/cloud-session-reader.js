import { createHash } from 'node:crypto';
import { getDesktopMatrixEndpoint, isManagedMatrixBaseUrl } from './matrix-env.js';
export class CloudSessionReadError extends Error {
    status;
    key;
    upstreamCode;
    baseStatusCode;
    constructor(status, key, message, 
    /** String error code from the response body, e.g. a Remote Control `DEVICE_OFFLINE`. */
    upstreamCode, 
    /** `base_resp.status_code` of an HTTP 200 answer that failed, e.g. 404 for a missing session. */
    baseStatusCode) {
        super(message);
        this.status = status;
        this.key = key;
        this.upstreamCode = upstreamCode;
        this.baseStatusCode = baseStatusCode;
    }
}
/** Read-only cloud session access using the host's current managed login. */
export class CloudSessionReader {
    options;
    constructor(options) {
        this.options = options;
    }
    async getSession(id, signal) {
        const body = await this.read(id, '', undefined, signal);
        const session = record(body.session);
        if (session.session_id !== id && session.sessionId !== id)
            throw invalidResponse();
        return { session: toCloudSessionMetadata(id, session) };
    }
    /**
     * The name of the account's Mavis cloud agent, the agent the cloud app opens
     * by default. Cloud agents are addressed by a server-assigned name, not `mavis`.
     */
    async defaultAgentName(signal) {
        const body = await readManagedCloudJson(this.options, '/minimax-cloud/api/v1/agent', signal ? { signal } : {});
        const agents = body.agents ?? [];
        if (!Array.isArray(agents))
            throw invalidResponse();
        for (const value of agents) {
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;
            const agent = value;
            const name = string(agent.name);
            if (agent.agent_role === 'mavis' && name?.trim())
                return name;
        }
        throw new CloudSessionReadError(404, 'CLOUD_AGENT_NOT_FOUND', 'This account has no Mavis cloud agent; pass agent_name');
    }
    /**
     * One page of an agent's cloud sessions. The cursor is the server's opaque
     * `next_cursor`, passed back unchanged.
     */
    async listSessions(agentName, options = {}, signal) {
        const limit = pageSize(options.limit);
        if (options.cursor !== undefined && !options.cursor.trim())
            throw new CloudSessionReadError(400, 'INVALID_CURSOR', 'Cloud session cursor is invalid');
        if (!agentName.trim() || agentName === '.' || agentName === '..')
            throw new CloudSessionReadError(400, 'INVALID_AGENT_NAME', 'A cloud agent name is required');
        const query = new URLSearchParams({ limit: String(limit) });
        if (options.cursor)
            query.set('cursor', options.cursor);
        const body = await readManagedCloudJson(this.options, `/minimax-cloud/api/v1/agent/${encodeURIComponent(agentName)}/session`, { query, ...(signal ? { signal } : {}) });
        const raw = body.sessions ?? [];
        if (!Array.isArray(raw))
            throw invalidResponse();
        const sessions = raw.flatMap((value) => {
            const item = record(value);
            const sessionId = string(item.session_id ?? item.sessionId);
            return sessionId ? [toCloudSessionMetadata(sessionId, item)] : [];
        });
        const nextCursor = string(body.next_cursor ?? body.nextCursor)?.trim() || undefined;
        const declared = body.has_more ?? body.hasMore;
        // More pages are only reachable with a cursor to continue from.
        const hasMore = declared !== false && Boolean(nextCursor);
        return {
            sessions,
            hasMore,
            ...(hasMore && nextCursor ? { nextCursor } : {}),
        };
    }
    /**
     * Delivers one message to a cloud session as another session (CloudSendRemoteMessage).
     * The cloud answers `started` or `steered`; it ignores delivery and the idempotency key.
     */
    async sendRemoteMessage(send, signal) {
        if (!send.sessionId.trim() || send.sessionId === '.' || send.sessionId === '..')
            throw new CloudSessionReadError(400, 'INVALID_SESSION_ID', 'A concrete cloud session ID is required');
        const body = await readManagedCloudJson(this.options, `/minimax-cloud/api/v1/session/${encodeURIComponent(send.sessionId)}/remote-message`, { method: 'POST', body: remoteMessageBody(send), ...(signal ? { signal } : {}) });
        return readRemoteMessageResult(body);
    }
    async getMessages(id, options = {}, signal) {
        const limit = pageSize(options.limit);
        const query = new URLSearchParams({
            limit: String(limit),
            include_attachment_read_urls: 'false',
        });
        if (options.before)
            query.set('before', options.before);
        const body = await this.read(id, '/message', query, signal);
        const rawMessages = body.messages ?? ((body.has_more ?? body.hasMore) === false ? [] : undefined);
        if (!Array.isArray(rawMessages))
            throw invalidResponse();
        const messages = rawMessages.map((value) => {
            const item = record(value);
            const msgId = string(item.msg_id ?? item.msgId);
            if (!msgId)
                throw invalidResponse();
            return {
                msgId,
                parentMsgId: string(item.parent_msg_id ?? item.parentMsgId),
                turnId: string(item.turn_id ?? item.turnId),
                role: string(item.role),
                timestamp: number(item.timestamp),
                msgContent: string(item.msg_content ?? item.msgContent),
                msgType: number(item.msg_type ?? item.msgType),
                finishReason: string(item.finish_reason ?? item.finishReason),
                toolCalls: toolCalls(item.tool_calls ?? item.toolCalls),
            };
        });
        const nextCursor = string(body.next_cursor ?? body.nextCursor);
        const hasMore = body.has_more ?? body.hasMore;
        if (hasMore !== undefined && typeof hasMore !== 'boolean')
            throw invalidResponse();
        if (hasMore === true && !nextCursor)
            throw invalidResponse();
        return {
            messages,
            nextCursor,
            hasMore: hasMore ?? Boolean(nextCursor),
            lastMsgId: messages.at(-1)?.msgId,
        };
    }
    read(id, suffix, query, signal) {
        if (!id.trim() || id === '.' || id === '..')
            throw new CloudSessionReadError(400, 'INVALID_SESSION_ID', 'A concrete cloud session ID is required');
        return readManagedCloudJson(this.options, `/minimax-cloud/api/v1/session/${encodeURIComponent(id)}${suffix}`, { ...(query ? { query } : {}), ...(signal ? { signal } : {}) });
    }
}
/**
 * SendRemoteMessage JSON body; the target session travels in the path. The SSH
 * route is built separately in Electron Main, which validates and constructs the
 * whole request itself as its trust boundary; `remote-session-broker.test.ts` holds
 * that builder to this field set.
 */
export function remoteMessageBody(send) {
    const sender = send.sender;
    return {
        content: send.content,
        sender: {
            session_id: sender.sessionId,
            ...(sender.deviceName ? { device_name: sender.deviceName } : {}),
            ...(sender.agentName ? { agent_name: sender.agentName } : {}),
            ...(sender.title ? { title: sender.title } : {}),
        },
        ...(send.delivery ? { delivery: send.delivery } : {}),
        ...(send.idempotencyKey ? { idempotency_key: send.idempotencyKey } : {}),
    };
}
export function readRemoteMessageResult(body) {
    const mode = string(body.mode);
    const turnId = string(body.turn_id ?? body.turnId);
    const queueItemId = string(body.queue_item_id ?? body.queueItemId);
    return {
        ...(mode ? { mode } : {}),
        ...(turnId ? { turnId } : {}),
        ...(queueItemId ? { queueItemId } : {}),
    };
}
/**
 * One request against the managed cloud API with the host's current login:
 * Bearer token, request signature and routing headers, one refresh within the
 * same login, and no result once the account changes. `headers` adds request
 * routing such as Remote Control binding headers. GET by default; a POST
 * sends `body` as JSON and is retried only after a 401, which the server
 * answers before handling the request.
 */
export async function readManagedCloudJson(options, pathname, init = {}) {
    const endpoint = getDesktopMatrixEndpoint();
    // Never forward the managed login to an arbitrary MATRIX_BASE_URL override.
    if (!isManagedMatrixBaseUrl(endpoint.baseUrl))
        throw new CloudSessionReadError(400, 'UNSUPPORTED_CLOUD_ENDPOINT', 'Cloud session reads require a managed endpoint');
    const initial = options.authContextGetter();
    if (!initial?.accessToken?.trim() ||
        initial.authState === 'pending' ||
        initial.authState === 'logged_out') {
        throw new CloudSessionReadError(401, 'CLOUD_LOGIN_REQUIRED', 'Sign in to read cloud conversations');
    }
    const epoch = initial.loginEpoch;
    let token = initial.accessToken.trim();
    const ensureLogin = () => {
        const current = options.authContextGetter();
        if (!current ||
            current.authState === 'logged_out' ||
            current.authState === 'pending' ||
            (epoch ? current.loginEpoch !== epoch : current.accessToken?.trim() !== token)) {
            throw new CloudSessionReadError(401, 'CLOUD_LOGIN_CHANGED', 'Login changed while reading the conversation; retry with the current account');
        }
        return current;
    };
    const url = new URL(pathname, endpoint.baseUrl);
    url.search = init.query?.toString() ?? '';
    url.searchParams.set('client', 'desktop');
    const routing = options.routingHeadersGetter?.() ?? {};
    const scopedSignal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000);
    for (let attempt = 0; attempt < 2; attempt++) {
        ensureLogin();
        const second = String(Math.floor(Date.now() / 1000));
        let response;
        try {
            response = await (options.fetchImpl ?? globalThis.fetch)(url.toString(), {
                method: init.method ?? 'GET',
                redirect: 'error',
                signal: scopedSignal,
                headers: {
                    ...routing,
                    ...init.headers,
                    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                    Authorization: `Bearer ${token}`,
                    'x-timestamp': second,
                    'x-signature': createHash('md5').update(`${second}I*7Cf%WZ#S&%1RlZJ&C2`).digest('hex'),
                },
                ...(init.body ? { body: JSON.stringify(init.body) } : {}),
            });
        }
        catch {
            ensureLogin();
            throw new CloudSessionReadError(502, 'CLOUD_READ_UNAVAILABLE', 'Cloud conversation request failed or was cancelled');
        }
        if (response.status === 401 && attempt === 0 && epoch && options.authContextInvalidator) {
            await response.body?.cancel();
            ensureLogin();
            // A read cancelled meanwhile, e.g. a probe stopped by another device's
            // login failure, must not start its own refresh.
            if (init.signal?.aborted)
                throw new CloudSessionReadError(502, 'CLOUD_READ_UNAVAILABLE', 'Cloud conversation request failed or was cancelled');
            const current = options.authContextGetter();
            if (current?.accessToken?.trim() === token) {
                try {
                    await refreshOnce(options.authContextInvalidator, token, epoch);
                }
                catch {
                    ensureLogin();
                    throw new CloudSessionReadError(401, 'CLOUD_LOGIN_REQUIRED', 'Cloud login could not be refreshed; sign in again');
                }
            }
            const refreshed = ensureLogin().accessToken?.trim();
            if (!refreshed || refreshed === token)
                throw new CloudSessionReadError(401, 'CLOUD_LOGIN_REQUIRED', 'Cloud login expired; sign in again');
            token = refreshed;
            continue;
        }
        ensureLogin();
        if (!response.ok) {
            const upstreamCode = await readErrorCode(response);
            ensureLogin();
            throw new CloudSessionReadError(response.status, 'CLOUD_READ_FAILED', `Cloud conversation read failed (HTTP ${response.status})`, upstreamCode);
        }
        let body;
        try {
            body = record(await response.json());
        }
        catch {
            ensureLogin();
            throw invalidResponse();
        }
        ensureLogin();
        const base = record(body.base_resp ?? body.baseResp ?? {});
        const code = base.status_code ?? base.statusCode;
        if (code !== undefined && code !== 0)
            throw new CloudSessionReadError(502, 'CLOUD_READ_FAILED', `Cloud conversation read failed (code ${String(code)})`, string(body.code), typeof code === 'number' ? code : undefined);
        return body;
    }
    throw new CloudSessionReadError(401, 'CLOUD_LOGIN_REQUIRED', 'Cloud login expired; sign in again');
}
const pendingRefreshes = new WeakMap();
/** One refresh per rejected token: parallel reads rejected with the same token share it. */
function refreshOnce(invalidator, token, epoch) {
    let byToken = pendingRefreshes.get(invalidator);
    if (!byToken)
        pendingRefreshes.set(invalidator, (byToken = new Map()));
    const refreshes = byToken;
    const key = `${epoch}\u0000${token}`;
    const pending = refreshes.get(key);
    if (pending)
        return pending;
    const started = Promise.resolve()
        .then(() => invalidator(token, epoch))
        .finally(() => refreshes.delete(key));
    refreshes.set(key, started);
    return started;
}
/** The upstream string code (`code` or `key`) of an error body; the body itself is never surfaced. */
async function readErrorCode(response) {
    try {
        const body = await response.json();
        if (!body || typeof body !== 'object' || Array.isArray(body))
            return undefined;
        const value = body;
        const nested = value.error && typeof value.error === 'object' ? value.error : undefined;
        return (string(value.code) ??
            string(value.key) ??
            string(nested?.code));
    }
    catch {
        return undefined;
    }
}
function toCloudSessionMetadata(sessionId, session) {
    return {
        sessionId,
        title: string(session.title),
        agentName: string(session.agent_name ?? session.agentName),
        parentSessionId: string(session.parent_session_id ?? session.parentSessionId),
        createdAt: number(session.created_at ?? session.createdAt),
        updatedAt: number(session.updated_at ?? session.updatedAt),
        archived: typeof session.archived === 'boolean' ? session.archived : undefined,
        status: sessionStatus(session.status),
    };
}
const SESSION_STATUS_TYPES = ['idle', 'started', 'error', 'aborted'];
/** archon_biz SessionStatusInfo `{type: 0..3, message}`; the numbering matches local sessions. */
function sessionStatus(value) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : { type: value };
    const fields = raw;
    const code = fields.type ?? fields.status_type ?? fields.statusType;
    const type = typeof code === 'number' ? SESSION_STATUS_TYPES[code] : undefined;
    if (!type)
        return undefined;
    const message = string(fields.message);
    return message ? { type, message } : { type };
}
/** Cloud pages default to 20 and are capped at 100, for messages and sessions alike. */
function pageSize(value) {
    const limit = value ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new CloudSessionReadError(400, 'INVALID_PAGE_SIZE', 'Cloud message limit must be between 1 and 100');
    }
    return limit;
}
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw invalidResponse();
    return value;
}
function string(value) {
    return typeof value === 'string' ? value : undefined;
}
function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** SessionToolCallView rows; a row without a name or ID is skipped, not a failed read. */
function toolCalls(value) {
    if (!Array.isArray(value))
        return undefined;
    const calls = value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return [];
        const item = entry;
        const toolName = string(item.tool_name ?? item.toolName);
        const toolCallId = string(item.tool_call_id ?? item.toolCallId);
        if (!toolName || !toolCallId)
            return [];
        const status = number(item.tool_call_status ?? item.toolCallStatus);
        const args = string(item.tool_call_args ?? item.toolCallArgs);
        const result = string(item.tool_call_result_data ?? item.toolCallResultData);
        return [
            {
                toolName,
                toolCallId,
                ...(status !== undefined ? { toolCallStatus: status } : {}),
                ...(args !== undefined ? { toolCallArgs: args } : {}),
                ...(result !== undefined ? { toolCallResultData: result } : {}),
            },
        ];
    });
    return calls.length ? calls : undefined;
}
function invalidResponse() {
    return new CloudSessionReadError(502, 'INVALID_CLOUD_RESPONSE', 'Cloud conversation response is invalid');
}
//# sourceMappingURL=cloud-session-reader.js.map