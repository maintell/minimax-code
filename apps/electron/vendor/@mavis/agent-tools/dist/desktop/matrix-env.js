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
export function normalizeMatrixBaseUrl(value) {
    return value.trim().replace(/\/+$/u, '');
}
export function getDesktopMatrixEndpoint(env = process.env) {
    const override = env.MATRIX_BASE_URL?.trim();
    const baseUrl = override ? normalizeMatrixBaseUrl(override) : getManagedDesktopMatrixBaseUrl(env);
    const managed = isManagedMatrixBaseUrl(baseUrl);
    const explicitToken = managed ? undefined : env.MATRIX_TOKEN?.trim();
    return {
        baseUrl,
        managed,
        ...(explicitToken ? { explicitToken } : {}),
    };
}
export function getManagedDesktopMatrixBaseUrl(env = process.env) {
    return MANAGED_MATRIX_BASE_URLS[normalizeRegion(env.MAVIS_REGION)][normalizeBuildEnv(env.MAVIS_BUILD_ENV)];
}
export function isManagedMatrixBaseUrl(baseUrl) {
    const normalized = normalizeMatrixBaseUrl(baseUrl);
    if (LEGACY_MANAGED_MATRIX_BASE_URLS.has(normalized))
        return true;
    return Object.values(MANAGED_MATRIX_BASE_URLS).some((byEnv) => Object.values(byEnv).some((managedBaseUrl) => normalizeMatrixBaseUrl(managedBaseUrl) === normalized));
}
function normalizeRegion(value) {
    return value === 'cn' ? 'cn' : 'en';
}
function normalizeBuildEnv(value) {
    if (value === 'dev' || value === 'test' || value === 'staging' || value === 'prod') {
        return value;
    }
    return 'dev';
}
//# sourceMappingURL=matrix-env.js.map