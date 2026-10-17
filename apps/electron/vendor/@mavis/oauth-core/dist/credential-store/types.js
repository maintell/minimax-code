import { MCODE_OAUTH_AUDIENCE, MCODE_OAUTH_CLIENT_ID, MCODE_OAUTH_SCOPES } from '../contracts.js';
export const CREDENTIAL_SCHEMA_VERSION = 1;
export const CREDENTIAL_MIN_SUPPORTED_SCHEMA_VERSION = 1;
export class CredentialRecordCorruptError extends Error {
    code = 'CREDENTIAL_RECORD_CORRUPT';
    constructor() {
        super('The stored OAuth credential record is invalid.');
        this.name = 'CredentialRecordCorruptError';
    }
}
export class CredentialStorePermissionError extends Error {
    code = 'AUTH_CREDENTIAL_STORE_PERMISSION';
    constructor() {
        super('The OAuth credential file permissions are not private.');
        this.name = 'CredentialStorePermissionError';
    }
}
function isOptionalString(value) {
    return value === undefined || typeof value === 'string';
}
export function parseStoredCredential(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CredentialRecordCorruptError();
    }
    const candidate = value;
    const scopes = candidate.scopes;
    const validScopes = Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string');
    const valid = typeof candidate.schemaVersion === 'number' &&
        Number.isInteger(candidate.schemaVersion) &&
        candidate.schemaVersion >= CREDENTIAL_MIN_SUPPORTED_SCHEMA_VERSION &&
        candidate.schemaVersion <= CREDENTIAL_SCHEMA_VERSION &&
        typeof candidate.accessToken === 'string' &&
        candidate.accessToken.length > 0 &&
        typeof candidate.refreshToken === 'string' &&
        candidate.refreshToken.length > 0 &&
        candidate.tokenType === 'Bearer' &&
        candidate.clientId === MCODE_OAUTH_CLIENT_ID &&
        validScopes &&
        candidate.audience === MCODE_OAUTH_AUDIENCE &&
        typeof candidate.expiresAtMs === 'number' &&
        Number.isFinite(candidate.expiresAtMs) &&
        Number.isSafeInteger(candidate.generation) &&
        candidate.generation >= 0 &&
        isOptionalString(candidate.subject) &&
        isOptionalString(candidate.accountId) &&
        isOptionalString(candidate.loginEpoch);
    if (!valid)
        throw new CredentialRecordCorruptError();
    return candidate;
}
//# sourceMappingURL=types.js.map