import { createHash, randomBytes } from 'node:crypto';
import { MCODE_OAUTH_AUDIENCE, MCODE_OAUTH_CLIENT_ID, MCODE_OAUTH_SCOPES } from './contracts.js';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
export class OAuthProtocolError extends Error {
    code;
    httpStatus;
    constructor(code, message, httpStatus) {
        super(message ??
            `The OAuth server rejected the request (${code}${httpStatus ? `, HTTP ${httpStatus}` : ''}).`);
        this.code = code;
        this.httpStatus = httpStatus;
        this.name = 'OAuthProtocolError';
    }
}
export class HttpOAuthClient {
    options;
    fetchImpl;
    sleep;
    now;
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sleep =
            options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
        this.now = options.now ?? Date.now;
    }
    async startDeviceAuthorization(options = {}) {
        const codeVerifier = randomBytes(32).toString('base64url');
        const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
        const body = await this.postForm(this.options.deviceAuthorizationEndpoint, {
            client_id: MCODE_OAUTH_CLIENT_ID,
            scope: MCODE_OAUTH_SCOPES.join(' '),
            audience: MCODE_OAUTH_AUDIENCE,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        }, {
            headers: this.options.deviceAuthorizationHeaders,
            signal: options.signal,
        });
        const userCode = readString(body, 'user_code');
        const standardDeviceCode = readString(body, 'device_code');
        const accountExpiredAtMs = readPositiveNumber(body, 'expired_in');
        const usesAccountUserCodePolling = !standardDeviceCode && Boolean(userCode) && accountExpiredAtMs !== undefined;
        const deviceCode = standardDeviceCode ?? (usesAccountUserCodePolling ? userCode : undefined);
        const verificationUri = readString(body, 'verification_uri') ?? readString(body, 'verification_url');
        const expiresInSec = readPositiveNumber(body, 'expires_in') ??
            normalizeAccountExpirySeconds(accountExpiredAtMs, this.now());
        const rawInterval = readPositiveNumber(body, 'interval');
        const intervalSec = usesAccountUserCodePolling && rawInterval !== undefined
            ? rawInterval / 1_000
            : (rawInterval ?? 5);
        if (!deviceCode || !userCode || !verificationUri || !expiresInSec) {
            throw new OAuthProtocolError('invalid_device_authorization_response');
        }
        return {
            deviceCode,
            codeVerifier,
            ...(usesAccountUserCodePolling ? { tokenPollingParameter: 'user_code' } : {}),
            userCode,
            verificationUri,
            ...(readString(body, 'verification_uri_complete') || usesAccountUserCodePolling
                ? {
                    verificationUriComplete: readString(body, 'verification_uri_complete') ?? verificationUri,
                }
                : {}),
            expiresInSec,
            intervalSec,
        };
    }
    async pollDeviceToken(authorization, options = {}) {
        const deadline = this.now() + authorization.expiresInSec * 1_000;
        let intervalMs = authorization.intervalSec * 1_000;
        while (this.now() < deadline) {
            options.signal?.throwIfAborted();
            const pollingCode = authorization.tokenPollingParameter === 'user_code'
                ? { user_code: authorization.userCode }
                : { device_code: authorization.deviceCode };
            const response = await this.postFormAllowOAuthError(this.options.tokenEndpoint, {
                grant_type: DEVICE_GRANT_TYPE,
                ...pollingCode,
                client_id: MCODE_OAUTH_CLIENT_ID,
                code_verifier: authorization.codeVerifier,
            }, { signal: options.signal });
            const pollingStatus = readString(response.body, 'status');
            if (response.ok && pollingStatus === 'pending') {
                await sleepWithSignal(this.sleep, intervalMs, options.signal);
                continue;
            }
            if (response.ok && pollingStatus === 'slow_down') {
                intervalMs += 5_000;
                await sleepWithSignal(this.sleep, intervalMs, options.signal);
                continue;
            }
            if (response.ok && (pollingStatus === 'denied' || pollingStatus === 'access_denied')) {
                throw new OAuthProtocolError('access_denied');
            }
            if (response.ok && (pollingStatus === 'expired' || pollingStatus === 'expired_token')) {
                throw new OAuthProtocolError('expired_token');
            }
            if (response.ok)
                return parseTokenGrant(response.body);
            if (response.error === 'authorization_pending') {
                await sleepWithSignal(this.sleep, intervalMs, options.signal);
                continue;
            }
            if (response.error === 'slow_down') {
                intervalMs += 5_000;
                await sleepWithSignal(this.sleep, intervalMs, options.signal);
                continue;
            }
            throw new OAuthProtocolError(response.error ?? 'device_authorization_failed', undefined, response.status);
        }
        throw new OAuthProtocolError('expired_token', 'The OAuth device authorization expired.');
    }
    async refreshToken(refreshToken) {
        const body = await this.postForm(this.options.tokenEndpoint, {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: MCODE_OAUTH_CLIENT_ID,
            scope: MCODE_OAUTH_SCOPES.join(' '),
            audience: MCODE_OAUTH_AUDIENCE,
        });
        return parseTokenGrant(body, refreshToken);
    }
    async revokeToken(refreshToken) {
        const response = await this.postFormAllowOAuthError(this.options.revocationEndpoint, {
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: MCODE_OAUTH_CLIENT_ID,
        }, { allowEmptySuccess: true });
        if (!response.ok)
            throw new OAuthProtocolError(response.error ?? 'oauth_request_failed', undefined, response.status);
    }
    async postForm(endpoint, values, options = {}) {
        const response = await this.postFormAllowOAuthError(endpoint, values, options);
        if (!response.ok)
            throw new OAuthProtocolError(response.error ?? 'oauth_request_failed', undefined, response.status);
        return response.body;
    }
    async postFormAllowOAuthError(endpoint, values, options = {}) {
        const response = await this.fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                ...options.headers,
            },
            body: new URLSearchParams(values),
            signal: options.signal,
        });
        const body = asRecord(await response.json().catch(() => undefined));
        if (!body && response.ok && options.allowEmptySuccess)
            return { ok: true, status: response.status, body: {} };
        if (!body)
            throw new OAuthProtocolError('invalid_json_response', undefined, response.status);
        const error = readString(body, 'error');
        return {
            ok: response.ok && !error,
            status: response.status,
            body,
            ...(error ? { error } : {}),
        };
    }
}
async function sleepWithSignal(sleep, durationMs, signal) {
    if (!signal) {
        await sleep(durationMs);
        return;
    }
    signal.throwIfAborted();
    let rejectAbort;
    const onAbort = () => rejectAbort(signal.reason);
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        await Promise.race([sleep(durationMs), aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
function parseTokenGrant(body, previousRefreshToken) {
    const accessToken = readString(body, 'access_token');
    const refreshToken = readString(body, 'refresh_token') ?? previousRefreshToken;
    const tokenType = readString(body, 'token_type');
    const expiresInSec = readPositiveNumber(body, 'expires_in');
    const claims = accessToken ? decodeJwtPayload(accessToken) : undefined;
    const scopes = parseScopes(body.scope ?? claims?.scope ?? claims?.scp);
    if (!accessToken ||
        !refreshToken ||
        tokenType?.toLowerCase() !== 'bearer' ||
        !expiresInSec ||
        !scopes.includes(MCODE_OAUTH_SCOPES[0])) {
        throw new OAuthProtocolError('invalid_token_response');
    }
    return {
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        scopes,
        audience: MCODE_OAUTH_AUDIENCE,
        expiresInSec,
        ...(readString(claims, 'sub') ? { subject: readString(claims, 'sub') } : {}),
        ...(readString(claims, 'account_id') ? { accountId: readString(claims, 'account_id') } : {}),
    };
}
function decodeJwtPayload(token) {
    const segments = token.split('.');
    if (segments.length !== 3 || !segments[1])
        return undefined;
    try {
        return asRecord(JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')));
    }
    catch {
        return undefined;
    }
}
function parseScopes(value) {
    if (typeof value === 'string')
        return value.split(/\s+/u).filter(Boolean);
    if (Array.isArray(value) && value.every((scope) => typeof scope === 'string'))
        return value;
    return [];
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function readString(value, key) {
    const record = asRecord(value);
    const candidate = record?.[key];
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}
function readPositiveNumber(value, key) {
    const record = asRecord(value);
    const candidate = record?.[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
        ? candidate
        : undefined;
}
function normalizeAccountExpirySeconds(expiredIn, nowMs) {
    if (expiredIn === undefined)
        return undefined;
    if (expiredIn < 1_000_000_000_000)
        return expiredIn;
    const remainingMs = expiredIn - nowMs;
    return remainingMs > 0 ? Math.ceil(remainingMs / 1_000) : undefined;
}
//# sourceMappingURL=oauth-client.js.map