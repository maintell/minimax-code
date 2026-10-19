import { readFile } from 'node:fs/promises';
import { atomicWritePrivateFile } from './fs/atomic-write.js';
export const AUTH_STATE_SCHEMA_VERSION = 2;
export const AUTH_STATE_MIN_SUPPORTED_SCHEMA_VERSION = 1;
const SENSITIVE_KEY_PATTERN = /access[_-]?token|refresh[_-]?token|device[_-]?code|code[_-]?verifier/iu;
function assertNoSensitiveKeys(value) {
    if (typeof value !== 'object' || value === null)
        return;
    for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            throw new TypeError('Sensitive OAuth fields cannot be persisted in auth-state.json.');
        }
        assertNoSensitiveKeys(child);
    }
}
function parseState(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError('Invalid OAuth state.');
    }
    const state = value;
    const valid = typeof state.schemaVersion === 'number' &&
        Number.isInteger(state.schemaVersion) &&
        state.schemaVersion >= AUTH_STATE_MIN_SUPPORTED_SCHEMA_VERSION &&
        state.schemaVersion <= AUTH_STATE_SCHEMA_VERSION &&
        [
            'anonymous',
            'authorizing',
            'authenticated',
            'refreshing',
            'scope_upgrade_required',
            'logging_out',
            'logout_pending',
            'expired',
            'error',
        ].includes(state.status) &&
        ((state.schemaVersion === 1 &&
            (state.storeKind === 'os-keyring' || state.storeKind === 'file')) ||
            (state.schemaVersion === AUTH_STATE_SCHEMA_VERSION && state.storeKind === 'file')) &&
        state.clientId === 'mcode-public' &&
        Array.isArray(state.scopes) &&
        state.scopes.every((scope) => typeof scope === 'string') &&
        state.audience === 'agent-backend' &&
        isOptionalAuthScope(state.buildEnv, state.region) &&
        (state.expiresAtMs === undefined ||
            (typeof state.expiresAtMs === 'number' && Number.isFinite(state.expiresAtMs))) &&
        Number.isSafeInteger(state.generation) &&
        state.generation >= 0 &&
        (state.authorization === undefined || isAuthorizationLease(state.authorization));
    if (!valid)
        throw new TypeError('Invalid OAuth state.');
    assertNoSensitiveKeys(state);
    return state;
}
function isOptionalAuthScope(buildEnv, region) {
    if (buildEnv === undefined && region === undefined)
        return true;
    return ((buildEnv === 'dev' || buildEnv === 'test' || buildEnv === 'staging' || buildEnv === 'prod') &&
        (region === 'cn' || region === 'en'));
}
function isAuthorizationLease(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const lease = value;
    return (typeof lease.leaseId === 'string' &&
        lease.leaseId.length > 0 &&
        typeof lease.leaseExpiresAtMs === 'number' &&
        Number.isFinite(lease.leaseExpiresAtMs) &&
        isOptionalString(lease.userCode) &&
        isOptionalString(lease.verificationUri) &&
        isOptionalString(lease.verificationUriComplete));
}
function isOptionalString(value) {
    return value === undefined || typeof value === 'string';
}
export class AuthStateStore {
    path;
    constructor(path) {
        this.path = path;
    }
    async read() {
        let raw;
        try {
            raw = await readFile(this.path, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
        try {
            return parseState(JSON.parse(raw));
        }
        catch (error) {
            if (error instanceof TypeError)
                throw error;
            throw new TypeError('Invalid OAuth state.');
        }
    }
    async write(state) {
        const validated = parseState(state);
        await atomicWritePrivateFile(this.path, `${JSON.stringify(validated, null, 2)}\n`);
    }
}
//# sourceMappingURL=state-store.js.map