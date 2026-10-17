import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { getRuntimeRegion } from '@mavis/config';
import { writeFileChunkFully } from './file-chunk-writer.js';
import { PLUGIN_PACKAGE_V1_LIMITS } from './plugin/package/package-contract.js';
const SIGNATURE_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2';
const YY_SUFFIX = 'ooui';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
export class PluginSystemCloudTransportError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'PluginSystemCloudTransportError';
    }
}
/** Signed archon_biz transport owned by the Desktop utility runtime. */
export class PluginSystemCloudTransport {
    options;
    nowMs;
    timeoutMs;
    downloadTimeoutMs;
    constructor(options) {
        this.options = options;
        const baseUrl = options.baseUrl.trim();
        if (!/^https?:\/\//u.test(baseUrl)) {
            throw new PluginSystemCloudTransportError('BASE_URL_INVALID', 'Plugin System Cloud base URL is invalid');
        }
        this.nowMs = options.nowMs ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    }
    async request(request) {
        const auth = readAuth(resolveAuthContext(request, this.options.authContextGetter), request.auth);
        const now = this.nowMs();
        const route = buildRoute(request.path, request.query);
        const publicParams = buildPublicParams({
            now,
            appVersion: this.options.appVersion,
            userId: auth?.realUserID,
        });
        const signedPath = appendQuery(route, publicParams);
        const body = request.method === 'POST'
            ? {
                ...(request.body ?? {}),
                ...(auth ? { common_param: { user_id: auth.realUserID } } : {}),
            }
            : undefined;
        const bodyText = body ? JSON.stringify(body) : '';
        const signal = composeSignal(request.signal, request.timeoutMs ?? this.timeoutMs);
        let response;
        try {
            const responsePromise = this.options.fetchImpl(joinUrl(this.options.baseUrl, signedPath), {
                method: request.method,
                headers: buildHeaders({
                    auth,
                    body,
                    bodyText,
                    now,
                    signedPath,
                    previewSecret: this.options.previewSecret,
                    lane: this.options.lane,
                }),
                ...(bodyText ? { body: bodyText } : {}),
                signal,
            });
            request.onDispatch?.();
            response = await responsePromise;
        }
        catch (error) {
            throw transportFailure(error);
        }
        if (!response.ok) {
            throw new PluginSystemCloudTransportError('HTTP_ERROR', `Plugin Cloud request failed with HTTP ${response.status}`, response.status);
        }
        let payload;
        try {
            payload = await response.json();
        }
        catch {
            throw new PluginSystemCloudTransportError('RESPONSE_INVALID', 'Plugin System Cloud response is not JSON');
        }
        assertBusinessSuccess(payload);
        return payload;
    }
    async downloadToFile(url, targetPath, signal) {
        const parsed = parseDownloadUrl(url);
        let response;
        try {
            response = await this.options.fetchImpl(parsed, {
                method: 'GET',
                signal: composeSignal(signal, this.downloadTimeoutMs),
            });
        }
        catch (error) {
            throw transportFailure(error);
        }
        if (!response.ok || !response.body) {
            throw new PluginSystemCloudTransportError('DOWNLOAD_HTTP_ERROR', `Plugin package download failed with HTTP ${response.status}`, response.status);
        }
        await writeBoundedBody(response, targetPath);
    }
}
function resolveAuthContext(request, getter) {
    return request.authContext === undefined ? getter() : request.authContext;
}
function buildPublicParams(input) {
    const region = getRuntimeRegion();
    return {
        device_platform: 'web',
        biz_id: 3,
        app_id: '3001',
        version_code: '22201',
        unix: input.now,
        timezone_offset: new Date(input.now).getTimezoneOffset() * -60,
        sys_language: region === 'en' ? 'en' : 'zh',
        lang: region === 'en' ? 'en' : 'zh',
        device_id: 0,
        ...(input.userId ? { user_id: input.userId } : {}),
        client: 'desktop',
        region,
        is_desktop: 1,
        ...(input.appVersion ? { desktop_version: input.appVersion } : {}),
    };
}
function buildHeaders(input) {
    const second = Math.floor(input.now / 1000);
    const yyBody = input.body ? JSON.stringify(input.body) : '{}';
    const headers = {
        'content-type': 'application/json',
        yy: md5(`${encodeURIComponent(input.signedPath)}_${yyBody}${md5(String(input.now))}${YY_SUFFIX}`),
        'x-timestamp': String(second),
        'x-signature': md5(`${second}${SIGNATURE_SALT}${input.bodyText}`),
    };
    if (input.auth)
        headers.Authorization = `Bearer ${input.auth.accessToken}`;
    if (input.previewSecret?.trim()) {
        headers['X-Minimax-Agent-Preview-Secret'] = input.previewSecret.trim();
    }
    if (input.lane?.trim()) {
        headers.lane = input.lane.trim();
        headers.bedrock_lane = input.lane.trim();
        headers['bedrock-lane'] = input.lane.trim();
    }
    return headers;
}
function readAuth(context, mode) {
    if (mode === 'none')
        return undefined;
    const accessToken = context?.accessToken?.trim();
    const realUserID = context?.realUserID?.trim();
    if (accessToken && realUserID)
        return { accessToken, realUserID };
    if (mode === 'required') {
        throw new PluginSystemCloudTransportError('AUTH_REQUIRED', 'Plugin System Cloud request requires login');
    }
    return undefined;
}
function buildRoute(path, query) {
    if (!path.startsWith('/') || path.includes('://')) {
        throw new PluginSystemCloudTransportError('PATH_INVALID', 'Plugin System Cloud request path is invalid');
    }
    return appendQuery(path, query ?? {});
}
function appendQuery(value, query) {
    const [pathname, existing = ''] = value.split('?', 2);
    const params = new URLSearchParams(existing);
    for (const [key, item] of Object.entries(query)) {
        if (item !== undefined)
            params.set(key, String(item));
    }
    const suffix = params.toString();
    return suffix ? `${pathname}?${suffix}` : (pathname ?? value);
}
function joinUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}
function parseDownloadUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new PluginSystemCloudTransportError('DOWNLOAD_URL_INVALID', 'Plugin download URL is invalid');
    }
    if (parsed.protocol !== 'https:' &&
        parsed.hostname !== '127.0.0.1' &&
        parsed.hostname !== 'localhost') {
        throw new PluginSystemCloudTransportError('DOWNLOAD_URL_INVALID', 'Plugin download URL must use HTTPS');
    }
    return parsed.toString();
}
function composeSignal(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
function assertBusinessSuccess(payload) {
    if (!isRecord(payload)) {
        throw new PluginSystemCloudTransportError('RESPONSE_INVALID', 'Plugin System Cloud response is invalid');
    }
    const base = readRecord(payload, 'base_resp', 'baseResp');
    if (!base)
        return;
    const status = readNumber(base, 'status_code', 'statusCode');
    if (status !== undefined && status !== 0) {
        throw new PluginSystemCloudTransportError('BUSINESS_ERROR', 'Plugin System Cloud request was rejected');
    }
}
async function writeBoundedBody(response, targetPath) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveBytes) {
        throw new PluginSystemCloudTransportError('DOWNLOAD_TOO_LARGE', 'Plugin package exceeds the byte limit');
    }
    const reader = response.body?.getReader();
    if (!reader)
        throw new PluginSystemCloudTransportError('DOWNLOAD_EMPTY', 'Plugin package body is empty');
    const handle = await open(targetPath, 'wx', 0o600);
    let total = 0;
    let done = false;
    try {
        while (!done) {
            const result = await reader.read();
            if (result.done) {
                done = true;
                continue;
            }
            total += result.value.byteLength;
            if (total > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveBytes) {
                await reader.cancel();
                throw new PluginSystemCloudTransportError('DOWNLOAD_TOO_LARGE', 'Plugin package exceeds the byte limit');
            }
            await writeFileChunkFully(handle, result.value, () => new PluginSystemCloudTransportError('DOWNLOAD_WRITE_FAILED', 'Plugin package download could not be written completely'));
        }
    }
    finally {
        await handle.close();
    }
}
function transportFailure(error) {
    if (error instanceof PluginSystemCloudTransportError)
        return error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    if (aborted) {
        return new PluginSystemCloudTransportError('REQUEST_ABORTED', 'Plugin System Cloud request was aborted');
    }
    if (timedOut) {
        return new PluginSystemCloudTransportError('REQUEST_TIMEOUT', 'Plugin System Cloud request timed out');
    }
    return new PluginSystemCloudTransportError('NETWORK_ERROR', 'Plugin System Cloud request failed');
}
function md5(value) {
    return createHash('md5').update(value).digest('hex');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readRecord(value, snake, camel) {
    const field = value[snake] ?? value[camel];
    return isRecord(field) ? field : undefined;
}
function readNumber(value, snake, camel) {
    const field = value[snake] ?? value[camel];
    return typeof field === 'number' ? field : undefined;
}
//# sourceMappingURL=cloud-transport.js.map