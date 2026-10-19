import { MCODE_OAUTH_SCOPES, AuthRequiredError, MCODE_OAUTH_AUDIENCE } from "@mavis/oauth-core";
const LEGACY_COMPATIBILITY_LEASE_MS = 5 * 60000;
export class DesktopAuthSession {
    constructor(core, legacySource, clock = { now: Date.now }, identitySource) {
        this.core = core;
        this.legacySource = legacySource;
        this.clock = clock;
        this.identitySource = identitySource;
        this.listeners = new Set();
    }
    resolveRuntimeIdentity(lease) {
        return this.identitySource?.resolve(lease) ?? Promise.resolve({});
    }
    applyRuntimeIdentity(identity) {
        this.identitySource?.apply(identity);
    }
    invalidateRuntimeIdentity() {
        this.identitySource?.invalidate?.();
    }
    async getStatus() {
        const status = await this.core.getStatus();
        return this.resolveDesktopStatus(status);
    }
    resolveDesktopStatus(status) {
        const accessToken = this.readEligibleLegacyAccessToken(status);
        if (!accessToken)
            return status;
        return {
            status: 'authenticated',
            generation: 0,
            scopes: [...MCODE_OAUTH_SCOPES],
            expiresAtMs: this.clock.now() + LEGACY_COMPATIBILITY_LEASE_MS,
            mode: 'legacy-compatible',
        };
    }
    async login(onPrompt) {
        const result = await this.core.login({
            ...(onPrompt ? { onDeviceAuthorization: onPrompt } : {}),
        });
        await this.legacySource?.clearAccessToken();
        return result;
    }
    cancelLogin() {
        return this.core.cancelLogin();
    }
    async getAccessToken(minValidityMs) {
        try {
            return await this.core.getAccessToken({ minValidityMs });
        }
        catch (error) {
            if (!(error instanceof AuthRequiredError))
                throw error;
            const status = await this.core.getStatus();
            const accessToken = this.readEligibleLegacyAccessToken(status);
            if (!accessToken)
                throw error;
            return {
                accessToken,
                expiresAtMs: this.clock.now() + Math.max(LEGACY_COMPATIBILITY_LEASE_MS, minValidityMs + 30000),
                generation: 0,
                scopes: MCODE_OAUTH_SCOPES,
                audience: MCODE_OAUTH_AUDIENCE,
                mode: 'legacy-compatible',
            };
        }
    }
    async handleUnauthorized(generation, loginEpoch) {
        if (generation !== 0 || !this.legacySource) {
            return this.core.handleUnauthorized({ generation, ...(loginEpoch ? { loginEpoch } : {}) });
        }
        const sharedStatus = await this.core.getStatus();
        if (sharedStatus.status === 'authenticated' && sharedStatus.generation > 0)
            return 'retry';
        await this.legacySource.clearAccessToken();
        this.emitStatus(sharedStatus);
        return 'logout';
    }
    async logout(revoke = true) {
        await this.legacySource?.clearAccessToken();
        const result = await this.core.logout({ revoke });
        this.emitStatus({ status: result.status, generation: result.generation, scopes: [] });
        return result;
    }
    watch(listener) {
        this.listeners.add(listener);
        const stopCoreWatch = this.core.watch((status) => listener(this.resolveDesktopStatus(status)));
        return () => {
            this.listeners.delete(listener);
            stopCoreWatch();
        };
    }
    emitStatus(status) {
        const resolved = this.resolveDesktopStatus(status);
        for (const listener of this.listeners)
            listener(resolved);
    }
    readEligibleLegacyAccessToken(status) {
        if (status.status !== 'anonymous' || status.generation !== 0)
            return undefined;
        const accessToken = this.legacySource?.readAccessToken()?.trim();
        return accessToken || undefined;
    }
}

