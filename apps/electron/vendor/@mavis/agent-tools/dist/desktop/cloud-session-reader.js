import { createHash } from 'node:crypto';
import { getDesktopMatrixEndpoint, isManagedMatrixBaseUrl } from './matrix-env.js';
export class CloudSessionReadError extends Error {
    status;
    key;
    constructor(status, key, message) {
        super(message);
        this.status = status;
        this.key = key;
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
        return {
            session: {
                sessionId: id,
                title: string(session.title),
                agentName: string(session.agent_name ?? session.agentName),
                parentSessionId: string(session.parent_session_id ?? session.parentSessionId),
                createdAt: number(session.created_at ?? session.createdAt),
                updatedAt: number(session.updated_at ?? session.updatedAt),
                archived: typeof session.archived === 'boolean' ? session.archived : undefined,
            },
        };
    }
    async getMessages(id, options = {}, signal) {
        const limit = options.limit ?? 20;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new CloudSessionReadError(400, 'INVALID_PAGE_SIZE', 'Cloud message limit must be between 1 and 100');
        }
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
    async read(id, suffix, query, signal) {
        if (!id.trim() || id === '.' || id === '..')
            throw new CloudSessionReadError(400, 'INVALID_SESSION_ID', 'A concrete cloud session ID is required');
        const endpoint = getDesktopMatrixEndpoint();
        // Never forward the managed login to an arbitrary MATRIX_BASE_URL override.
        if (!isManagedMatrixBaseUrl(endpoint.baseUrl))
            throw new CloudSessionReadError(400, 'UNSUPPORTED_CLOUD_ENDPOINT', 'Cloud session reads require a managed endpoint');
        const initial = this.options.authContextGetter();
        if (!initial?.accessToken?.trim() ||
            initial.authState === 'pending' ||
            initial.authState === 'logged_out') {
            throw new CloudSessionReadError(401, 'CLOUD_LOGIN_REQUIRED', 'Sign in to read cloud conversations');
        }
        const epoch = initial.loginEpoch;
        let token = initial.accessToken.trim();
        const ensureLogin = () => {
            const current = this.options.authContextGetter();
            if (!current ||
                current.authState === 'logged_out' ||
                current.authState === 'pending' ||
                (epoch ? current.loginEpoch !== epoch : current.accessToken?.trim() !== token)) {
                throw new CloudSessionReadError(401, 'CLOUD_LOGIN_CHANGED', 'Login changed while reading the conversation; retry with the current account');
            }
            return current;
        };
        const url = new URL(`/minimax-cloud/api/v1/session/${encodeURIComponent(id)}${suffix}`, endpoint.baseUrl);
        url.search = query?.toString() ?? '';
        url.searchParams.set('client', 'desktop');
        const routing = this.options.routingHeadersGetter?.() ?? {};
        const scopedSignal = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
            : AbortSignal.timeout(30_000);
        for (let attempt = 0; attempt < 2; attempt++) {
            ensureLogin();
            const second = String(Math.floor(Date.now() / 1000));
            let response;
            try {
                response = await (this.options.fetchImpl ?? globalThis.fetch)(url.toString(), {
                    method: 'GET',
                    redirect: 'error',
                    signal: scopedSignal,
                    headers: {
                        ...routing,
                        Authorization: `Bearer ${token}`,
                        'x-timestamp': second,
                        'x-signature': createHash('md5').update(`${second}I*7Cf%WZ#S&%1RlZJ&C2`).digest('hex'),
                    },
                });
            }
            catch {
                ensureLogin();
                throw new CloudSessionReadError(502, 'CLOUD_READ_UNAVAILABLE', 'Cloud conversation request failed or was cancelled');
            }
            if (response.status === 401 &&
                attempt === 0 &&
                epoch &&
                this.options.authContextInvalidator) {
                await response.body?.cancel();
                ensureLogin();
                const current = this.options.authContextGetter();
                if (current?.accessToken?.trim() === token) {
                    try {
                        await this.options.authContextInvalidator(token, epoch);
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
                await response.body?.cancel();
                throw new CloudSessionReadError(response.status, 'CLOUD_READ_FAILED', `Cloud conversation read failed (HTTP ${response.status})`);
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
                throw new CloudSessionReadError(502, 'CLOUD_READ_FAILED', `Cloud conversation read failed (code ${String(code)})`);
            return body;
        }
        throw new CloudSessionReadError(401, 'CLOUD_LOGIN_REQUIRED', 'Cloud login expired; sign in again');
    }
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
function invalidResponse() {
    return new CloudSessionReadError(502, 'INVALID_CLOUD_RESPONSE', 'Cloud conversation response is invalid');
}
//# sourceMappingURL=cloud-session-reader.js.map