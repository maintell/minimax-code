/**
 * HTTP 代理 IPC 处理
 * 通过主进程代理 HTTP 请求，绕过 CORS 限制
 *
 * 重要：使用 Electron 的 net.fetch 而不是 Node.js 的 fetch
 * net.fetch 会使用 Chromium 的网络栈，自动遵循系统代理设置
 * 这对于使用 VPN 的用户非常重要，确保请求能正确路由到海外服务器
 */
import { ipcMain, net } from "electron";
import { getCategoryLogger } from "../utils/logger";
import { getStandardUserAgent } from "../utils/tool";
import { DOMAIN_URL, OPEN_PLATFORM_API_ORIGIN, IPC_CHANNELS } from "../config/constants";
import { isProd, isEn, isTest, isStaging, isDev } from "../config/env";
import { getDesktopConfig } from "./storage.ipc";
import { assertSameLoginEpoch, requiresInteractiveLogin } from "@mavis/oauth-core";
const logger = getCategoryLogger('api');
// 打印完整的 URL params，但排除敏感字段
const SENSITIVE_PARAM_NAMES = new Set([
    'apikey',
    'authorization',
    'code',
    'cookie',
    'password',
    'passwd',
    'secret',
    'signature',
    'ticket',
    'token',
]);
const SENSITIVE_HEADERS = new Set([
    'authorization',
    'cookie',
    'proxy-authorization',
    'set-cookie',
    'token',
    'x-auth-token',
    'x-api-key',
    'x-minimax-agent-preview-secret',
    'x-signature',
]);
const REDACTED_HEADER_VALUE = '[REDACTED]';
const BLOCKED_RENDERER_CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'cookie']);
const SHARED_AUTH_PATH_PREFIXES = [
    '/mavis/api',
    '/v1/api',
    '/matrix/api',
    '/minimax-cloud/api',
    '/backend',
    '/account',
];
// 生产环境按区域扩大可信 Origin；下方路径前缀仍负责限定原先携带 SSO token 的 API。
// 例如 agent-storage 的签名对象 URL 不命中这些前缀，因此不会附带 OAuth Bearer。
const DOMESTIC_SHARED_AUTH_ORIGINS = [
    'https://agent-storage.minimax.cn',
    'https://agent-stream.minimax.cn',
    'https://agent.minimax.cn',
];
const OVERSEAS_SHARED_AUTH_ORIGINS = [
    'https://agent-storage.minimax.io',
    'https://agent-stream.minimax.io',
    'https://agent.minimax.io',
];
const SHARED_AUTH_ORIGINS = new Set([
    new URL(DOMAIN_URL).origin,
    new URL(OPEN_PLATFORM_API_ORIGIN).origin,
    ...(isProd ? (isEn ? OVERSEAS_SHARED_AUTH_ORIGINS : DOMESTIC_SHARED_AUTH_ORIGINS) : []),
]);
function redactHeaders(headers) {
    if (!headers)
        return undefined;
    return Object.fromEntries(Object.entries(headers).map(([key, value]) => {
        const normalizedKey = key.toLowerCase();
        const sensitive = SENSITIVE_HEADERS.has(normalizedKey) ||
            normalizedKey.endsWith('-token') ||
            normalizedKey.endsWith('-secret') ||
            normalizedKey.endsWith('-signature');
        return [key, sensitive ? REDACTED_HEADER_VALUE : value];
    }));
}
function isSensitiveParamName(key) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    return (SENSITIVE_PARAM_NAMES.has(normalizedKey) ||
        normalizedKey.endsWith('apikey') ||
        normalizedKey.endsWith('secret') ||
        normalizedKey.endsWith('signature') ||
        normalizedKey.endsWith('ticket') ||
        normalizedKey.endsWith('token'));
}
function describeLogBody(value) {
    if (value === undefined || value === null || value === '')
        return undefined;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed)
                ? `[JSON array ${value.length} chars]`
                : `[JSON ${value.length} chars]`;
        }
        catch {
            return `[Text ${value.length} chars]`;
        }
    }
    if (Array.isArray(value))
        return `[JSON array ${value.length} items]`;
    if (typeof value === 'object')
        return '[JSON object]';
    return `[${typeof value}]`;
}
const streamControllers = new Map();
function unknownErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function responseHeaders(response) {
    const headers = {};
    response.headers.forEach((value, key) => {
        headers[key] = value;
    });
    return headers;
}
function setupProxyFetchDebugEmitter(options) {
    if (!options)
        return undefined;
    const debugOptions = options;
    const subscribers = new Map();
    const destroyHookedSenders = new WeakSet();
    let nextRequestId = 0;
    function debugEnabled() {
        try {
            return debugOptions.isEnabled();
        }
        catch {
            return false;
        }
    }
    function subscribe(sender) {
        try {
            if (!debugEnabled() || sender.isDestroyed())
                return;
            if (subscribers.has(sender.id))
                return;
            if (!destroyHookedSenders.has(sender)) {
                const senderId = sender.id;
                sender.once('destroyed', () => subscribers.delete(senderId));
                destroyHookedSenders.add(sender);
            }
            subscribers.set(sender.id, sender);
        }
        catch {
            // Debug subscription is best-effort and must not affect IPC setup.
        }
    }
    ipcMain.on(IPC_CHANNELS.PROXY_FETCH_DEBUG_SUBSCRIBE, (event) => subscribe(event.sender));
    ipcMain.on(IPC_CHANNELS.PROXY_FETCH_DEBUG_UNSUBSCRIBE, (event) => {
        subscribers.delete(event.sender.id);
    });
    function canEmit(sender) {
        if (!debugEnabled()) {
            subscribers.delete(sender.id);
            return false;
        }
        try {
            return subscribers.get(sender.id) === sender && !sender.isDestroyed();
        }
        catch {
            subscribers.delete(sender.id);
            return false;
        }
    }
    function emit(sender, event) {
        if (!canEmit(sender))
            return;
        try {
            sender.send(IPC_CHANNELS.PROXY_FETCH_DEBUG_EVENT, event);
        }
        catch {
            // Debug delivery must never enter the proxy request control path.
            subscribers.delete(sender.id);
        }
    }
    return {
        start(sender, request) {
            try {
                if (!canEmit(sender))
                    return undefined;
                const id = `electron-proxy:${sender.id}:${Date.now().toString(36)}:${(++nextRequestId).toString(36)}`;
                let terminal = false;
                let responseSequence = 0;
                emit(sender, {
                    type: 'request-start',
                    id,
                    source: 'electron-proxy',
                    method: request.method,
                    url: request.url,
                    headers: { ...request.headers },
                    ...(request.body !== undefined ? { body: request.body } : {}),
                    requestKind: request.requestKind,
                    timestampMs: Date.now(),
                });
                const responseChunk = (payload) => {
                    if (terminal)
                        return;
                    responseSequence += 1;
                    emit(sender, {
                        type: 'response-chunk',
                        id,
                        seq: responseSequence,
                        payload,
                        timestampMs: Date.now(),
                    });
                };
                const finishWithError = (reasonCode, phase, message) => {
                    if (terminal)
                        return;
                    terminal = true;
                    emit(sender, {
                        type: 'transport-error',
                        id,
                        reasonCode,
                        phase,
                        requestKind: request.requestKind,
                        ...(message ? { message } : {}),
                        timestampMs: Date.now(),
                    });
                };
                return {
                    responseStart(response) {
                        if (terminal)
                            return;
                        try {
                            emit(sender, {
                                type: 'response-start',
                                id,
                                status: response.status,
                                statusText: response.statusText,
                                headers: responseHeaders(response),
                                timestampMs: Date.now(),
                            });
                        }
                        catch {
                            // Response metadata is optional debug information.
                        }
                    },
                    responseChunk,
                    responseData(data, responseType) {
                        if (terminal || data === undefined || data === null)
                            return;
                        try {
                            if ((responseType === 'arraybuffer' ||
                                responseType === 'blob' ||
                                responseType === 'stream') &&
                                typeof data === 'string') {
                                responseChunk(new Uint8Array(Buffer.from(data, 'base64')));
                                return;
                            }
                            responseChunk(typeof data === 'string' ? data : JSON.stringify(data));
                        }
                        catch {
                            // Body preview is optional; status and lifecycle remain available.
                        }
                    },
                    complete() {
                        if (terminal)
                            return;
                        terminal = true;
                        emit(sender, { type: 'response-complete', id, timestampMs: Date.now() });
                    },
                    abort() {
                        if (terminal)
                            return;
                        terminal = true;
                        emit(sender, {
                            type: 'request-abort',
                            id,
                            reason: 'client_aborted',
                            timestampMs: Date.now(),
                        });
                    },
                    error: finishWithError,
                };
            }
            catch {
                return undefined;
            }
        },
    };
}
async function performProxyNetFetch(sender, debugEmitter, input) {
    const debugAttempt = sender && debugEmitter
        ? debugEmitter.start(sender, {
            url: input.url,
            method: input.method,
            headers: input.headers,
            ...(input.body !== undefined ? { body: input.body } : {}),
            requestKind: input.requestKind,
        })
        : undefined;
    try {
        const response = await net.fetch(input.url, {
            method: input.method,
            signal: input.signal,
            headers: { ...input.headers },
            ...(input.body !== undefined ? { body: input.body } : {}),
        });
        debugAttempt?.responseStart(response);
        return { response, ...(debugAttempt ? { debugAttempt } : {}) };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            debugAttempt?.abort();
        }
        else {
            debugAttempt?.error('net_fetch_failed', 'request', unknownErrorMessage(error));
        }
        throw error;
    }
}
async function drainDiscardedProxyResponse(response, debugAttempt) {
    const discardedBody = await response.arrayBuffer().catch((error) => {
        try {
            debugAttempt?.error('response_body_read_failed', 'response', unknownErrorMessage(error));
        }
        catch {
            // Debug observation must not change the existing best-effort drain.
        }
        return undefined;
    });
    try {
        if (discardedBody?.byteLength) {
            debugAttempt?.responseChunk(new Uint8Array(discardedBody));
        }
        debugAttempt?.complete();
    }
    catch {
        // Debug observation must not change retry behavior.
    }
}
function sendStreamEvent(sender, event) {
    if (!sender.isDestroyed())
        sender.send(IPC_CHANNELS.PROXY_STREAM_EVENT, event);
}
function buildRequestHeaders(urlObj, headers) {
    const requestHeaders = {
        'User-Agent': getStandardUserAgent(),
        Origin: urlObj.origin,
        Referer: `${urlObj.origin}/`,
        ...headers,
    };
    const desktopConfig = getDesktopConfig();
    const swimLane = resolveProxySwimLane(isTest || isStaging || isDev, desktopConfig.swimLaneName);
    if (swimLane) {
        requestHeaders['lane'] = swimLane;
        requestHeaders['bedrock_lane'] = swimLane;
        requestHeaders['bedrock-lane'] = swimLane;
    }
    return requestHeaders;
}
export function resolveProxySwimLane(nonProduction, configuredLane) {
    if (!nonProduction)
        return undefined;
    if (typeof configuredLane !== 'string')
        return undefined;
    const normalized = configuredLane.trim();
    return normalized || undefined;
}
function normalizeMaxResponseBytes(value) {
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError('maxResponseBytes must be a non-negative safe integer');
    }
    return value;
}
function getAnnouncedResponseBytes(response) {
    const rawContentLength = response.headers.get('content-length')?.trim();
    if (!rawContentLength || !/^\d+$/.test(rawContentLength))
        return undefined;
    const contentLength = Number(rawContentLength);
    return Number.isSafeInteger(contentLength) ? contentLength : undefined;
}
function responseSizeLimitError(maxResponseBytes) {
    return new Error(`Response exceeds maxResponseBytes (${maxResponseBytes} bytes)`);
}
async function readBinaryResponse(response, requestedMaxResponseBytes) {
    const maxResponseBytes = normalizeMaxResponseBytes(requestedMaxResponseBytes);
    const announcedResponseBytes = getAnnouncedResponseBytes(response);
    if (maxResponseBytes !== undefined &&
        announcedResponseBytes !== undefined &&
        announcedResponseBytes > maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw responseSizeLimitError(maxResponseBytes);
    }
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (!value)
                continue;
            const nextTotalBytes = totalBytes + value.byteLength;
            if (!Number.isSafeInteger(nextTotalBytes)) {
                await reader.cancel().catch(() => undefined);
                throw new Error('Response size exceeds the safe integer range');
            }
            if (maxResponseBytes !== undefined && nextTotalBytes > maxResponseBytes) {
                await reader.cancel().catch(() => undefined);
                throw responseSizeLimitError(maxResponseBytes);
            }
            chunks.push(Buffer.from(value));
            totalBytes = nextTotalBytes;
        }
    }
    finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks, totalBytes).toString('base64');
}
const NEED_LOGIN_ERROR_CODE = 1000048;
let activeProxySetupOptions = null;
function isSharedAuthRequest(url) {
    if (!SHARED_AUTH_ORIGINS.has(url.origin))
        return false;
    return SHARED_AUTH_PATH_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}
