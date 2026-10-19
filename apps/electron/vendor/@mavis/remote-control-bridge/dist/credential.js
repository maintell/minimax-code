const RENDERER_CACHE_MAX_AGE_MS = 60_000; // Tickets are valid for 60s anyway
/**
 * @param getRendererCache Live getter reading the proxy's current
 *   renderer-supplied bundle. A getter (not a snapshot) is required so that a
 *   credential refresh landing DURING an active connection's backoff is seen
 *   by the next `attempt()` — see design §4.3.
 */
export function createCredentialProvider(getRendererCache) {
    return {
        async getCredentials() {
            const cache = getRendererCache();
            if (cache && Date.now() - cache.fetchedAtMs < RENDERER_CACHE_MAX_AGE_MS) {
                return {
                    state: 'bound',
                    bindingId: cache.bindingId,
                    ticket: cache.ticket,
                    endpoint: cache.endpoint,
                };
            }
            // Missing / expired / already-consumed → owner must re-sign via renderer.
            return { state: 'stale' };
        },
    };
}
//# sourceMappingURL=credential.js.map