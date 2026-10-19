import { createHash } from 'node:crypto';
import { getRuntimeBuildEnv, getRuntimeRegion } from '@mavis/config';
const SIGNATURE_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2';
const YY_SUFFIX = 'ooui';
const REQUEST_PATH = '/minimax-cloud/api/v1/desktop/p-config';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
class PromptConfigCloudClientError extends Error {
    code;
    status;
    constructor(code, message, status) {
        super(message);
        this.code = code;
        this.status = status;
        this.name = 'PromptConfigCloudClientError';
    }
}
/** Archon-biz client. Its response is the already merged, account-selected bundle. */
export class PromptConfigCloudClient {
    options;
    nowMs;
    timeoutMs;
    constructor(options) {
        this.options = options;
        if (!/^https?:\/\//u.test(options.baseUrl.trim())) {
            throw new PromptConfigCloudClientError('BASE_URL_INVALID', 'Prompt config base URL is invalid');
        }
        this.nowMs = options.nowMs ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    }
    async fetch(input) {
        const now = this.nowMs();
        const signedPath = appendQuery(REQUEST_PATH, buildPublicParams({
            now,
            appVersion: this.options.appVersion,
            userId: input.auth.accessToken ? input.auth.subject : undefined,
        }));
        const headers = buildHeaders({
            now,
            signedPath,
            accessToken: input.auth.accessToken,
            etag: input.etag,
            previewSecret: this.options.previewSecret,
            lane: this.options.lane,
        });
        let response;
        try {
            response = await this.options.fetchImpl(joinUrl(this.options.baseUrl, signedPath), {
                method: 'GET',
                headers,
                signal: AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)]),
            });
        }
        catch (error) {
            throw transportFailure(error);
        }
        if (response.status === 304) {
            return { kind: 'not_modified' };
        }
        if (response.status === 204) {
            return { kind: 'disabled' };
        }
        if (!response.ok) {
            throw new PromptConfigCloudClientError(`HTTP_${response.status}`, 'Prompt config request failed', response.status);
        }
        const rawPayload = await readBoundedText(response);
        const bundle = parseBundle(rawPayload);
        return {
            kind: 'updated',
            etag: response.headers.get('etag') ?? bundle.version,
            bundle,
            rawPayload,
        };
    }
}
/** Uses the same archon-biz deployment routing as the Desktop plugin client. */
export function resolvePromptConfigCloudBaseUrl() {
    const configured = process.env.NEXT_PUBLIC_DOMAIN_URL?.trim();
    if (configured)
        return configured;
    const region = getRuntimeRegion();
    const build = getRuntimeBuildEnv();
    if (region === 'cn') {
        if (build === 'test' || build === 'dev')
            return 'https://matrix-test.xaminim.com';
        if (build === 'staging')
            return 'https://matrix-pre.xaminim.com';
        return 'https://agent.minimaxi.com';
    }
    if (build === 'test' || build === 'dev')
        return 'https://matrix-overseas-test.xaminim.com';
    if (build === 'staging')
        return 'https://matrix-overseas-pre.xaminim.com';
    return 'https://agent.minimax.io';
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
    const headers = {
        'content-type': 'application/json',
        yy: md5(`${encodeURIComponent(input.signedPath)}_{}${md5(String(input.now))}${YY_SUFFIX}`),
        'x-timestamp': String(second),
        'x-signature': md5(`${second}${SIGNATURE_SALT}`),
    };
    if (input.accessToken)
        headers.Authorization = `Bearer ${input.accessToken}`;
    else
        headers['X-Mavis-Anonymous'] = 'true';
    if (input.etag)
        headers['if-none-match'] = input.etag;
    if (input.previewSecret?.trim())
        headers['X-Minimax-Agent-Preview-Secret'] = input.previewSecret.trim();
    if (input.lane?.trim()) {
        headers.lane = input.lane.trim();
        headers.bedrock_lane = input.lane.trim();
        headers['bedrock-lane'] = input.lane.trim();
    }
    return headers;
}
async function readBoundedText(response) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        throw new PromptConfigCloudClientError('RESPONSE_TOO_LARGE', 'Prompt config response is too large');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw new PromptConfigCloudClientError('RESPONSE_TOO_LARGE', 'Prompt config response is too large');
    }
    return text;
}
function parseBundle(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw invalidResponse();
    }
    if (!record(value))
        throw invalidResponse();
    const { version, key_version: keyVersion } = value;
    if (value.algorithm !== 'AES-256-GCM' ||
        typeof version !== 'string' ||
        typeof keyVersion !== 'string' ||
        !Array.isArray(value.files))
        throw invalidResponse();
    const files = value.files.map((file) => parseFile(file, version));
    if (files.some((file) => file === undefined))
        throw invalidResponse();
    return {
        version,
        algorithm: 'AES-256-GCM',
        keyVersion,
        files: files,
    };
}
function parseFile(value, version) {
    if (!record(value) ||
        typeof value.path !== 'string' ||
        typeof value.nonce !== 'string' ||
        typeof value.ciphertext !== 'string')
        return undefined;
    return {
        version,
        algorithm: 'AES-256-GCM',
        path: value.path,
        nonce: value.nonce,
        ciphertext: value.ciphertext,
    };
}
function invalidResponse() {
    return new PromptConfigCloudClientError('RESPONSE_INVALID', 'Prompt config response is invalid');
}
function appendQuery(path, query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
        params.set(key, String(value));
    return `${path}?${params.toString()}`;
}
function joinUrl(baseUrl, path) {
    return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}
function md5(value) {
    return createHash('md5').update(value).digest('hex');
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function transportFailure(error) {
    if (error instanceof PromptConfigCloudClientError)
        return error;
    if (error instanceof Error && error.name === 'AbortError')
        return new PromptConfigCloudClientError('REQUEST_ABORTED', 'Prompt config request was aborted');
    if (error instanceof Error && error.name === 'TimeoutError')
        return new PromptConfigCloudClientError('REQUEST_TIMEOUT', 'Prompt config request timed out');
    return new PromptConfigCloudClientError('NETWORK_ERROR', 'Prompt config request failed');
}
//# sourceMappingURL=prompt-config-cloud-client.js.map