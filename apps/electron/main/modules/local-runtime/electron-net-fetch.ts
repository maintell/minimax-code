import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
export let ELECTRON_NET_FETCH_BYTESTRING_CODE = 'ELECTRON_NET_FETCH_BYTESTRING';
const FEISHU_RESOURCE_ORIGIN = 'https://open.feishu.cn';
const FEISHU_RESOURCE_PATH = /^\/open-apis\/im\/v1\/messages\/[^/]+\/resources\/[^/]+$/u;
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_DIAGNOSTIC_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,64}$/u;
const SAFE_HOST = /^[a-z0-9.-]{1,253}$/u;
const SAFE_METHOD = /^[A-Z]{1,20}$/u;
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
let requestSequence = 0;
class InvalidResponseHeaderError extends Error {
    constructor(details) {
        super('Electron network response header is not supported');
        this.details = details;
        this.name = 'InvalidResponseHeaderError';
    }
}
/**
 * Use Electron's Chromium-backed `net.request` for HTTP(S) requests. Electron
 * 42 converts response headers inside a native `net.fetch` callback; a malformed
 * ByteString escapes the returned Promise and can terminate the utility runtime.
 * This adapter keeps the same Chromium session/proxy/TLS path while keeping the
 * response-header conversion in this request-local, guarded callback.
 */
