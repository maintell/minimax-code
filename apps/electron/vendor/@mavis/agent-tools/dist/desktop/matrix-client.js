import { getGlobalDispatcher, fetch as undiciFetch } from 'undici';
import { getDesktopMatrixEndpoint, isManagedMatrixBaseUrl, normalizeMatrixBaseUrl, } from './matrix-env.js';
const MATRIX_USER_AGENT = 'MiniMaxAgent';
const DEFAULT_TIMEOUT_MS = 120_000;
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;
const LONG_REQUEST_THRESHOLD_MS = UNDICI_DEFAULT_TIMEOUT_MS - 20_000;
const LONG_REQUEST_TIMEOUT_BUFFER_MS = 15_000;
const MATRIX_PROXY_PREFIX = '/matrix/api/v1/mcp/';
const LOCAL_GATEWAY_PREFIX = '/mavis/api/v1/mcp/';
export class DesktopGatewayHttpError extends Error {
    pathname;
    statusCode;
    errorCode;
    constructor(pathname, statusCode, errorCode, responsePreview = '') {
        // Preserve the pre-existing error text for every non-WebSearch caller.
        super(`Matrix backend ${pathname} HTTP ${statusCode}: ${responsePreview}`);
        this.pathname = pathname;
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.name = 'DesktopGatewayHttpError';
    }
}
export class DesktopMatrixClient {
    baseUrl;
    explicitAccessToken;
    managedEndpoint;
    useManagedAuth;
    authContext;
    timeoutMs;
    fetchImpl;
    dispatcherFactory;
    routingHeadersGetter;
    constructor(options = {}) {
        const endpoint = resolveEndpoint(options);
        const explicitAccessToken = options.accessToken?.trim() || endpoint.explicitToken;
        this.baseUrl = endpoint.baseUrl;
        this.explicitAccessToken = explicitAccessToken;
        this.managedEndpoint = endpoint.managed;
        this.useManagedAuth = endpoint.managed && !explicitAccessToken;
        this.authContext = options.authContext;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        // Keep Matrix on this package's fetch when Node bundles a different Undici version.
        this.fetchImpl = options.fetchImpl ?? undiciFetch;
        this.dispatcherFactory =
            options.dispatcherFactory ??
                ((timeouts) => getGlobalDispatcher().compose((dispatch) => (dispatchOptions, handler) => dispatch({ ...dispatchOptions, ...timeouts }, handler)));
        this.routingHeadersGetter = options.routingHeadersGetter;
    }
    async postJson(pathname, body, signal, options) {
        const response = await this.postGatewayJson(toLocalGatewayPath(pathname), body, signal, options?.timeoutMs);
        return normalizeMatrixToolResponse(response);
    }
    async postGatewayJson(pathname, body, signal, timeoutMs) {
        const requestTimeoutMs = timeoutMs ?? this.timeoutMs;
        const scoped = createScopedAbortSignal(signal, requestTimeoutMs);
        try {
            const init = {
                method: 'POST',
                headers: {
                    ...this.buildHeaders({ 'Content-Type': 'application/json' }),
                    ...(this.managedEndpoint ? (this.routingHeadersGetter?.() ?? {}) : {}),
                },
                body: JSON.stringify(body),
                signal: scoped.signal,
            };
            const dispatcher = buildLongRequestDispatcher(requestTimeoutMs, this.dispatcherFactory);
            if (dispatcher !== undefined) {
                setFetchDispatcher(init, dispatcher);
            }
            const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, init);
            const text = await res.text();
            if (!res.ok) {
                throw new DesktopGatewayHttpError(pathname, res.status, readGatewayErrorCode(text), text.slice(0, 500));
            }
            return text ? JSON.parse(text) : {};
        }
        finally {
            scoped.dispose();
        }
    }
    async putBytes(url, body, headers, signal, timeoutMs) {
        const scoped = createScopedAbortSignal(signal, timeoutMs ?? this.timeoutMs);
        try {
            const res = await this.fetchImpl(url, {
                method: 'PUT',
                body,
                headers,
                signal: scoped.signal,
                duplex: 'half',
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`Matrix upload PUT HTTP ${res.status}: ${text.slice(0, 500)}`);
            }
        }
        finally {
            scoped.dispose();
        }
    }
    async getStream(url, signal, timeoutMs) {
        const scoped = createScopedAbortSignal(signal, timeoutMs ?? this.timeoutMs);
        try {
            const res = await this.fetchImpl(url, {
                method: 'GET',
                signal: scoped.signal,
            });
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                throw new Error(`Matrix download HTTP ${res.status}: ${text.slice(0, 500)}`);
            }
            const contentLengthRaw = res.headers.get('content-length');
            const contentLength = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : undefined;
            return {
                body: res.body,
                dispose: scoped.dispose,
                ...(Number.isFinite(contentLength) && contentLength !== undefined ? { contentLength } : {}),
            };
        }
        catch (err) {
            scoped.dispose();
            throw err;
        }
    }
    buildHeaders(extraHeaders = {}) {
        const token = this.explicitAccessToken ?? this.getManagedAccessToken();
        if (!token) {
            throw new Error(this.useManagedAuth
                ? 'Matrix tools require a managed-login access token.'
                : 'Matrix tools require MATRIX_TOKEN for non-managed MATRIX_BASE_URL.');
        }
        return {
            'User-Agent': MATRIX_USER_AGENT,
            Authorization: `Bearer ${token}`,
            ...extraHeaders,
        };
    }
    getManagedAccessToken() {
        if (!this.useManagedAuth)
            return undefined;
        return this.authContext?.accessToken?.trim() || undefined;
    }
}
function readGatewayErrorCode(text) {
    if (!text)
        return undefined;
    try {
        const parsed = JSON.parse(text);
        return typeof parsed.error_code === 'string' ? parsed.error_code : undefined;
    }
    catch {
        return undefined;
    }
}
export function toLocalGatewayPath(pathname) {
    if (pathname.startsWith(MATRIX_PROXY_PREFIX)) {
        return `${LOCAL_GATEWAY_PREFIX}${pathname.slice(MATRIX_PROXY_PREFIX.length)}`;
    }
    if (pathname.startsWith(LOCAL_GATEWAY_PREFIX))
        return pathname;
    throw new Error(`Unsupported Matrix tool path: ${pathname}`);
}
function resolveEndpoint(options) {
    if (options.baseUrl) {
        return {
            baseUrl: normalizeMatrixBaseUrl(options.baseUrl),
            managed: isManagedMatrixBaseUrl(options.baseUrl),
        };
    }
    return options.endpoint ?? getDesktopMatrixEndpoint();
}
function normalizeMatrixToolResponse(response) {
    if (response.base_resp !== undefined)
        return response;
    const code = response.code;
    if (typeof code !== 'number')
        return response;
    const { code: _code, message, ...payload } = response;
    return {
        base_resp: {
            status_code: code,
            ...(typeof message === 'string' ? { status_msg: message } : {}),
        },
        ...payload,
    };
}
function createScopedAbortSignal(upstream, timeoutMs) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (upstream?.aborted)
        abort();
    upstream?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    return {
        signal: controller.signal,
        dispose() {
            clearTimeout(timer);
            upstream?.removeEventListener('abort', abort);
        },
    };
}
function buildLongRequestDispatcher(timeoutMs, dispatcherFactory) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < LONG_REQUEST_THRESHOLD_MS)
        return undefined;
    const relaxedTimeoutMs = timeoutMs + LONG_REQUEST_TIMEOUT_BUFFER_MS;
    return dispatcherFactory({
        headersTimeout: relaxedTimeoutMs,
        bodyTimeout: relaxedTimeoutMs,
    });
}
function setFetchDispatcher(init, dispatcher) {
    Object.assign(init, { dispatcher });
}
//# sourceMappingURL=matrix-client.js.map