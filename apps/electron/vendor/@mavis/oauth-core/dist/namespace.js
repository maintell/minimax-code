import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { MCODE_OAUTH_CLIENT_ID } from './contracts.js';
export function createAuthNamespace(input) {
    const authHome = join(resolve(input.dataDir), 'auth');
    const namespaceHome = join(authHome, input.buildEnv, input.region, MCODE_OAUTH_CLIENT_ID);
    const service = `com.minimax.mcode.oauth.${input.buildEnv}.${input.region}`;
    const account = createHash('sha256')
        .update(`${authHome}\0${MCODE_OAUTH_CLIENT_ID}`)
        .digest('base64url');
    return {
        authHome,
        namespaceHome,
        lockPath: join(namespaceHome, 'auth.lock'),
        statePath: join(namespaceHome, 'auth-state.json'),
        credentialPath: join(namespaceHome, 'auth.json'),
        legacyLockPath: join(authHome, 'auth.lock'),
        legacyStatePath: join(authHome, 'auth-state.json'),
        legacyEncryptedCredentialPath: join(authHome, 'credentials.enc'),
        buildEnv: input.buildEnv,
        region: input.region,
        credentialKey: { service, account },
    };
}
//# sourceMappingURL=namespace.js.map