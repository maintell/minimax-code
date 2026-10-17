/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/ilink-client.ts`.
 */
/**
 * iLink Bot SDK — Core HTTP API client.
 *
 * Wraps all iLink Bot CGI endpoints with proper auth headers, timeouts,
 * and abort handling. HTTP transport is injected by the host.
 */
import crypto from 'node:crypto';
import { ilinkFetch } from './ilink-fetch.js';
import { buildIlinkBaseInfo, buildIlinkCommonHeaders } from './ilink-wire.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
// ---------------------------------------------------------------------------
// ILinkClient
// ---------------------------------------------------------------------------
export class ILinkClient {
    baseUrl;
    token;
    timeoutMs;
    longPollTimeoutMs;
    constructor(opts = {}) {
        this.baseUrl = ensureTrailingSlash(opts.baseUrl ?? DEFAULT_BASE_URL);
        this.token = opts.token;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
        this.longPollTimeoutMs = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    }
    /** Update the bearer token (e.g. after QR login). */
    setToken(token) {
        this.token = token;
    }
    getToken() {
        return this.token;
    }
    getBaseUrl() {
        return this.baseUrl;
    }
    // -------------------------------------------------------------------------
    // getUpdates — long-poll for inbound messages
    // -------------------------------------------------------------------------
    /**
     * Long-poll for new messages. Server holds the connection up to `longPollTimeoutMs`.
     * On client-side timeout (AbortError) returns an empty response with ret=0.
     */
    async getUpdates(getUpdatesBuf, timeoutMs) {
        try {
            const text = await this.apiFetch({
                endpoint: 'ilink/bot/getupdates',
                body: {
                    get_updates_buf: getUpdatesBuf ?? '',
                    base_info: buildBaseInfo(),
                },
                timeoutMs: timeoutMs ?? this.longPollTimeoutMs,
                label: 'getUpdates',
            });
            return JSON.parse(text);
        }
        catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
            }
            throw err;
        }
    }
    // -------------------------------------------------------------------------
    // sendMessage
    // -------------------------------------------------------------------------
    /** Send a message (text, image, video, file). */
    async sendMessage(req) {
        const text = await this.apiFetch({
            endpoint: 'ilink/bot/sendmessage',
            body: { ...req, base_info: buildBaseInfo() },
            timeoutMs: this.timeoutMs,
            label: 'sendMessage',
        });
        const resp = JSON.parse(text || '{}');
        if (resp.ret !== undefined && resp.ret !== 0) {
            throw new Error(`sendMessage ret=${resp.ret}`);
        }
        if (resp.errcode !== undefined && resp.errcode !== 0) {
            throw new Error(`sendMessage errcode=${resp.errcode}`);
        }
    }
    // -------------------------------------------------------------------------
    // getUploadUrl — pre-signed CDN upload URL
    // -------------------------------------------------------------------------
    /** Get a pre-signed CDN upload URL for media. */
    async getUploadUrl(req) {
        const text = await this.apiFetch({
            endpoint: 'ilink/bot/getuploadurl',
            body: { ...req, base_info: buildBaseInfo() },
            timeoutMs: this.timeoutMs,
            label: 'getUploadUrl',
        });
        return JSON.parse(text);
    }
    // -------------------------------------------------------------------------
    // sendTyping
    // -------------------------------------------------------------------------
    /** Send a typing indicator to a user. */
    async sendTyping(req) {
        await this.apiFetch({
            endpoint: 'ilink/bot/sendtyping',
            body: { ...req, base_info: buildBaseInfo() },
            timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
            label: 'sendTyping',
        });
    }
    // -------------------------------------------------------------------------
    // getConfig
    // -------------------------------------------------------------------------
    /** Fetch bot config (typing_ticket) for a given user. */
    async getConfig(ilinkUserId, contextToken) {
        const text = await this.apiFetch({
            endpoint: 'ilink/bot/getconfig',
            body: {
                ilink_user_id: ilinkUserId,
                context_token: contextToken,
                base_info: buildBaseInfo(),
            },
            timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
            label: 'getConfig',
        });
        return JSON.parse(text);
    }
    // -------------------------------------------------------------------------
    // Internal fetch wrapper
    // -------------------------------------------------------------------------
    async apiFetch(params) {
        const url = new URL(params.endpoint, this.baseUrl);
        const bodyStr = JSON.stringify(params.body);
        const headers = buildHeaders({ token: this.token, body: bodyStr });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), params.timeoutMs);
        try {
            const res = await ilinkFetch(url.toString(), {
                method: 'POST',
                headers,
                body: bodyStr,
                signal: controller.signal,
            });
            clearTimeout(timer);
            const rawText = await res.text();
            if (!res.ok) {
                throw new Error(`${params.label} ${res.status}: ${rawText}`);
            }
            return rawText;
        }
        catch (err) {
            clearTimeout(timer);
            throw err;
        }
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ensureTrailingSlash(url) {
    return url.endsWith('/') ? url : `${url}/`;
}
function buildBaseInfo() {
    return buildIlinkBaseInfo();
}
/** X-WECHAT-UIN header: random uint32 → decimal string → base64. */
function randomWechatUin() {
    const uint32 = crypto.randomBytes(4).readUInt32BE(0);
    return Buffer.from(String(uint32), 'utf-8').toString('base64');
}
function buildHeaders(opts) {
    const headers = {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        // Chromium transport computes Content-Length and rejects a manual value.
        'X-WECHAT-UIN': randomWechatUin(),
        ...buildIlinkCommonHeaders(),
    };
    if (opts.token?.trim()) {
        headers.Authorization = `Bearer ${opts.token.trim()}`;
    }
    return headers;
}
//# sourceMappingURL=ilink-client.js.map