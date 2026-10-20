import { createHash } from 'node:crypto';
import { record } from './projection.js';
const MATRIX_ORIGINS = {
    cn: {
        prod: 'https://agent.minimax.cn',
        staging: 'https://matrix-pre.xaminim.com',
        test: 'https://matrix-test.xaminim.com',
        dev: 'https://matrix-test.xaminim.com',
    },
    en: {
        prod: 'https://agent.minimax.io',
        staging: 'https://matrix-overseas-pre.xaminim.com',
        test: 'https://matrix-overseas-test.xaminim.com',
        dev: 'https://matrix-overseas-test.xaminim.com',
    },
};
const OPEN_PLATFORM_ORIGINS = {
    cn: {
        prod: 'https://www.minimaxi.com',
        staging: 'https://open-platform-for-online-test.xaminim.com',
        test: 'https://openplatform-test.xaminim.com',
        dev: 'https://openplatform-test.xaminim.com',
    },
    en: {
        prod: 'https://platform.minimax.io',
        staging: 'https://mmx-pre.xaminim.com',
        test: 'https://mmx-test.xaminim.com',
        dev: 'https://mmx-test.xaminim.com',
    },
};
/** 只负责账户只读请求；响应与鉴权内容不进入诊断。 */
export class MemoryQuotaTransport {
    options;
    constructor(options) {
        this.options = options;
    }
    async matrix(context, path, payload) {
        const now = this.options.nowMs();
        const url = new URL(path, MATRIX_ORIGINS[context.region][context.buildEnv]);
        const language = context.region === 'cn' ? 'zh' : 'en';
        url.search = new URLSearchParams({
            device_platform: 'web',
            biz_id: '3',
            app_id: '3001',
            version_code: '22201',
            unix: String(now),
            timezone_offset: String(new Date(now).getTimezoneOffset() * -60),
            sys_language: language,
            lang: language,
            device_id: '0',
            user_id: context.auth.realUserID ?? '0',
            client: 'desktop',
            region: context.region,
            is_desktop: '1',
        }).toString();
        const body = payload === undefined ? '' : JSON.stringify(payload);
        const second = Math.floor(now / 1000);
        return this.request(url, {
            method: payload === undefined ? 'GET' : 'POST',
            headers: {
                ...context.routingHeaders,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${context.auth.accessToken}`,
                yy: md5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_${body || '{}'}${md5(String(now))}ooui`),
                'x-timestamp': String(second),
                'x-signature': md5(`${second}I*7Cf%WZ#S&%1RlZJ&C2${body}`),
            },
            ...(body ? { body } : {}),
        });
    }
    async remains(context, groupId) {
        const origin = OPEN_PLATFORM_ORIGINS[context.region][context.buildEnv];
        return this.request(new URL('/v1/api/openplatform/coding_plan/remains', origin), {
            method: 'GET',
            headers: {
                ...context.routingHeaders,
                Accept: 'application/json',
                Authorization: `Bearer ${context.auth.accessToken}`,
                'X-Group-Id': groupId,
            },
        });
    }
    async request(url, init) {
        const response = await this.options.fetchImpl(url, {
            ...init,
            signal: AbortSignal.timeout(3000),
        });
        if (!response.ok)
            throw new Error('quota-http-unavailable');
        const body = record(await response.json());
        if (!body)
            throw new Error('quota-response-invalid');
        const code = record(body.statusInfo)?.code ?? record(body.base_resp)?.status_code;
        if (code !== undefined && code !== 0)
            throw new Error('quota-business-unavailable');
        return body;
    }
}
function md5(value) {
    return createHash('md5').update(value).digest('hex');
}
//# sourceMappingURL=transport.js.map