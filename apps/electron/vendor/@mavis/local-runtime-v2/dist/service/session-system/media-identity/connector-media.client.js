import { DesktopMatrixClient } from '@mavis/agent-tools/desktop';
import { createFingerprinter } from './fingerprint.js';
const TOOL_NAME = 'connector__matrix__get_asset_url';
const CONNECTOR_BASE = '/minimax-cloud/api/v1/connectors';
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LIMITS = {
    maxBytes: MAX_MEDIA_BYTES,
    timeoutMs: REQUEST_TIMEOUT_MS,
};
/** Reads the same authenticated resource bytes that mcode-tools originally downloaded. */
export class ConnectorMediaClient {
    options;
    generation = 0;
    lastAuth;
    constructor(options) {
        this.options = options;
    }
    capture() {
        const current = this.options.authContextGetter();
        const auth = captureAuth(current);
        if (!sameAuth(current, this.lastAuth))
            this.generation += 1;
        this.lastAuth = current ? { ...current } : undefined;
        if (!auth)
            return undefined;
        const isCurrent = () => sameAuth(auth, this.options.authContextGetter());
        const assertCurrent = () => {
            if (!isCurrent())
                throw new Error('Media identity login changed.');
        };
        const routingHeaders = { ...this.options.routingHeadersGetter?.() };
        const client = new DesktopMatrixClient({
            ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
            accessToken: auth.accessToken,
            routingHeadersGetter: () => routingHeaders,
            timeoutMs: REQUEST_TIMEOUT_MS,
            // An authenticated API supplies the URL; redirects must not change its destination.
            fetchImpl: (input, init) => this.options.fetchImpl(input, {
                ...init,
                ...(init?.method === 'GET' ? { redirect: 'error' } : {}),
            }),
        });
        let tool;
        const request = async (path, body, signal) => {
            assertCurrent();
            signal.throwIfAborted();
            const response = await client.postGatewayJson(path, body, signal);
            assertCurrent();
            assertBaseResponse(response);
            return response;
        };
        return {
            // A process-local generation separates unversioned login credentials without storing tokens in keys.
            key: JSON.stringify([auth.realUserID, auth.loginEpoch || `unversioned:${this.generation}`]),
            isCurrent,
            digest: async (nodeId, signal, limits = DEFAULT_LIMITS) => {
                if (!/^[A-Za-z0-9_-]{1,256}$/u.test(nodeId))
                    throw new Error('Invalid media resource identity.');
                assertCurrent();
                signal.throwIfAborted();
                try {
                    tool ??= (async () => readAssetUrlTool(await request(`${CONNECTOR_BASE}/connected-tools/list`, {}, signal)))();
                    const descriptor = await tool;
                    assertCurrent();
                    const response = await request(`${CONNECTOR_BASE}/tools/call`, {
                        ...descriptor,
                        runtime_tool_name: TOOL_NAME,
                        arguments_json: JSON.stringify({ node_id: nodeId }),
                    }, signal);
                    const url = readDownloadUrl(response);
                    // The timeout covers the whole body read, not only the response headers.
                    const stream = await client.getStream(url, signal, limits.timeoutMs);
                    return await fingerprintStream(stream, limits, signal, assertCurrent);
                }
                catch {
                    // Backend and signed-URL errors may contain credentials; expose only a stable error.
                    throw new Error('Media identity verification failed.');
                }
            },
        };
    }
}
async function fingerprintStream(stream, limits, signal, assertCurrent) {
    const reader = stream.body.getReader();
    try {
        if (stream.contentLength !== undefined && stream.contentLength > limits.maxBytes)
            throw new Error('Media exceeds identity verification limit.');
        const fingerprint = createFingerprinter();
        let bytes = 0;
        for (;;) {
            signal.throwIfAborted();
            assertCurrent();
            const chunk = await reader.read();
            if (chunk.done)
                break;
            bytes += chunk.value.byteLength;
            if (bytes > limits.maxBytes)
                throw new Error('Media exceeds identity verification limit.');
            fingerprint.update(chunk.value);
        }
        signal.throwIfAborted();
        assertCurrent();
        return fingerprint.finish();
    }
    finally {
        try {
            await reader.cancel();
        }
        catch {
            // Cancellation is best-effort cleanup; the read outcome is already decided.
        }
        reader.releaseLock();
        stream.dispose();
    }
}
function captureAuth(value) {
    if (!value?.accessToken?.trim() ||
        !value.realUserID?.trim() ||
        value.authState === 'logged_out' ||
        value.authState === 'pending')
        return undefined;
    return { ...value };
}
function sameAuth(left, right) {
    return Boolean(left &&
        right &&
        left.accessToken === right.accessToken &&
        left.realUserID === right.realUserID &&
        left.loginEpoch === right.loginEpoch &&
        left.authState === right.authState);
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function assertBaseResponse(value) {
    if (!Object.hasOwn(value, 'base_resp'))
        return;
    const base = record(value.base_resp);
    if (!base || (base.status_code !== 0 && base.status_code !== '0'))
        throw new Error('Media resource API failed.');
}
function readAssetUrlTool(value) {
    if (!Array.isArray(value.tools) ||
        !Array.isArray(value.provider_failures) ||
        typeof value.partial !== 'boolean')
        throw new Error('Invalid Connector inventory.');
    const matches = value.tools.map(record).filter((item) => item?.runtime_tool_name === TOOL_NAME);
    const tool = matches[0];
    if (matches.length !== 1 ||
        !tool ||
        typeof tool.provider !== 'string' ||
        !tool.provider.trim() ||
        typeof tool.provider_tool_name !== 'string' ||
        !tool.provider_tool_name.trim())
        throw new Error('Media resource tool is unavailable.');
    return { provider: tool.provider, provider_tool_name: tool.provider_tool_name };
}
function readToolResult(response) {
    if (response.is_error === true ||
        (response.is_error !== undefined && typeof response.is_error !== 'boolean') ||
        typeof response.result_json !== 'string')
        throw new Error('Media resource lookup failed.');
    return record(JSON.parse(response.result_json));
}
function readDownloadUrl(response) {
    const result = readToolResult(response);
    if (!result ||
        (result.code !== 0 && result.code !== '0') ||
        typeof result.download_url !== 'string')
        throw new Error('Invalid media resource URL.');
    const url = new URL(result.download_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
        throw new Error('Invalid media resource URL.');
    // Connector URLs can target the sandbox's OSS intranet endpoint; Desktop uses its public peer.
    url.hostname = url.hostname.replace(/^([a-z0-9][a-z0-9-]*)\.(oss-[a-z0-9-]+)-internal\.aliyuncs\.com$/u, '$1.$2.aliyuncs.com');
    return url.href;
}
//# sourceMappingURL=connector-media.client.js.map