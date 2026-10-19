const ACCOUNT_ORIGINS = {
    cn: {
        dev: 'https://account-test.xaminim.com',
        test: 'https://account-test.xaminim.com',
        staging: 'https://account-pre.xaminim.com',
        prod: 'https://account.minimax.cn',
    },
    en: {
        dev: 'https://account-overseas-test.xaminim.com',
        test: 'https://account-overseas-test.xaminim.com',
        staging: 'https://account-overseas-pre.xaminim.com',
        prod: 'https://account.minimax.io',
    },
};
export function resolveMCodeOAuthEndpointConfig(environment, context) {
    const configuredValues = [
        environment.MCODE_OAUTH_DEVICE_AUTHORIZATION_ENDPOINT,
        environment.MCODE_OAUTH_TOKEN_ENDPOINT,
        environment.MCODE_OAUTH_REVOCATION_ENDPOINT,
    ];
    if (configuredValues.every((value) => !value?.trim())) {
        const accountOrigin = ACCOUNT_ORIGINS[context.region][context.buildEnv];
        return {
            deviceAuthorizationEndpoint: `${accountOrigin}/oauth2/device/code`,
            ...deviceAuthorizationRequestConfig(context.buildEnv),
            tokenEndpoint: `${accountOrigin}/oauth2/token`,
            revocationEndpoint: `${accountOrigin}/oauth2/revoke`,
        };
    }
    const deviceAuthorizationEndpoint = readHttpsEndpoint(environment.MCODE_OAUTH_DEVICE_AUTHORIZATION_ENDPOINT);
    const tokenEndpoint = readHttpsEndpoint(environment.MCODE_OAUTH_TOKEN_ENDPOINT);
    const revocationEndpoint = readHttpsEndpoint(environment.MCODE_OAUTH_REVOCATION_ENDPOINT);
    if (!deviceAuthorizationEndpoint || !tokenEndpoint || !revocationEndpoint) {
        throw new TypeError('Shared MCode OAuth requires all three public OAuth endpoints to be configured.');
    }
    return {
        deviceAuthorizationEndpoint,
        ...deviceAuthorizationRequestConfig(context.buildEnv),
        tokenEndpoint,
        revocationEndpoint,
    };
}
function deviceAuthorizationRequestConfig(buildEnv) {
    return buildEnv === 'staging' ? { deviceAuthorizationHeaders: { 'X-User-Pre': '1' } } : {};
}
function readHttpsEndpoint(value) {
    if (!value?.trim())
        return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.hash)
            return undefined;
        return url.toString();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=endpoint-config.js.map