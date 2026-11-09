import { exchangeAuthorization, startAuthorization, } from '@mavis/mcp/oauth';
import { ATTEMPT_TIMEOUT_MS, AttemptRegistry, callbackMatches, deferred, evaluateCallback, newAttemptSecrets, } from './attempts.js';
import { clientInformationFor, isClientRejection, oauthErrorCodeOf, StoredCredentialAuthorizer, } from './authorizer.js';
import { LoopbackCallbackServer } from './callback-server.js';
import { canonicalResourceUrl, clientFingerprint, credentialKeyFor, unionScopes, } from './canonical.js';
import { MCP_OAUTH_CIMD_CLIENT_ID, McpOAuthError, } from './contracts.js';
import { McpCredentialStore, } from './credential-store.js';
import { settleInBackground } from '../../../infra/async/settle.js';
import { asOAuthError, createGuardedFetch, discoverAuthorizationServer, stringField, } from './discovery.js';
import { CimdAvailability, prepareClient } from './registration.js';
const MCP_OAUTH_POLL_INTERVAL_MS = 15_000;
const ORPHAN_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
export function createMcpOAuthService(deps) {
    return new DefaultMcpOAuthService(deps);
}
class DefaultMcpOAuthService {
    now;
    fetchImpl;
    logger;
    store;
    callbackServer;
    cimd;
    attempts = new AttemptRegistry();
    finished = new Map();
    /** Most recent finished attempt per credential key, surfaced in state views. */
    lastAttempts = new Map();
    startQueues = new Map();
    observations = new Map();
    watches = new Map();
    listeners = new Set();
    pollIntervalMs;
    pollTimer;
    polling = false;
    closed = false;
    /** Aborts every OAuth request this service started (discovery, CIMD, DCR, token) on close. */
    lifetime = new AbortController();
    startup;
    constructor(deps) {
        this.now = deps.now ?? Date.now;
        this.fetchImpl = deps.fetchImpl ?? fetch;
        this.logger = deps.logger;
        this.pollIntervalMs = deps.pollIntervalMs ?? MCP_OAUTH_POLL_INTERVAL_MS;
        this.store = new McpCredentialStore(deps.dataDir, this.now, this.logger);
        this.callbackServer = new LoopbackCallbackServer((url, listenPort) => this.handleLoopbackCallback(url, listenPort), this.logger);
        this.cimd = new CimdAvailability(deps.cimdUrl ?? MCP_OAUTH_CIMD_CLIENT_ID, createGuardedFetch({
            fetchImpl: this.fetchImpl,
            privateNetwork: 'allow',
            signal: this.lifetime.signal,
        }), this.now);
        this.startup = this.reapUnusedCredentials();
    }
    /** Startup sweep: records unused for 90 days are deleted locally (no revocation). */
    async reapUnusedCredentials() {
        try {
            const deleted = await this.store.reapUnused(ORPHAN_MAX_AGE_MS);
            if (deleted.length > 0) {
                this.logger?.info('Removed unused MCP OAuth credentials', { count: deleted.length });
            }
        }
        catch (error) {
            this.logger?.warn('MCP OAuth orphan cleanup failed', { error: errorName(error) });
        }
    }
    credentialKey(binding) {
        return credentialKeyFor(binding);
    }
    authorizerFor(binding) {
        if (binding.staticAuthorization)
            return undefined;
        return new StoredCredentialAuthorizer({
            store: this.store,
            now: this.now,
            fetchImpl: this.fetchImpl,
            ...(this.logger ? { logger: this.logger } : {}),
            signal: this.lifetime.signal,
            clientSecretFor: (target) => this.userClientSecretFor(target),
            onRecordChanged: (target, record) => this.onAuthorizerRecordChanged(target, record),
        }, binding, this.credentialKey(binding));
    }
    async getState(binding) {
        if (binding.staticAuthorization)
            return { ...this.baseView(binding), authState: 'static' };
        const key = this.credentialKey(binding);
        const attempt = this.attempts.forKey(key);
        if (attempt) {
            return {
                ...this.baseView(binding),
                authState: 'authorizing',
                issuer: attempt.discovery.issuer,
                attemptId: attempt.id,
            };
        }
        return this.viewFor(binding, key, await this.store.read(key));
    }
    async shouldSkipBackground(binding) {
        if (binding.staticAuthorization)
            return false;
        const key = this.credentialKey(binding);
        const record = await this.store.read(key);
        const revision = record?.revision ?? 0;
        if (record?.state?.authState === 'needs_reauth') {
            if (!this.watches.has(key))
                this.watch(binding, key, revision);
            return true;
        }
        if (record?.tokens)
            return false;
        const observation = this.observationFor(binding, key);
        if (observation?.authState !== 'needs_auth' && observation?.authState !== 'needs_reauth') {
            return false;
        }
        const watch = this.watches.get(key);
        if (watch && watch.revision !== revision) {
            this.observations.delete(key);
            this.watches.delete(key);
            return false;
        }
        return true;
    }
    async markObserved(binding, outcome) {
        if (binding.staticAuthorization)
            return;
        const key = this.credentialKey(binding);
        const record = await this.store.read(key);
        if (outcome === 'connected') {
            if (record?.tokens || record?.state)
                this.observations.delete(key);
            else
                this.observations.set(key, {
                    ...this.observationScope(binding),
                    authState: 'not_required',
                });
            if (!record?.state)
                this.watches.delete(key);
            return;
        }
        this.observations.set(key, {
            ...this.observationScope(binding),
            authState: outcome.reason === 'auth_required' ? 'needs_auth' : 'needs_reauth',
            reason: outcome.reason,
            ...(outcome.challenge ? { challenge: outcome.challenge } : {}),
        });
        this.watch(binding, key, record?.revision ?? 0);
    }
    async start(binding, options) {
        if (binding.staticAuthorization) {
            return { status: 'unsupported', errorCode: 'MCP_OAUTH_STATIC_AUTHORIZATION' };
        }
        if (!/^https?:$/.test(safeUrl(binding.serverUrl)?.protocol ?? '')) {
            return { status: 'unsupported', errorCode: 'MCP_OAUTH_TRANSPORT_UNSUPPORTED' };
        }
        if (this.closed)
            return { status: 'failed', errorCode: 'MCP_OAUTH_ATTEMPT_NOT_FOUND' };
        const key = this.credentialKey(binding);
        // Serialize starts per credential key: one attempt per key, concurrent starts share it.
        const run = this.startAfter(this.startQueues.get(key), binding, key, options?.force === true);
        this.startQueues.set(key, run);
        try {
            return await run;
        }
        finally {
            if (this.startQueues.get(key) === run)
                this.startQueues.delete(key);
        }
    }
    async startAfter(previous, binding, key, force) {
        try {
            await previous;
        }
        catch {
            // The previous start reported its own outcome; this one runs regardless.
        }
        return this.startSerialized(binding, key, force);
    }
    async cancel(attemptId) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt)
            return false;
        this.finishAttempt(attempt, { outcome: 'cancelled' });
        await this.emitCurrent(attempt.binding);
        return true;
    }
    async complete(attemptId, callbackUrl) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt)
            return this.completeFinished(attemptId);
        if (attempt.consumed) {
            const { errorCode } = await attempt.settled.promise;
            return { state: await this.getState(attempt.binding), ...(errorCode ? { errorCode } : {}) };
        }
        const url = safeUrl(callbackUrl.trim());
        if (!url || !callbackMatches(attempt, url)) {
            // Not this attempt's redirect (wrong state, path or port): keep waiting for the real one.
            return {
                state: await this.getState(attempt.binding),
                errorCode: 'MCP_OAUTH_ATTEMPT_NOT_FOUND',
            };
        }
        const { errorCode } = await this.resolveCallback(attempt, url.searchParams);
        return { state: await this.getState(attempt.binding), ...(errorCode ? { errorCode } : {}) };
    }
    /** A finished attempt reports its outcome; unknown ids are an error. */
    async completeFinished(attemptId) {
        const finished = this.finished.get(attemptId);
        if (!finished)
            throw new McpOAuthError('MCP_OAUTH_ATTEMPT_NOT_FOUND');
        const state = await this.getState(finished.binding);
        if (finished.outcome === 'authorized')
            return { state };
        // Cancelled / expired attempts have no error of their own: the attempt can no longer be
        // completed, which is what ATTEMPT_NOT_FOUND tells the caller. Never infer success from
        // authState — a failed re-authorization leaves earlier credentials authorized.
        return { state, errorCode: finished.errorCode ?? 'MCP_OAUTH_ATTEMPT_NOT_FOUND' };
    }
    async clear(binding) {
        if (binding.staticAuthorization)
            return { state: await this.getState(binding), revoked: false };
        const key = this.credentialKey(binding);
        const attempt = this.attempts.forKey(key);
        if (attempt)
            this.finishAttempt(attempt, { outcome: 'cancelled' });
        const { result: removed } = await this.store.update(key, async (current) => ({
            mutation: { kind: current ? 'delete' : 'keep' },
            result: current,
        }));
        if (!removed && this.observationFor(binding, key)?.authState !== 'needs_reauth') {
            // Nothing OAuth-related to disconnect (e.g. a plain remote server): leave its state alone.
            const state = await this.getState(binding);
            if (attempt)
                this.emit(state, binding);
            return { state, revoked: false };
        }
        this.observations.set(key, { ...this.observationScope(binding), authState: 'needs_auth' });
        this.watch(binding, key, 0);
        const revoked = removed ? await this.revoke(binding, removed) : false;
        const state = await this.getState(binding);
        this.emit(state, binding);
        return { state, revoked };
    }
    async deleteCredentials(binding) {
        const key = this.credentialKey(binding);
        const attempt = this.attempts.forKey(key);
        if (attempt)
            this.finishAttempt(attempt, { outcome: 'cancelled' });
        await this.store.delete(key);
        this.forget(key);
        if (attempt)
            await this.emitCurrent(binding);
    }
    async setUserClientSecret(serverName, secret) {
        const value = secret?.trim() ? secret.trim() : undefined;
        await this.store.setClientSecret(serverName, value);
        return value !== undefined;
    }
    async hasUserClientSecret(serverName) {
        return (await this.store.getClientSecret(serverName)) !== undefined;
    }
    onStateChanged(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    async deleteNamespace(namespace) {
        const ended = this.attempts.all().filter((attempt) => attempt.binding.namespace === namespace);
        for (const attempt of ended)
            this.finishAttempt(attempt, { outcome: 'cancelled' });
        for (const key of await this.store.deleteNamespace(namespace))
            this.forget(key);
        // In-memory state of servers that never stored credentials goes too.
        for (const [key, watch] of this.watches) {
            if (watch.binding.namespace === namespace)
                this.forget(key);
        }
        for (const [key, observation] of this.observations) {
            if (observation.namespace === namespace)
                this.observations.delete(key);
        }
        for (const attempt of ended)
            await this.emitCurrent(attempt.binding);
    }
    async close() {
        this.closed = true;
        this.lifetime.abort();
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
        this.listeners.clear();
        // In-flight starts are aborted, observe `closed` and release their listener lease.
        await Promise.allSettled([...this.startQueues.values()]);
        for (const attempt of this.attempts.all())
            this.finishAttempt(attempt, { outcome: 'cancelled' });
        await this.callbackServer.close();
        await this.startup;
    }
    // ---------------------------------------------------------------------------
    // Attempts
    // ---------------------------------------------------------------------------
    async startSerialized(binding, key, force) {
        const existing = this.attempts.forKey(key);
        if (existing && !force)
            return existing.pending;
        if (existing) {
            this.finishAttempt(existing, { outcome: 'cancelled' });
            try {
                return await this.startAttempt(binding, key);
            }
            finally {
                await this.emitCurrent(binding);
            }
        }
        if (!force) {
            const state = await this.getState(binding);
            if (state.authState === 'authorized' && !state.missingScopes?.length) {
                return { status: 'already_authorized' };
            }
        }
        return this.startAttempt(binding, key);
    }
    async startAttempt(binding, key) {
        try {
            return await this.createAttempt(binding, key);
        }
        catch (error) {
            // Requests aborted by close() surface as discovery/registration errors; report the close.
            const code = this.closed
                ? 'MCP_OAUTH_ATTEMPT_NOT_FOUND'
                : asOAuthError(error, 'MCP_OAUTH_DISCOVERY_FAILED').code;
            this.logger?.warn('MCP OAuth authorization could not start', {
                target: binding.target.kind,
                errorCode: code,
            });
            return code === 'MCP_OAUTH_UNSUPPORTED'
                ? { status: 'unsupported', errorCode: code }
                : { status: 'failed', errorCode: code };
        }
    }
    async createAttempt(binding, key) {
        const record = await this.store.read(key);
        const observation = this.observationFor(binding, key);
        const fetchFn = this.oauthFetch(binding);
        const resource = canonicalResourceUrl(binding.serverUrl);
        const resourceMetadataUrl = observation?.challenge?.resourceMetadataUrl ?? record?.resourceMetadataUrl;
        const discovery = await discoverAuthorizationServer({
            binding,
            resource,
            ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
            fetchFn,
        });
        const scope = selectScope(binding, discovery, record, observation);
        this.assertOpen();
        const prepared = await prepareClient({
            binding,
            discovery,
            existing: record?.registration,
            callbackServer: this.callbackServer,
            cimd: this.cimd,
            fetchFn,
            scope,
            userClientSecret: await this.userClientSecretFor(binding),
        });
        try {
            this.assertOpen();
            const { id, state } = newAttemptSecrets();
            const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.issuer, {
                metadata: discovery.metadata,
                clientInformation: prepared.clientInformation,
                redirectUrl: prepared.redirectUri,
                ...(scope ? { scope } : {}),
                state,
                resource: new URL(resource),
            });
            const pending = {
                status: 'pending',
                attemptId: id,
                authUrl: authorizationUrl.href,
                requiresConfirmation: binding.trust === 'confirm',
                confirmation: {
                    sourceLabel: binding.sourceLabel,
                    serverOrigin: new URL(binding.serverUrl).origin,
                    issuer: discovery.issuer,
                    clientId: prepared.clientInformation.client_id,
                    authorizationHost: new URL(discovery.metadata.authorization_endpoint).host,
                },
            };
            this.assertOpen();
            const timer = setTimeout(() => settleInBackground(this.expire(id)), ATTEMPT_TIMEOUT_MS);
            timer.unref();
            this.attempts.add({
                id,
                credentialKey: key,
                binding,
                state,
                codeVerifier,
                redirectUri: prepared.redirectUri,
                callbackPath: prepared.callbackPath,
                clientInformation: prepared.clientInformation,
                registration: prepared.registration,
                discovery,
                requestedScope: scope,
                pending,
                lease: prepared.lease,
                timer,
                settled: deferred(),
                consumed: false,
            });
            return pending;
        }
        catch (error) {
            prepared.lease.release();
            throw asOAuthError(error, 'MCP_OAUTH_METADATA_INVALID');
        }
    }
    oauthFetch(binding) {
        return createGuardedFetch({
            fetchImpl: this.fetchImpl,
            privateNetwork: binding.privateNetwork,
            signal: this.lifetime.signal,
        });
    }
    /** A start racing `close()` must not leave an attempt or a callback listener behind. */
    assertOpen() {
        if (this.closed)
            throw new McpOAuthError('MCP_OAUTH_ATTEMPT_NOT_FOUND');
    }
    async handleLoopbackCallback(url, listenPort) {
        const attempt = this.attempts.forState(url.searchParams.get('state') ?? '');
        if (!attempt || attempt.consumed || !callbackMatches(attempt, url, listenPort))
            return 'invalid';
        const { errorCode } = await this.resolveCallback(attempt, url.searchParams);
        return errorCode ? 'failure' : 'success';
    }
    /** Single-use: validates, exchanges the code and commits. Never throws. */
    async resolveCallback(attempt, params) {
        attempt.consumed = true;
        try {
            const verdict = evaluateCallback(attempt, params);
            if (!verdict.ok)
                return await this.failAttempt(attempt, verdict.errorCode, verdict.oauthError);
            const { discovery, binding } = attempt;
            let tokens;
            try {
                tokens = await exchangeAuthorization(discovery.issuer, {
                    metadata: discovery.metadata,
                    clientInformation: attempt.clientInformation,
                    authorizationCode: verdict.code,
                    codeVerifier: attempt.codeVerifier,
                    redirectUri: attempt.redirectUri,
                    resource: new URL(discovery.resource),
                    fetchFn: this.oauthFetch(binding),
                });
            }
            catch (error) {
                return await this.failAttempt(attempt, exchangeErrorCode(attempt, error));
            }
            const committed = await this.commitTokens(attempt, tokens);
            return committed ? {} : { errorCode: 'MCP_OAUTH_ATTEMPT_NOT_FOUND' };
        }
        catch (error) {
            this.logger?.warn('MCP OAuth callback failed', { error: errorName(error) });
            try {
                return await this.failAttempt(attempt, 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED');
            }
            catch {
                this.finishAttempt(attempt, {
                    outcome: 'failed',
                    errorCode: 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED',
                });
                settleInBackground(this.emitCurrent(attempt.binding));
                return { errorCode: 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED' };
            }
        }
    }
    /**
     * Locked commit of tokens + registration + requestedScope + discovery snapshot. The attempt is
     * re-checked inside the lock: a cancel / clear / supersede that won the race drops the tokens.
     */
    async commitTokens(attempt, tokens) {
        const { discovery, binding } = attempt;
        const now = this.now();
        const scope = tokens.scope ?? attempt.requestedScope;
        const { result: committed } = await this.store.update(attempt.credentialKey, async () => {
            if (this.attempts.get(attempt.id) !== attempt) {
                return { mutation: { kind: 'keep' }, result: false };
            }
            return {
                mutation: {
                    kind: 'write',
                    record: {
                        ...this.identity(binding, attempt.credentialKey),
                        issuer: discovery.issuer,
                        authorizationServerMetadata: discovery.metadata,
                        ...(discovery.resourceMetadataUrl
                            ? { resourceMetadataUrl: discovery.resourceMetadataUrl }
                            : {}),
                        registration: attempt.registration,
                        tokens: {
                            access_token: tokens.access_token,
                            ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
                            ...(tokens.expires_in !== undefined
                                ? { expires_at: now + tokens.expires_in * 1000 }
                                : {}),
                            ...(scope ? { scope } : {}),
                            tokenSource: 'exchange',
                            tokenIssuedAt: now,
                        },
                        ...(attempt.requestedScope ? { requestedScope: attempt.requestedScope } : {}),
                        lastUsedAt: now,
                    },
                },
                result: true,
            };
        });
        if (!committed)
            return false;
        this.finishAttempt(attempt, { outcome: 'authorized' });
        this.forget(attempt.credentialKey);
        if (binding.target.kind !== 'project') {
            await this.deleteSupersededFingerprints(binding, attempt.credentialKey);
        }
        await this.emitCurrent(binding);
        return true;
    }
    /** Persists `failed` (unless working tokens remain), ends the attempt and notifies. */
    async failAttempt(attempt, errorCode, oauthError) {
        const failed = {
            authState: 'failed',
            reason: oauthError ?? errorCode,
            lastErrorCode: errorCode,
        };
        // Re-checked inside the lock like commitTokens: a cancel / clear that already ended the
        // attempt must not be followed by a late `failed` record.
        const { result: current } = await this.store.update(attempt.credentialKey, async (record) => {
            if (this.attempts.get(attempt.id) !== attempt) {
                return { mutation: { kind: 'keep' }, result: false };
            }
            if (record?.tokens)
                return { mutation: { kind: 'keep' }, result: true };
            return {
                mutation: {
                    kind: 'write',
                    record: {
                        ...(record ?? this.identity(attempt.binding, attempt.credentialKey)),
                        state: failed,
                        lastUsedAt: this.now(),
                    },
                },
                result: true,
            };
        });
        if (!current)
            return { errorCode };
        this.logger?.warn('MCP OAuth authorization failed', {
            target: attempt.binding.target.kind,
            errorCode,
            ...(oauthError ? { oauthError } : {}),
        });
        this.finishAttempt(attempt, { outcome: 'failed', errorCode });
        await this.emitCurrent(attempt.binding);
        return { errorCode };
    }
    async expire(attemptId) {
        const attempt = this.attempts.get(attemptId);
        if (!attempt || attempt.consumed)
            return;
        this.finishAttempt(attempt, { outcome: 'expired' });
        await this.emitCurrent(attempt.binding);
    }
    finishAttempt(attempt, ending) {
        if (!this.attempts.remove(attempt))
            return;
        this.lastAttempts.set(attempt.credentialKey, { attemptId: attempt.id, ...ending });
        const now = this.now();
        for (const [id, finished] of this.finished) {
            if (now - finished.finishedAt > ATTEMPT_TIMEOUT_MS)
                this.finished.delete(id);
        }
        this.finished.set(attempt.id, { binding: attempt.binding, ...ending, finishedAt: now });
        attempt.settled.resolve(ending.errorCode ? { errorCode: ending.errorCode } : {});
    }
    // ---------------------------------------------------------------------------
    // Credentials and state
    // ---------------------------------------------------------------------------
    identity(binding, credentialKey) {
        const now = this.now();
        return {
            credentialKey,
            namespace: binding.namespace,
            fingerprint: clientFingerprint(binding),
            target: storedTarget(binding),
            serverUrl: binding.serverUrl,
            resource: canonicalResourceUrl(binding.serverUrl),
            lastUsedAt: now,
        };
    }
    async deleteSupersededFingerprints(binding, keep) {
        const resource = canonicalResourceUrl(binding.serverUrl);
        const deleted = await this.store.deleteWhere((record) => record.credentialKey !== keep &&
            record.namespace === binding.namespace &&
            record.resource === resource &&
            sameTarget(record.target, storedTarget(binding)));
        for (const key of deleted)
            this.forget(key);
    }
    async revoke(binding, record) {
        const endpoint = record.authorizationServerMetadata
            ? stringField(record.authorizationServerMetadata, 'revocation_endpoint')
            : undefined;
        const token = record.tokens?.refresh_token ?? record.tokens?.access_token;
        if (!endpoint || !token || !record.registration)
            return false;
        const client = clientInformationFor(record.registration, await this.userClientSecretFor(binding));
        const body = new URLSearchParams({
            token,
            token_type_hint: record.tokens?.refresh_token ? 'refresh_token' : 'access_token',
        });
        const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
        if (client.client_secret) {
            headers.set('Authorization', `Basic ${btoa(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`)}`);
        }
        else {
            body.set('client_id', client.client_id);
        }
        try {
            const response = await createGuardedFetch({
                fetchImpl: this.fetchImpl,
                privateNetwork: binding.privateNetwork,
                timeoutMs: 10_000,
                signal: this.lifetime.signal,
            })(endpoint, { method: 'POST', headers, body });
            await response.body?.cancel();
            return response.ok;
        }
        catch (error) {
            this.logger?.warn('MCP OAuth token revocation failed', { error: errorName(error) });
            return false;
        }
    }
    async userClientSecretFor(binding) {
        if (binding.target.kind !== 'user' || !binding.userClientSecretKey)
            return undefined;
        return this.store.getClientSecret(binding.userClientSecretKey);
    }
    onAuthorizerRecordChanged(binding, record) {
        const key = this.credentialKey(binding);
        this.observations.delete(key);
        if (record?.state)
            this.watch(binding, key, record.revision);
        this.emit(this.viewFor(binding, key, record), binding);
    }
    viewFor(binding, key, record) {
        const base = {
            ...this.baseView(binding),
            ...(record?.issuer ? { issuer: record.issuer } : {}),
        };
        if (record?.state)
            return { ...base, ...persistedStateView(record.state) };
        if (record?.tokens) {
            return {
                ...base,
                authState: 'authorized',
                ...(record.tokens.expires_at !== undefined ? { expiresAt: record.tokens.expires_at } : {}),
            };
        }
        const observation = this.observationFor(binding, key);
        if (observation) {
            return {
                ...base,
                authState: observation.authState,
                ...(observation.reason ? { reason: observation.reason } : {}),
            };
        }
        return { ...base, authState: 'unknown' };
    }
    baseView(binding) {
        const origin = safeUrl(binding.serverUrl)?.origin;
        const last = this.lastAttempts.get(this.credentialKey(binding));
        return {
            target: binding.target,
            ...(origin ? { serverOrigin: origin } : {}),
            ...(last
                ? {
                    lastAttemptId: last.attemptId,
                    lastAttemptOutcome: last.outcome,
                    ...(last.errorCode ? { lastAttemptErrorCode: last.errorCode } : {}),
                }
                : {}),
        };
    }
    observationScope(binding) {
        return { namespace: binding.namespace, connectionFingerprint: binding.connectionFingerprint };
    }
    /** The observation for this binding, dropping it (and its revision watch) once config changed. */
    observationFor(binding, key) {
        const observation = this.observations.get(key);
        if (!observation || observation.connectionFingerprint === binding.connectionFingerprint) {
            return observation;
        }
        this.forget(key);
        return undefined;
    }
    forget(key) {
        this.observations.delete(key);
        this.watches.delete(key);
    }
    // ---------------------------------------------------------------------------
    // Cross-process change detection and notification
    // ---------------------------------------------------------------------------
    watch(binding, key, revision) {
        if (this.closed)
            return;
        this.watches.set(key, { binding, revision });
        if (this.pollTimer)
            return;
        this.pollTimer = setInterval(() => settleInBackground(this.pollWatches()), this.pollIntervalMs);
        this.pollTimer.unref();
    }
    /** Reads revisions only (no network); a change means another process committed or cleared. */
    async pollWatches() {
        if (this.polling)
            return;
        this.polling = true;
        try {
            for (const [key, watch] of [...this.watches]) {
                const record = await this.readQuietly(key);
                if ((record?.revision ?? 0) === watch.revision || this.watches.get(key) !== watch)
                    continue;
                this.watches.delete(key);
                this.observations.delete(key);
                if (record?.state?.authState === 'needs_reauth')
                    this.watch(watch.binding, key, record.revision);
                this.emit(this.viewFor(watch.binding, key, record), watch.binding);
            }
        }
        finally {
            this.polling = false;
            if (this.watches.size === 0 && this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = undefined;
            }
        }
    }
    async readQuietly(key) {
        try {
            return await this.store.read(key);
        }
        catch {
            return undefined;
        }
    }
    async emitCurrent(binding) {
        this.emit(await this.getState(binding), binding);
    }
    emit(view, binding) {
        for (const listener of [...this.listeners]) {
            settleInBackground(this.notify(listener, view, binding));
        }
    }
    async notify(listener, view, binding) {
        try {
            await listener(view, binding);
        }
        catch (error) {
            this.logger?.warn('MCP OAuth state listener failed', { error: errorName(error) });
        }
    }
}
/**
 * Scope selection (plan §5.4): fixed scopes win; step-up requests requestedScope ∪ challenge
 * scope; otherwise the last challenge scope, then PRM `scopes_supported`. `offline_access` is
 * appended when the authorization server supports it and a scope is being requested.
 */
function selectScope(binding, discovery, record, observation) {
    if (binding.oauth?.scopes?.length)
        return unionScopes(binding.oauth.scopes);
    let stepUpScope;
    if (record?.state?.reason === 'insufficient_scope')
        stepUpScope = record.state.challengeScope;
    else if (observation?.reason === 'insufficient_scope')
        stepUpScope = observation.challenge?.scope;
    const base = stepUpScope
        ? unionScopes(record?.requestedScope, stepUpScope)
        : (observation?.challenge?.scope ?? unionScopes(discovery.resourceScopes));
    if (!base)
        return undefined;
    return discovery.metadata.scopes_supported?.includes('offline_access')
        ? unionScopes(base, 'offline_access')
        : base;
}
function exchangeErrorCode(attempt, error) {
    return attempt.registration.method === 'pre' && isClientRejection(oauthErrorCodeOf(error))
        ? 'MCP_OAUTH_CLIENT_REJECTED'
        : asOAuthError(error, 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED').code;
}
function persistedStateView(state) {
    const reason = state.authState === 'failed' ? (state.lastErrorCode ?? state.reason) : state.reason;
    return {
        authState: state.authState,
        ...(reason ? { reason } : {}),
        ...(state.missingScopes?.length ? { missingScopes: state.missingScopes } : {}),
    };
}
function storedTarget(binding) {
    const target = binding.target;
    if (target.kind === 'project') {
        return { kind: 'project', serverName: target.serverName, workspaceRoot: target.workspaceRoot };
    }
    return target;
}
function sameTarget(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function safeUrl(value) {
    try {
        return new URL(value);
    }
    catch {
        return undefined;
    }
}
function errorName(error) {
    return error instanceof Error ? error.name : 'unknown';
}
//# sourceMappingURL=service.js.map