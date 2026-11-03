import { DesktopGatewayHttpError, DesktopMatrixClient } from '@mavis/agent-tools/desktop';
import { managedBackendRoutingHeaders } from '../../infra/config/routing-headers.js';
import { logger } from '../../infra/logging/logger.js';
import { getLocalMatrixEndpoint } from './matrix-env.js';
const HTTP_UNAUTHORIZED = 401;
export class LocalMatrixClient extends DesktopMatrixClient {
    liveAuth;
    constructor(options = {}) {
        super({
            ...options,
            routingHeadersGetter: () => managedBackendRoutingHeaders(options.routingContextGetter?.()),
            ...(options.baseUrl ? {} : { endpoint: getLocalMatrixEndpoint() }),
        });
        this.liveAuth = {
            authContextGetter: options.authContextGetter,
            authContextInvalidator: options.authContextInvalidator,
        };
    }
    /**
     * The host refreshes OAuth lazily: a token may already be expired before any request has
     * reported it. With a live getter and an invalidator, a 401 asks the host to recover the
     * rejected token and retries once with the refreshed one, the same recovery the LLM path
     * uses. Without both, or when an explicit token (MATRIX_TOKEN / accessToken) replaces the
     * managed login, the 401 is returned unchanged: the host token is not what was rejected.
     */
    async postGatewayJson(...request) {
        const { authContextGetter, authContextInvalidator } = this.liveAuth;
        if (!this.useManagedAuth || !authContextGetter || !authContextInvalidator) {
            return super.postGatewayJson(...request);
        }
        // super reads the same getter synchronously before its first await, so this is the
        // auth the request carries.
        const sentAuth = authContextGetter();
        try {
            return await super.postGatewayJson(...request);
        }
        catch (err) {
            const sentToken = sentAuth?.accessToken?.trim();
            if (!isUnauthorized(err) || !sentToken)
                throw err;
            return this.retryAfterTokenRecovery(err, sentToken, sentAuth?.loginEpoch, request);
        }
    }
    async retryAfterTokenRecovery(unauthorized, sentToken, loginEpoch, request) {
        const [pathname, , signal] = request;
        try {
            await this.liveAuth.authContextInvalidator?.(sentToken, loginEpoch);
        }
        catch {
            logRecovery(pathname, 'failed', 'invalidator_failed');
            throw unauthorized;
        }
        if (signal?.aborted)
            throw unauthorized;
        const freshAuth = this.liveAuth.authContextGetter?.();
        const freshToken = freshAuth?.accessToken?.trim();
        if (!freshToken || freshToken === sentToken || freshAuth?.loginEpoch !== loginEpoch) {
            logRecovery(pathname, 'failed', 'token_not_refreshed');
            throw unauthorized;
        }
        try {
            const response = await super.postGatewayJson(...request);
            logRecovery(pathname, 'ok');
            return response;
        }
        catch (retryErr) {
            logRecovery(pathname, 'failed', 'retry_failed');
            throw retryErr;
        }
    }
}
function isUnauthorized(err) {
    return err instanceof DesktopGatewayHttpError && err.statusCode === HTTP_UNAUTHORIZED;
}
function logRecovery(path, result, errorType) {
    // Only the route and outcome; never token or login values.
    const fields = {
        path,
        status_code: HTTP_UNAUTHORIZED,
        result,
        ...(errorType ? { error_type: errorType } : {}),
    };
    if (result === 'ok')
        logger.info(fields, 'matrix gateway retry after token refresh');
    else
        logger.warn(fields, 'matrix gateway retry after token refresh');
}
//# sourceMappingURL=local-matrix-client.js.map