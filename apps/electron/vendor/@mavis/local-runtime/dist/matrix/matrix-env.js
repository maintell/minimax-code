import { getRuntimeBuildEnv, getRuntimeRegion, } from '@mavis/config';
const MANAGED_MATRIX_BASE_URLS = {
    cn: {
        dev: 'https://matrix-test.xaminim.com',
        test: 'https://matrix-test.xaminim.com',
        staging: 'https://matrix-pre.xaminim.com',
        prod: 'https://agent.minimax.cn',
    },
    en: {
        dev: 'https://matrix-overseas-test.xaminim.com',
        test: 'https://matrix-overseas-test.xaminim.com',
        staging: 'https://matrix-overseas-pre.xaminim.com',
        prod: 'https://agent.minimax.io',
    },
};
const LEGACY_MANAGED_MATRIX_BASE_URLS = new Set(['https://agent.minimaxi.com']);
const EXPLICIT_MATRIX_TOKEN_ENV_KEYS = ['MATRIX_TOKEN'];
function normalizeRegion(value, env) {
    if (value === 'cn' || value === 'en')
        return value;
    const locale = env.NEXT_PUBLIC_LOCALE;
    if (locale === 'zh')
        return 'cn';
    if (locale === 'en')
        return 'en';
    return getRuntimeRegion();
}
function normalizeBuildEnv(value, env) {
    if (value === 'dev' || value === 'test' || value === 'prod' || value === 'staging') {
        return value;
    }
    const nextBuildEnv = env.NEXT_PUBLIC_BUILD_ENV;
    if (nextBuildEnv === 'dev' || nextBuildEnv === 'test')
        return 'test';
    if (nextBuildEnv === 'staging' || nextBuildEnv === 'prod')
        return nextBuildEnv;
    return getRuntimeBuildEnv();
}
export function normalizeMatrixBaseUrl(value) {
    return value.trim().replace(/\/+$/u, '');
}
export function getManagedLocalMatrixBaseUrl(env = process.env) {
    return MANAGED_MATRIX_BASE_URLS[normalizeRegion(env.MAVIS_REGION, env)][normalizeBuildEnv(env.MAVIS_BUILD_ENV, env)];
}
export function getLocalMatrixEndpoint(env = process.env) {
    const override = env.MATRIX_BASE_URL?.trim();
    const baseUrl = override ? normalizeMatrixBaseUrl(override) : getManagedLocalMatrixBaseUrl(env);
    const managed = isManagedMatrixBaseUrl(baseUrl);
    const explicitToken = managed ? undefined : getExplicitMatrixToken(env);
    return {
        baseUrl,
        managed,
        ...(explicitToken ? { explicitToken } : {}),
    };
}
export function getLocalMatrixBaseUrl(env = process.env) {
    return getLocalMatrixEndpoint(env).baseUrl;
}
export function isManagedMatrixBaseUrl(baseUrl) {
    const normalized = normalizeMatrixBaseUrl(baseUrl);
    if (LEGACY_MANAGED_MATRIX_BASE_URLS.has(normalized))
        return true;
    return Object.values(MANAGED_MATRIX_BASE_URLS).some((byEnv) => Object.values(byEnv).some((managedBaseUrl) => normalizeMatrixBaseUrl(managedBaseUrl) === normalized));
}
function getExplicitMatrixToken(env) {
    for (const key of EXPLICIT_MATRIX_TOKEN_ENV_KEYS) {
        const value = env[key]?.trim();
        if (value)
            return value;
    }
    return undefined;
}
//# sourceMappingURL=matrix-env.js.map