export function createElectronNetFetch(electronApi, options = {}) {
    const electronNet = electronApi && typeof electronApi === 'object' ? electronApi.net : undefined;
    if (typeof electronNet?.fetch !== 'function')
        return undefined;
    const electronFetch = electronNet.fetch;
    const electronRequest = electronNet.request;
    return (input, init) => {
        if (typeof electronRequest !== 'function') {
            return electronFetch.call(electronNet, input, init) ?? globalThis.fetch(input, init);
        }
        // Existing attachment downloads intentionally buffer the body and omit
        // response headers. Keep that behavior for compatibility with Feishu media.
        if (isFeishuMessageResourceGet(input, init)) {
            return fetchFeishuResource(electronNet, electronRequest, input, init);
        }
        // `net.request` does not have the same custom-scheme support as `net.fetch`.
        // The response-header crash is an HTTP(S) concern, so preserve native fetch
        // behavior for app/file/custom protocols.
        if (!isHttpFetchInput(input)) {
            return electronFetch.call(electronNet, input, init) ?? globalThis.fetch(input, init);
        }
        return fetchHttpResource(electronNet, electronRequest, input, init, options.onResponseHeaderRejected);
    };
}
export function isElectronNetFetchByteStringError(error) {
    return (!!error &&
        typeof error === 'object' &&
        error.code === ELECTRON_NET_FETCH_BYTESTRING_CODE);
}
function fetchHttpResource(electronNet, electronRequest, input, init, onResponseHeaderRejected) {
    return new Promise((resolve, reject) => {
        let request;
        let fetchRequest;
        let signal;
        let response;
        let settled = false;
        let locallyAborted = false;
        const requestBodyAbortController = new AbortController();
        const settleResolve = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        const settleReject = (error) => {
            if (settled)
                return;
            settled = true;
            cleanupSignal();
            reject(error);
        };
        function cleanupSignal() {
            signal?.removeEventListener('abort', onAbort);
        }
        function abortRequest() {
            try {
                request?.abort();
            }
            catch {
                // The request-local rejection remains authoritative if native abort fails.
            }
        }
        function cancelRequestBody(reason) {
            const body = fetchRequest?.body;
            if (!body)
                return;
            if (!requestBodyAbortController.signal.aborted)
                requestBodyAbortController.abort(reason);
            if (!body.locked)
                void body.cancel(reason).catch(() => undefined);
        }
        function onAbort() {
            locallyAborted = true;
            const reason = getAbortReason(signal);
            // Reject before aborting because Electron can synchronously emit a late
            // request error from abort(). The fetch contract should still report the signal reason.
            settleReject(reason);
            cancelRequestBody(reason);
            destroyResponse(response, createAbortError());
            abortRequest();
            cleanupSignal();
        }
        function onRequestError(error) {
            cleanupSignal();
            cancelRequestBody(error);
            destroyResponse(response, toResponseError(error));
            settleReject(normalizeRequestError(error));
        }
        function onResponseError(error) {
            cleanupSignal();
            cancelRequestBody(error);
            settleReject(normalizeRequestError(error));
        }
        function onResponseAborted() {
            const error = new Error('Electron net.request response aborted');
            cleanupSignal();
            cancelRequestBody(error);
            destroyResponse(response, error);
            settleReject(error);
        }
        function onResponseEnd() {
            cleanupSignal();
        }
        function onResponse(nextResponse) {
            // Keep late native errors observed after the Response has settled. Removing
            // these listeners after abort can turn an Electron event into uncaughtException.
            response = nextResponse;
            response.on('error', onResponseError);
            response.on('aborted', onResponseAborted);
            response.on('end', onResponseEnd);
            if (settled || locallyAborted) {
                destroyResponse(response, createAbortError());
                return;
            }
            try {
                if (!fetchRequest)
                    throw new Error('Electron net.request missing Request');
                const headers = createResponseHeaders(response.headers);
                const body = NULL_BODY_STATUS.has(response.statusCode) || fetchRequest.method === 'HEAD'
                    ? null
                    : Readable.toWeb(response);
                const result = new Response(body, {
                    headers,
                    status: response.statusCode,
                    statusText: response.statusMessage,
                });
                settleResolve(result);
                if (body === null)
                    cleanupSignal();
            }
            catch (error) {
                if (error instanceof InvalidResponseHeaderError && fetchRequest) {
                    reportInvalidResponseHeader(fetchRequest, response.statusCode, error.details, onResponseHeaderRejected);
                    settleReject(createByteStringFetchError());
                }
                else {
                    settleReject(error);
                }
                cancelRequestBody(error);
                destroyResponse(response, toResponseError(error));
                abortRequest();
            }
        }
        function endRequestBody() {
            if (!request || !fetchRequest)
                return;
            if (!fetchRequest.body) {
                request.end();
                return;
            }
            const writable = Writable.toWeb(request);
            void fetchRequest.body
                .pipeTo(writable, { preventClose: true, signal: requestBodyAbortController.signal })
                .then(() => {
                if (!locallyAborted)
                    request?.end();
            })
                .catch((error) => {
                if (locallyAborted)
                    return;
                cleanupSignal();
                cancelRequestBody(error);
                settleReject(error);
                destroyResponse(response, toResponseError(error));
                abortRequest();
            });
        }
        try {
            fetchRequest = new Request(input, init);
            signal = fetchRequest.signal;
            if (signal.aborted) {
                onAbort();
                return;
            }
            request = electronRequest.call(electronNet, buildHttpRequestOptions(fetchRequest));
            request.on('response', onResponse);
            request.on('error', onRequestError);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
                onAbort();
                return;
            }
            setRequestBypassCustomProtocolHandlers(request, init);
            setRequestHeaders(request, fetchRequest);
            endRequestBody();
        }
        catch (error) {
            cleanupSignal();
            cancelRequestBody(error);
            destroyResponse(response, toResponseError(error));
            settleReject(normalizeRequestError(error));
            abortRequest();
        }
    });
}
function buildHttpRequestOptions(request) {
    const origin = request.headers.get('origin') ?? undefined;
    // Electron's upstream net.fetch converts a same-origin request without an
    // Origin header to include so cookies retain their existing main-process behavior.
    const credentials = request.credentials === 'same-origin' && !origin ? 'include' : request.credentials;
    return {
        url: request.url,
        method: request.method,
        ...(origin ? { origin } : {}),
        credentials,
        cache: request.cache,
        referrerPolicy: request.referrerPolicy,
        redirect: request.redirect,
    };
}
function setRequestBypassCustomProtocolHandlers(request, init) {
    const bypassCustomProtocolHandlers = init
        ?.bypassCustomProtocolHandlers;
    if (bypassCustomProtocolHandlers && request._urlLoaderOptions) {
        request._urlLoaderOptions.bypassCustomProtocolHandlers = true;
    }
}
function setRequestHeaders(request, fetchRequest) {
    if (typeof request.setHeader !== 'function') {
        throw new Error('Electron net.request does not support request headers');
    }
    // CORS is Electron net.fetch's default mode, but Chromium only receives the
    // corresponding Sec-Fetch-Mode header when an Origin is present.
    const origin = fetchRequest.headers.get('origin');
    if (fetchRequest.mode !== 'cors' || origin) {
        request.setHeader('Sec-Fetch-Mode', fetchRequest.mode);
    }
    const setHeader = request.setHeader.bind(request);
    fetchRequest.headers.forEach((value, name) => {
        setHeader(name, value);
    });
}
function createResponseHeaders(responseHeaders) {
    try {
        const headers = new Headers();
        for (const [name, rawValue] of Object.entries(responseHeaders ?? {})) {
            const value = Array.isArray(rawValue) ? rawValue.join(', ') : (rawValue ?? '');
            const character = findNonByteStringCharacter(name) ?? findNonByteStringCharacter(value);
            if (character) {
                throw new InvalidResponseHeaderError({
                    headerName: sanitizeHeaderName(name),
                    ...(character ? toCharacterDiagnostic(character) : {}),
                });
            }
            try {
                headers.set(name, value);
            }
            catch {
                throw new InvalidResponseHeaderError({ headerName: sanitizeHeaderName(name) });
            }
        }
        return headers;
    }
    catch (error) {
        if (error instanceof InvalidResponseHeaderError)
            throw error;
        throw new InvalidResponseHeaderError({ headerName: '<unknown>' });
    }
}
function findNonByteStringCharacter(value) {
    for (let index = 0; index < value.length;) {
        const codePoint = value.codePointAt(index);
        if (codePoint === undefined)
            return undefined;
        if (codePoint > 0xff)
            return { index, codePoint };
        index += codePoint > 0xffff ? 2 : 1;
    }
    return undefined;
}
function toCharacterDiagnostic(character) {
    return {
        characterIndex: character.index,
        characterCodePoint: character.codePoint,
    };
}
function destroyResponse(response, error) {
    try {
        response?.destroy?.(error);
    }
    catch {
        // A terminal request should not let stream cleanup escape native callbacks.
    }
}
function toResponseError(error) {
    return error instanceof Error ? error : new Error('Electron net.request response failed');
}
function reportInvalidResponseHeader(request, status, details, report) {
    if (!report)
        return;
    try {
        const url = new URL(request.url);
        report({
            request_id: nextRequestId(),
            method: sanitizeMethod(request.method),
            status: sanitizeStatus(status),
            host: sanitizeHost(url.hostname),
            route_hash: hashRoute(url.pathname),
            error_code: ELECTRON_NET_FETCH_BYTESTRING_CODE,
            header_name: details.headerName,
            ...(details.characterIndex === undefined ? {} : { character_index: details.characterIndex }),
            ...(details.characterCodePoint === undefined
                ? {}
                : { character_code_point: details.characterCodePoint }),
        });
    }
    catch {
        // Logging must not make a native Electron response callback unsafe.
    }
}
function nextRequestId() {
    requestSequence = (requestSequence + 1) % Number.MAX_SAFE_INTEGER;
    return `electron-net-${requestSequence.toString(36)}`;
}
function sanitizeMethod(method) {
    const normalized = method.toUpperCase();
    return SAFE_METHOD.test(normalized) ? normalized : 'UNKNOWN';
}
function sanitizeStatus(status) {
    return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}
