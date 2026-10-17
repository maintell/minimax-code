import { MCODE_OAUTH_SCOPES, } from './contracts.js';
export function createTokenProvider(core) {
    return Object.freeze({
        getStatus: () => core.getStatus(),
        getAccessToken: (options) => core.getAccessToken({
            requiredScopes: [...MCODE_OAUTH_SCOPES],
            minValidityMs: options.minValidityMs,
        }),
        handleUnauthorized: (context) => core.handleUnauthorized(context),
    });
}
export function createAuthManager(core) {
    const provider = createTokenProvider(core);
    return Object.freeze({
        ...provider,
        login: (options) => core.login(options),
        cancelLogin: () => core.cancelLogin(),
        logout: (options) => core.logout(options),
        watch: (listener) => core.watch(listener),
    });
}
//# sourceMappingURL=token-provider.js.map