function asRecord(value) {
    return value !== null && typeof value === 'object'
        ? value
        : undefined;
}
function asDiagnosticScalar(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : undefined;
}
function getResponseDiagnostics(data, headers) {
    const responseData = asRecord(data);
    const baseResp = asRecord(responseData?.base_resp);
    const bodyTraceId = asDiagnosticScalar(responseData?.trace_id ?? responseData?.traceId);
    const traceId = headers['x-trace-id'] ??
        headers['x-request-id'] ??
        headers['trace-id'] ??
        (bodyTraceId === undefined ? undefined : String(bodyTraceId));
    return {
        baseRespStatusCode: asDiagnosticScalar(baseResp?.status_code),
        baseRespStatusMessage: asDiagnosticScalar(baseResp?.status_msg),
        traceId,
    };
}
function sanitizeRendererHeaders(headers, sharedMode) {
    const sanitized = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
        const normalizedKey = key.toLowerCase();
        // During the SSO-to-OAuth migration, trusted resource APIs may receive both
        // the legacy SSO token header and the Main-owned OAuth Bearer. The backend
        // remains authoritative about which credential applies.
        if (sharedMode && normalizedKey === 'token') {
            if (value.trim())
                sanitized[key] = value;
            continue;
        }
        if (sharedMode && BLOCKED_RENDERER_CREDENTIAL_HEADER_NAMES.has(normalizedKey)) {
            if (value.trim()) {
                throw new Error('Renderer-provided credential headers are not allowed in shared mode.');
            }
            continue;
        }
        sanitized[key] = value;
    }
    return sanitized;
}
function assertNoRendererCredentialQuery(url, sharedMode) {
    if (!sharedMode)
        return;
    for (const key of url.searchParams.keys()) {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
        if (normalized === 'authorization' ||
            normalized === 'cookie' ||
            normalized.endsWith('token') ||
            normalized.endsWith('credential') ||
            normalized.endsWith('secret')) {
            throw new Error('Renderer-provided credential query parameters are not allowed in shared mode.');
        }
    }
}
function deleteRequestHeader(headers, headerName) {
    let deleted = false;
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== headerName)
            continue;
        delete headers[key];
        deleted = true;
    }
    return deleted;
}
async function isSharedAuthRejection(response, responseType) {
    if (response.status === 401)
        return true;
    if ((responseType !== 'json' && responseType !== 'text') ||
        !response.headers.get('content-type')?.includes('application/json'))
        return false;
    // Renderer fetch uses text mode for JSON; inspect both buffered modes.
    const body = asRecord(await response
        .clone()
        .json()
        .catch(() => undefined));
    return asRecord(body?.statusInfo)?.code === NEED_LOGIN_ERROR_CODE;
}
async function fetchProxyResponse(url, urlObj, requestHeaders, fetchInput, setupOptions, debugContext, responseType = 'json') {
    const useSharedAuth = Boolean(setupOptions.sharedAuthSession) && isSharedAuthRequest(urlObj);
    let accessTokenLease;
    let debugAttempt;
    const markAttemptFailure = (error) => {
        if (error instanceof Error && error.name === 'AbortError') {
            debugAttempt?.abort();
            return;
        }
        debugAttempt?.error('proxy_fetch_failed', 'response', unknownErrorMessage(error));
    };
    try {
        if (useSharedAuth && setupOptions.sharedAuthSession) {
            accessTokenLease = await setupOptions.sharedAuthSession.getAccessToken(30000);
            await setupOptions.onAccessTokenLease?.(accessTokenLease);
            requestHeaders.Authorization = `Bearer ${accessTokenLease.accessToken}`;
        }
        let attemptResult = await performProxyNetFetch(debugContext.sender, debugContext.emitter, {
            url,
            headers: requestHeaders,
            ...fetchInput,
            requestKind: debugContext.requestKind,
        });
        let response = attemptResult.response;
        debugAttempt = attemptResult.debugAttempt;
        if (!accessTokenLease ||
            !setupOptions.sharedAuthSession ||
            !(await isSharedAuthRejection(response, responseType))) {
            return {
                response,
                accessTokenLease,
                useSharedAuth,
                ...(debugAttempt ? { debugAttempt } : {}),
            };
        }
        if (deleteRequestHeader(requestHeaders, 'token')) {
            await drainDiscardedProxyResponse(response, debugAttempt);
            attemptResult = await performProxyNetFetch(debugContext.sender, debugContext.emitter, {
                url,
                headers: requestHeaders,
                ...fetchInput,
                requestKind: debugContext.requestKind,
            });
            response = attemptResult.response;
            debugAttempt = attemptResult.debugAttempt;
            if (!(await isSharedAuthRejection(response, responseType))) {
                return {
                    response,
                    accessTokenLease,
                    useSharedAuth,
                    ...(debugAttempt ? { debugAttempt } : {}),
                };
            }
        }
        const decision = await setupOptions.sharedAuthSession.handleUnauthorized(accessTokenLease.generation, accessTokenLease.loginEpoch);
        if (decision === 'logout') {
            await setupOptions.onAccessTokenInvalidated?.();
            return {
                response,
                accessTokenLease,
                useSharedAuth,
                ...(debugAttempt ? { debugAttempt } : {}),
            };
        }
        await drainDiscardedProxyResponse(response, debugAttempt);
        const requestEpoch = accessTokenLease.loginEpoch;
        accessTokenLease = await setupOptions.sharedAuthSession.getAccessToken(30000);
        assertSameLoginEpoch(requestEpoch, accessTokenLease.loginEpoch);
        await setupOptions.onAccessTokenLease?.(accessTokenLease);
        requestHeaders.Authorization = `Bearer ${accessTokenLease.accessToken}`;
        attemptResult = await performProxyNetFetch(debugContext.sender, debugContext.emitter, {
            url,
            headers: requestHeaders,
            ...fetchInput,
            requestKind: debugContext.requestKind,
        });
        response = attemptResult.response;
        debugAttempt = attemptResult.debugAttempt;
        if (await isSharedAuthRejection(response, responseType)) {
            const finalDecision = await setupOptions.sharedAuthSession.handleUnauthorized(accessTokenLease.generation, accessTokenLease.loginEpoch);
            if (finalDecision === 'logout') {
                await setupOptions.onAccessTokenInvalidated?.();
            }
        }
        return {
            response,
            accessTokenLease,
            useSharedAuth,
            ...(debugAttempt ? { debugAttempt } : {}),
        };
    }
    catch (error) {
        markAttemptFailure(error);
        throw error;
    }
}
const PROTOCOL_REQUEST_HEADERS_TO_DROP = new Set([
    'accept-encoding',
    'connection',
    'content-length',
    'host',
    'origin',
    'referer',
    'transfer-encoding',
    'user-agent',
]);
function protocolRendererHeaders(headers) {
    const result = {};
    headers.forEach((value, key) => {
        const normalizedKey = key.toLowerCase();
        if (!PROTOCOL_REQUEST_HEADERS_TO_DROP.has(normalizedKey) &&
            !normalizedKey.startsWith('sec-fetch-')) {
            result[key] = value;
        }
    });
    return result;
}
function protocolResponseHeaders(headers) {
    const result = new Headers(headers);
    for (const name of [
        'connection',
        'content-encoding',
        'content-length',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'set-cookie',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
    ]) {
        result.delete(name);
    }
    return result;
}
function isBodylessProtocolResponse(method, status) {
    return method === 'HEAD' || status === 204 || status === 205 || status === 304;
}
/**
 * Main-owned upstream for the development-only app:// Cloud JSON bridge.
 * The app protocol handler allowlists the public path; this function repeats
 * the origin/path check before injecting shared OAuth credentials.
 */
