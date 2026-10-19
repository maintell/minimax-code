import { MCodeOAuthCore } from './auth-core.js';
import { createCredentialStore } from './credential-store/factory.js';
import { createAuthNamespace } from './namespace.js';
import { migrateLegacyAuthNamespace } from './namespace-migration.js';
import { HttpOAuthClient } from './oauth-client.js';
import { createAuthManager, createTokenProvider, } from './token-provider.js';
export function createMCodeTokenProvider(options) {
    return createTokenProvider(createCore(options));
}
export function createMCodeAuthManager(options) {
    return createAuthManager(createCore(options));
}
function createCore(options) {
    const namespace = createAuthNamespace(options);
    return new MCodeOAuthCore({
        namespace,
        credentialStore: createCredentialStore({ authHome: namespace.namespaceHome }),
        oauthClient: new HttpOAuthClient({ ...options.endpoints, fetchImpl: options.fetchImpl }),
        initialize: () => migrateLegacyAuthNamespace(namespace),
    });
}
//# sourceMappingURL=factory.js.map