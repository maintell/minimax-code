import { LocalMatrixClient } from './local-matrix-client.js';
/**
 * Builds the managed Matrix gateway client behind the local-runtime Matrix
 * HTTP helper routes. Auth is read once per request so a re-login between
 * calls is honoured; routing context stays a getter for the same reason.
 */
export function initializeLocalMatrixHttpClient(input) {
    return new LocalMatrixClient({
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.authContextGetter ? { authContext: input.authContextGetter() } : {}),
        routingContextGetter: input.routingContextGetter,
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    });
}
//# sourceMappingURL=initialize.js.map