export async function handleCloudProtocolJsonRequest(request) {
    const setupOptions = activeProxySetupOptions;
    if (!setupOptions) {
        return new Response(JSON.stringify({ error: 'cloud_proxy_unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
        });
    }
    const urlObj = new URL(request.url);
    if (!isSharedAuthRequest(urlObj) ||
        (urlObj.pathname !== '/minimax-cloud/api' && !urlObj.pathname.startsWith('/minimax-cloud/api/'))) {
        return new Response(JSON.stringify({ error: 'cloud_proxy_target_rejected' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
        });
    }
    const rendererHeaders = sanitizeRendererHeaders(protocolRendererHeaders(request.headers), true);
    const requestHeaders = buildRequestHeaders(urlObj, rendererHeaders);
    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();
    const { response } = await fetchProxyResponse(urlObj.toString(), urlObj, requestHeaders, {
        method,
        signal: request.signal,
        ...(body ? { body } : {}),
    }, setupOptions, { requestKind: 'request' });
    const responseBody = isBodylessProtocolResponse(method, response.status)
        ? null
        : await response.arrayBuffer();
    return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: protocolResponseHeaders(response.headers),
    });
}
/**
 * 处理代理请求
 */
async function handleProxyFetch(sender, options, setupOptions = {}, debugEmitter) {
    const controller = new AbortController();
    const timeout = options.timeout || 120000;
    const startTime = Date.now();
    const responseType = options.responseType || 'json';
    const isBinaryResponse = ['arraybuffer', 'blob', 'stream'].includes(responseType);
    const urlObj = new URL(options.url);
    const useSharedAuth = Boolean(setupOptions.sharedAuthSession) && isSharedAuthRequest(urlObj);
    const rendererHeaders = sanitizeRendererHeaders(options.headers, useSharedAuth);
    assertNoRendererCredentialQuery(urlObj, useSharedAuth);
    const logMethod = options.method || 'GET';
    const logHost = urlObj.host;
    const logSearchParams = new URLSearchParams(urlObj.searchParams);
    for (const key of Array.from(logSearchParams.keys())) {
        if (isSensitiveParamName(key))
            logSearchParams.delete(key);
    }
    const logSearch = logSearchParams.toString() ? `?${logSearchParams.toString()}` : '';
    const logPath = urlObj.pathname + logSearch;
    const logBody = describeLogBody(options.body);
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeout);
    let debugAttempt;
    try {
        // 确保有 User-Agent，避免被 Cloudflare 等安全服务拦截
        // Node 环境可以自由设置 Origin/Referer 等浏览器禁止修改的头
        const requestHeaders = buildRequestHeaders(urlObj, rendererHeaders);
        const fetchInput = {
            method: options.method || 'GET',
            signal: controller.signal,
        };
        if (options.body && options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
            fetchInput.body = options.body;
        }
        // 使用 Electron 的 net.fetch 而不是 Node.js 的 fetch
        // net.fetch 会使用 Chromium 的网络栈，自动遵循系统代理设置
        // 这确保 VPN 用户的请求能正确路由到海外服务器
        const fetched = await fetchProxyResponse(options.url, urlObj, requestHeaders, fetchInput, setupOptions, { sender, emitter: debugEmitter, requestKind: 'request' }, responseType);
        const { response, accessTokenLease, useSharedAuth } = fetched;
        debugAttempt = fetched.debugAttempt;
        const headers = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
        const contentType = response.headers.get('content-type') || '';
        let data;
        if (isBinaryResponse) {
            data = await readBinaryResponse(response, options.maxResponseBytes);
        }
        else if (responseType === 'document') {
            data = await response.text();
        }
        else if (responseType === 'text') {
            data = await response.text();
        }
        else {
            if (contentType.includes('application/json')) {
                try {
                    data = await response.json();
                }
                catch {
                    data = await response.text();
                }
            }
            else if (contentType.includes('text/') ||
                contentType.includes('application/xml') ||
                contentType.includes('application/javascript')) {
                data = await response.text();
            }
            else {
                try {
                    data = await response.text();
                }
                catch {
                    data = null;
                }
            }
        }
        clearTimeout(timeoutId);
        const result = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers,
            data,
        };
        debugAttempt?.responseData(data, responseType);
        debugAttempt?.complete();
        const duration = Date.now() - startTime;
        let responsePreview;
        if (isBinaryResponse) {
            const dataLen = typeof data === 'string' ? data.length : 0;
            const bytesSize = Math.round((dataLen * 3) / 4);
            responsePreview = `[Binary ${responseType} ${bytesSize} bytes]`;
        }
        else {
            responsePreview = describeLogBody(data);
        }
        const logFn = response.ok ? logger.info.bind(logger) : logger.error.bind(logger);
        const responseDiagnostics = getResponseDiagnostics(data, headers);
        logFn({
            msg: `[IPC Proxy] ${logMethod} ${logHost}${logPath}`,
            duration: `${duration}ms`,
            status: `${response.status} ${response.statusText}`,
            sharedAuth: useSharedAuth,
            hasBearer: Boolean(requestHeaders.Authorization),
            accessTokenGeneration: accessTokenLease?.generation,
            ...responseDiagnostics,
            requestHeaders: redactHeaders(requestHeaders),
            responseHeaders: redactHeaders(headers),
            request: logBody,
            response: responsePreview,
        });
        return result;
    }
    catch (error) {
        clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        const isTimeout = error instanceof Error && error.name === 'AbortError';
        if (isTimeout) {
            debugAttempt?.abort();
        }
        else {
            debugAttempt?.error('proxy_fetch_failed', 'response', errorMsg);
        }
        logger.error({
            msg: `[IPC Proxy] ${logMethod} ${logHost}${logPath}`,
            duration: `${duration}ms`,
            status: isTimeout ? 'TIMEOUT' : 'ERROR',
            error: errorMsg,
            requestHeaders: redactHeaders(rendererHeaders),
            request: logBody,
        });
        if (requiresInteractiveLogin(error)) {
            return {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: { 'content-type': 'application/json' },
                data: {
                    statusInfo: { code: NEED_LOGIN_ERROR_CODE, message: 'MCode authorization is required.' },
                },
            };
        }
        if (isTimeout) {
            return {
                ok: false,
                status: 0,
                statusText: 'Request timeout',
                headers: {},
                data: null,
            };
        }
        return {
            ok: false,
            status: 0,
            statusText: errorMsg,
            headers: {},
            data: null,
        };
    }
}
async function handleProxyStream(sender, options, setupOptions = {}, debugEmitter) {
    const { requestId } = options;
    if (!requestId || streamControllers.has(requestId))
        return;
    const controller = new AbortController();
    streamControllers.set(requestId, { controller, senderId: sender.id });
    const timeoutMs = options.timeout === undefined ? 120000 : options.timeout;
    // 0 explicitly disables the total timeout for long-lived streams.
    const timeoutId = timeoutMs === 0 ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    let debugAttempt;
    try {
        const urlObj = new URL(options.url);
        const useSharedAuth = Boolean(setupOptions.sharedAuthSession) && isSharedAuthRequest(urlObj);
        const rendererHeaders = sanitizeRendererHeaders(options.headers, useSharedAuth);
        assertNoRendererCredentialQuery(urlObj, useSharedAuth);
        const requestHeaders = buildRequestHeaders(urlObj, rendererHeaders);
        const fetched = await fetchProxyResponse(options.url, urlObj, requestHeaders, {
            method: options.method || 'GET',
            signal: controller.signal,
            ...(options.body &&
                options.method &&
                !['GET', 'HEAD'].includes(options.method.toUpperCase())
                ? { body: options.body }
                : {}),
        }, setupOptions, { sender, emitter: debugEmitter, requestKind: 'stream' }, 'stream');
        const { response } = fetched;
        debugAttempt = fetched.debugAttempt;
        const headers = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
        sendStreamEvent(sender, {
            requestId,
            type: 'headers',
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers,
        });
        if (response.body) {
            const reader = response.body.getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    if (value?.byteLength) {
                        sendStreamEvent(sender, {
                            requestId,
                            type: 'chunk',
                            data: Buffer.from(value).toString('base64'),
                        });
                        debugAttempt?.responseChunk(value);
                    }
                }
            }
            finally {
                reader.releaseLock();
            }
        }
        sendStreamEvent(sender, { requestId, type: 'done' });
        debugAttempt?.complete();
    }
    catch (error) {
        if (requiresInteractiveLogin(error)) {
            sendStreamEvent(sender, {
                requestId,
                type: 'headers',
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                headers: {},
            });
            sendStreamEvent(sender, { requestId, type: 'done' });
            return;
        }
        const isAbort = error instanceof Error && error.name === 'AbortError';
        try {
            sendStreamEvent(sender, {
                requestId,
                type: 'error',
                message: isAbort
                    ? 'Request aborted'
                    : error instanceof Error
                        ? error.message
                        : 'Unknown error',
            });
        }
        finally {
            if (isAbort) {
                debugAttempt?.abort();
            }
            else {
                debugAttempt?.error('proxy_stream_failed', 'stream', unknownErrorMessage(error));
            }
        }
    }
    finally {
        clearTimeout(timeoutId);
        streamControllers.delete(requestId);
    }
}
/**
 * 设置代理请求 IPC 处理器
 */
export function setupProxyIPC(setupOptions = {}) {
    activeProxySetupOptions = setupOptions;
    const debugEmitter = setupProxyFetchDebugEmitter(setupOptions.fetchDebug);
    ipcMain.handle(IPC_CHANNELS.PROXY_FETCH, (event, options) => {
        return handleProxyFetch(event.sender, options, setupOptions, debugEmitter);
    });
    ipcMain.on(IPC_CHANNELS.PROXY_STREAM_START, (event, options) => {
        void handleProxyStream(event.sender, options, setupOptions, debugEmitter);
    });
    ipcMain.on(IPC_CHANNELS.PROXY_STREAM_ABORT, (event, requestId) => {
        const entry = streamControllers.get(requestId);
        if (entry?.senderId === event.sender.id)
            entry.controller.abort();
    });
}
