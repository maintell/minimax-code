import { createHash } from "node:crypto";
export class DesktopAccountIdentityUnauthorizedError extends Error {
    constructor() {
        super('Desktop account identity rejected the access token.');
        this.name = 'DesktopAccountIdentityUnauthorizedError';
    }
}

/** Main-only profile lookup, bound to the exact bearer used for the request. */
export function createDesktopAccountIdentitySource(options) {
    let cached;
    let pending;
    let revision = 0;
    return {
        apply: options.apply,
        invalidate() {
            revision += 1;
            cached = undefined;
            pending = undefined;
        },
        async resolve(lease) {
            const token = lease.accessToken;
            if (cached?.token === token)
                return cached.identity;
            if (pending?.token === token)
                return pending.promise;
            const legacyCompatible = 'mode' in lease && lease.mode === 'legacy-compatible';
            const startedAtRevision = revision;
            const promise = fetchIdentity(token, options, legacyCompatible).then((identity) => startedAtRevision === revision ? identity : this.resolve(lease));
            pending = { token, promise };
            try {
                const identity = await promise;
                if (pending?.promise === promise)
                    cached = { token, identity };
                return identity;
            }
            finally {
                if (pending?.promise === promise)
                    pending = undefined;
            }
        },
    };
}
async function fetchIdentity(accessToken, options, legacyCompatible) {
    const requestTime = Date.now();
    const url = new URL('/v1/api/user/info', options.origin);
    url.search = new URLSearchParams({
        device_platform: 'mcode',
        biz_id: '3',
        app_id: '3001',
        version_code: '22201',
        unix: String(requestTime),
        timezone_offset: String(new Date().getTimezoneOffset() * -60),
        sys_language: options.language,
        lang: options.language,
        device_id: '0',
        os_name: process.platform,
        browser_name: 'mcode',
        user_id: '0',
        client: 'mcode',
    }).toString();
    const second = Math.floor(requestTime / 1000);
    const response = await options.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'MiniMaxCode',
            ...options.routingHeaders?.(),
            Authorization: `Bearer ${accessToken}`,
            // The generation-0 SSO fallback still uses the product's legacy header.
            ...(legacyCompatible ? { token: accessToken } : {}),
            yy: md5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_{}${md5(String(requestTime))}ooui`),
            'x-timestamp': String(second),
            'x-signature': md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2`),
        },
        signal: AbortSignal.timeout(3000),
    });
    if (response.status === 401)
        throw new DesktopAccountIdentityUnauthorizedError();
    if (!response.ok)
        throw new Error(`Desktop account identity unavailable (HTTP ${response.status}).`);
    const body = record(await response.json());
    const status = record(body?.statusInfo);
    if (status?.code === 1000048)
        throw new DesktopAccountIdentityUnauthorizedError();
    if (status?.code !== undefined && status.code !== 0) {
        throw new Error('Desktop account identity request was rejected.');
    }
    const baseResponse = record(body?.base_resp);
    if (baseResponse?.status_code !== undefined && baseResponse.status_code !== 0) {
        throw new Error('Desktop account identity request was rejected.');
    }
    const data = record(body?.data);
    const user = record(data?.userInfo ?? data?.user_info ?? body?.userInfo ?? body?.user_info);
    const realUserID = field(user, 'realUserID', 'real_user_id');
    if (!realUserID)
        throw new Error('Desktop account identity response has no user ID.');
    return {
        userID: field(user, 'userID', 'user_id'),
        realUserID,
        userEmail: field(user, 'email', 'userMail', 'user_email'),
        userName: field(user, 'name', 'userName', 'user_name'),
        subUserName: field(user, 'subUserName', 'sub_user_name'),
    };
}
function field(value, ...keys) {
    for (const key of keys) {
        const candidate = value?.[key];
        if (typeof candidate === 'string' && candidate.trim())
            return candidate.trim();
    }
    return undefined;
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function md5(value) {
    return createHash('md5').update(value).digest('hex');
}