function sanitizeHost(host) {
    const normalized = host.toLowerCase();
    return SAFE_HOST.test(normalized) ? normalized : '<invalid-host>';
}
function sanitizeHeaderName(name) {
    return SAFE_DIAGNOSTIC_HEADER_NAME.test(name) ? name.toLowerCase() : '<invalid-header>';
}
function hashRoute(pathname) {
    return createHash('sha256').update(pathname).digest('hex').slice(0, 16);
}
function getAbortReason(signal) {
    const reason = signal?.reason;
    return reason ?? createAbortError();
}
function fetchFeishuResource(electronNet, electronRequest, input, init) {
    return new Promise((resolve, reject) => {
        let request;
        let response;
        const signal = init?.signal;
        let settled = false;
        const settleResolve = (value) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const settleReject = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            reject(error);
        };
        function cleanup() {
            // Keep request/response error listeners after settle: Electron can emit a
            // late error after abort, and removing them would turn it into uncaughtException.
            signal?.removeEventListener('abort', onAbort);
        }
        function onAbort() {
            try {
                request?.abort();
            }
            catch {
                // Aborting is best-effort; the fetch contract still rejects as aborted.
            }
            settleReject(createAbortError());
        }
        function onRequestError(error) {
            settleReject(normalizeRequestError(error));
        }
        function onResponseError(error) {
            settleReject(normalizeRequestError(error));
        }
        function onResponseAborted() {
            settleReject(new Error('Electron net.request response aborted'));
        }
        const chunks = [];
        function onData(chunk) {
            try {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            catch (error) {
                settleReject(error);
            }
        }
        function onEnd() {
            try {
                if (!response)
                    throw new Error('Electron net.request response missing');
                settleResolve(createMinimalResponse(response.statusCode, Buffer.concat(chunks)));
            }
            catch (error) {
                settleReject(error);
            }
        }
        function onResponse(nextResponse) {
            response = nextResponse;
            response.on('data', onData);
            response.on('end', onEnd);
            response.on('error', onResponseError);
            response.on('aborted', onResponseAborted);
        }
        try {
            const options = buildFeishuRequestOptions(input, init);
            request = electronRequest.call(electronNet, options);
            request.on('response', onResponse);
            request.on('error', onRequestError);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
                return;
            }
            request.end();
        }
        catch (error) {
            settleReject(normalizeRequestError(error));
        }
    });
}
// Do not inspect or forward upstream headers. In particular, a Chinese
// Content-Disposition makes Electron net.fetch's response-header conversion to Web
// Headers trigger ByteString validation; this path avoids that conversion.
function createMinimalResponse(status, body) {
    const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
    // Normalize Buffer<ArrayBufferLike> for Node 22's DOM BodyInit type;
    // response bytes remain unchanged.
    return new Response(bodyAllowed ? new Uint8Array(body) : null, { status });
}
function buildFeishuRequestOptions(input, init) {
    const url = getFetchInputUrl(input);
    if (!url)
        throw new TypeError('Invalid Feishu resource URL');
    const headers = new Headers(getFetchInputHeaders(input));
    if (init?.headers !== undefined) {
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    }
    const headerRecord = {};
    headers.forEach((value, name) => {
        headerRecord[name] = value;
    });
    return {
        url,
        method: 'GET',
        ...(Object.keys(headerRecord).length > 0 ? { headers: headerRecord } : {}),
    };
}
function getFetchInputUrl(input) {
    if (typeof input === 'string')
        return input;
    if (input instanceof URL)
        return input.href;
    if (input && typeof input === 'object') {
        const url = input.url;
        if (typeof url === 'string')
            return url;
    }
    return undefined;
}
function getFetchInputMethod(input) {
    if (input && typeof input === 'object') {
        const method = input.method;
        if (typeof method === 'string')
            return method;
    }
    return undefined;
}
function getFetchInputHeaders(input) {
    if (input && typeof input === 'object') {
        const headers = input.headers;
        if (headers && typeof headers === 'object')
            return headers;
    }
    return undefined;
}
function isHttpFetchInput(input) {
    const rawUrl = getFetchInputUrl(input);
    if (!rawUrl)
        return false;
    try {
        return HTTP_PROTOCOLS.has(new URL(rawUrl).protocol);
    }
    catch {
        return false;
    }
}
function isFeishuMessageResourceGet(input, init) {
    const method = (init?.method ?? getFetchInputMethod(input) ?? 'GET').toUpperCase();
    if (method !== 'GET')
        return false;
    const rawUrl = getFetchInputUrl(input);
    if (!rawUrl)
        return false;
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return false;
    }
    return url.origin === FEISHU_RESOURCE_ORIGIN && FEISHU_RESOURCE_PATH.test(url.pathname);
}
function isElectronByteStringException(error) {
    if (!(error instanceof TypeError))
        return false;
    const message = error.message;
    const stack = error.stack;
    return (typeof message === 'string' &&
        message.includes('Cannot convert argument to a ByteString') &&
        message.includes('greater than 255') &&
        typeof stack === 'string' &&
        stack.includes('node:electron/js2c/utility_init'));
}
function normalizeRequestError(error) {
    return isElectronByteStringException(error) ? createByteStringFetchError() : error;
}
function createByteStringFetchError() {
    const error = new Error('Electron network response header is not supported');
    error.code = ELECTRON_NET_FETCH_BYTESTRING_CODE;
    error.status = 400;
    return error;
}
function createAbortError() {
    if (typeof DOMException === 'function') {
        return new DOMException('The operation was aborted.', 'AbortError');
    }
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}
/**
 * Resolve Electron's Chromium-backed fetch for managed outbound product calls.
 *
 * In Vitest, `electron` can resolve to the Electron binary path string
 * instead of the runtime API object, so this must be defensive and optional. Callers
 * should omit the override and let local-runtime fall back to `globalThis.fetch`
 * when this returns undefined.
 */
export function resolveElectronNetFetch(onResponseHeaderRejected) {
    if (!process.versions.electron)
        return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return createElectronNetFetch(require('electron'), { onResponseHeaderRejected });
    }
    catch {
        return undefined;
    }
}
