/**
 * In-memory authorization attempts (plan §5.3). PKCE verifier, state, registration and the
 * discovery snapshot never leave process memory; at most one attempt exists per credential key.
 */
import { randomBytes, randomUUID } from 'node:crypto';
export const ATTEMPT_TIMEOUT_MS = 10 * 60_000;
export function deferred() {
    let resolve;
    const promise = new Promise((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
export function newAttemptSecrets() {
    return { id: randomUUID(), state: randomBytes(32).toString('base64url') };
}
export class AttemptRegistry {
    byId = new Map();
    byKey = new Map();
    byState = new Map();
    add(attempt) {
        this.byId.set(attempt.id, attempt);
        this.byKey.set(attempt.credentialKey, attempt);
        this.byState.set(attempt.state, attempt);
    }
    get(id) {
        return this.byId.get(id);
    }
    forKey(credentialKey) {
        return this.byKey.get(credentialKey);
    }
    forState(state) {
        return this.byState.get(state);
    }
    all() {
        return [...this.byId.values()];
    }
    /** Removes the attempt everywhere so late callbacks for it are rejected as unknown state. */
    remove(attempt) {
        if (this.byId.get(attempt.id) !== attempt)
            return false;
        this.byId.delete(attempt.id);
        if (this.byKey.get(attempt.credentialKey) === attempt)
            this.byKey.delete(attempt.credentialKey);
        if (this.byState.get(attempt.state) === attempt)
            this.byState.delete(attempt.state);
        clearTimeout(attempt.timer);
        attempt.lease.release();
        return true;
    }
}
/** Callback URL belongs to this attempt: same redirect path and port, matching state. */
export function callbackMatches(attempt, url, listenPort) {
    const redirect = new URL(attempt.redirectUri);
    const port = listenPort ?? Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return (url.searchParams.get('state') === attempt.state &&
        url.pathname === attempt.callbackPath &&
        port === Number(redirect.port || attempt.lease.port));
}
/**
 * RFC 9207 decision table, then the authorization response itself. `error_description` is never
 * read; only a sanitised OAuth error code is kept.
 */
export function evaluateCallback(attempt, params) {
    const iss = params.get('iss');
    const issSupported = attempt.discovery.metadata.authorization_response_iss_parameter_supported === true;
    if (iss !== null ? iss !== attempt.discovery.issuer : issSupported) {
        return { ok: false, errorCode: 'MCP_OAUTH_ISSUER_MISMATCH' };
    }
    const error = params.get('error');
    if (error !== null) {
        const oauthError = /^[\w.-]{1,64}$/.test(error) ? error : 'invalid_response';
        return { ok: false, errorCode: 'MCP_OAUTH_ACCESS_DENIED', oauthError };
    }
    const code = params.get('code');
    if (!code)
        return { ok: false, errorCode: 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED' };
    return { ok: true, code };
}
//# sourceMappingURL=attempts.js.map