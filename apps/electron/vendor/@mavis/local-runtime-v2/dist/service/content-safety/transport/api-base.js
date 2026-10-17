const SAFETY_API_BASE = {
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
export function resolveSafetyApiBase(region, buildEnv, testBaseURL) {
    if (buildEnv === 'test' && testBaseURL && isLoopbackHttpURL(testBaseURL)) {
        return testBaseURL.replace(/\/+$/u, '');
    }
    return SAFETY_API_BASE[region][buildEnv];
}
function isLoopbackHttpURL(value) {
    if (!value)
        return false;
    try {
        const url = new URL(value);
        return ((url.protocol === 'http:' || url.protocol === 'https:') &&
            (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'));
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=api-base.js.map