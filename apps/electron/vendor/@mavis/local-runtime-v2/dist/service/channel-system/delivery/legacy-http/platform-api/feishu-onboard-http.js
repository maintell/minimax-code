/**
 * Feishu onboarding OAuth/device-code HTTP client.
 *
 * Migration copy (MR2) of v1 `channels/feishu-onboard-http.ts`, unchanged
 * except imports (session helpers now live in transport/feishu). Kept under
 * `delivery/legacy-http/` because it is consumed only by the onboarding
 * facade; permanent since MR3.
 */
import { isPendingText, parseJsonObject, readNumber, readPositiveNumber, readRecord, readString, } from '../../../transport/feishu/feishu-onboard-session.js';
export class LocalFeishuOnboardHttpClient {
    fetchImpl;
    accountsBaseUrl;
    openApiBaseUrl;
    constructor(options) {
        this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
        this.accountsBaseUrl = (options.accountsBaseUrl ?? 'https://accounts.feishu.cn').replace(/\/$/u, '');
        this.openApiBaseUrl = (options.openApiBaseUrl ?? 'https://open.feishu.cn').replace(/\/$/u, '');
    }
    async beginAppRegistration() {
        const begin = await this.postRegistration({
            action: 'begin',
            archetype: 'PersonalAgent',
            auth_method: 'client_secret',
            request_user_info: 'open_id tenant_brand',
        });
        if (!begin.ok)
            return begin;
        const deviceCode = readString(begin.data, 'device_code');
        const userCode = readString(begin.data, 'user_code');
        const verificationUriComplete = readString(begin.data, 'verification_uri_complete') ??
            (userCode
                ? `${this.openApiBaseUrl}/page/launcher?user_code=${encodeURIComponent(userCode)}`
                : readString(begin.data, 'verification_uri'));
        if (!deviceCode || !verificationUriComplete) {
            return { ok: false, error: 'app registration device_code or verification_uri missing' };
        }
        return {
            ok: true,
            deviceCode,
            verificationUriComplete,
            ...(userCode ? { userCode } : {}),
            expiresInSec: readPositiveNumber(begin.data, 'expires_in') ?? 300,
            intervalSec: readPositiveNumber(begin.data, 'interval') ?? 5,
        };
    }
    async pollAppRegistration(deviceCode) {
        const poll = await this.postRegistration({ action: 'poll', device_code: deviceCode });
        if (!poll.ok)
            return isPendingText(poll.error) ? { ok: true, pending: true } : poll;
        const appId = readString(poll.data, 'client_id');
        const appSecret = readString(poll.data, 'client_secret');
        return appId && appSecret
            ? { ok: true, pending: false, appId, appSecret }
            : { ok: true, pending: true };
    }
    async beginUserDeviceCode(appId) {
        const body = await this.postForm(`${this.openApiBaseUrl}/open-apis/authen/v1/oidc/device_code`, {
            app_id: appId,
            scope: 'im:message contact:user.id:readonly',
        });
        if (!body.ok)
            return body;
        const deviceCode = readString(body.data, 'device_code');
        const verificationUriComplete = readString(body.data, 'verification_uri_complete') ??
            readString(body.data, 'verification_uri');
        if (!deviceCode || !verificationUriComplete) {
            return { ok: false, error: 'user device_code or verification_uri missing' };
        }
        const userCode = readString(body.data, 'user_code');
        return {
            ok: true,
            deviceCode,
            verificationUriComplete,
            ...(userCode ? { userCode } : {}),
            expiresInSec: readPositiveNumber(body.data, 'expires_in') ?? 300,
            intervalSec: readPositiveNumber(body.data, 'interval') ?? 5,
        };
    }
    async pollUserToken(session) {
        const body = await this.postForm(`${this.openApiBaseUrl}/open-apis/authen/v1/oidc/device_token`, {
            app_id: session.appId ?? '',
            app_secret: session.appSecret ?? '',
            device_code: session.userDeviceCode ?? '',
        });
        if (!body.ok)
            return isPendingText(body.error) ? { ok: true, pending: true } : body;
        const payload = readRecord(body.data, 'data') ?? body.data;
        const accessToken = readString(payload, 'access_token');
        if (!accessToken)
            return { ok: true, pending: true };
        const openId = readString(payload, 'open_id');
        const name = readString(payload, 'name');
        return { ok: true, pending: false, ...(openId ? { openId } : {}), ...(name ? { name } : {}) };
    }
    postRegistration(fields) {
        return this.postForm(`${this.accountsBaseUrl}/oauth/v1/app/registration`, fields);
    }
    async postForm(url, fields) {
        const response = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
        });
        let text = '';
        try {
            text = await response.text();
        }
        catch {
            // Body read failure degrades to an empty payload; the status check
            // below still reports the HTTP failure.
        }
        const data = parseJsonObject(text);
        if (!response.ok)
            return { ok: false, error: text || `HTTP ${response.status}` };
        if (readString(data, 'error') && readString(data, 'error') !== 'authorization_pending') {
            return { ok: false, error: readString(data, 'error') ?? 'request failed' };
        }
        const code = readNumber(data, 'code');
        if (code !== undefined && code !== 0) {
            return { ok: false, error: readString(data, 'msg') ?? `code ${code}` };
        }
        return { ok: true, data };
    }
}
//# sourceMappingURL=feishu-onboard-http.js.map