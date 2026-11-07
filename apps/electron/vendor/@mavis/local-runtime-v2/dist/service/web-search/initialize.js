import { LocalWebSearchClient } from './local-web-search-client.js';
/**
 * The client is built once per Turn, and a Turn can outlive one OAuth access token. Pass the
 * host's live getter and invalidator so every search reads the current token and recovers
 * once from a 401, instead of reusing the Turn-start snapshot in `authContext`.
 */
export function createManagedLocalWebSearchClient(options = {}) {
    return new LocalWebSearchClient({
        ...(options.authContext ? { authContext: options.authContext } : {}),
        ...(options.authContextGetter ? { authContextGetter: options.authContextGetter } : {}),
        ...(options.authContextInvalidator
            ? { authContextInvalidator: options.authContextInvalidator }
            : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        routingContextGetter: options.routingContextGetter,
    });
}
//# sourceMappingURL=initialize.js.map