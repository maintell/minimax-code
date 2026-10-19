import { DesktopMatrixClient, toLocalGatewayPath, } from '@mavis/agent-tools/desktop';
import { managedBackendRoutingHeaders, } from '../runtime/routing-headers.js';
import { getLocalMatrixEndpoint } from './matrix-env.js';
export class LocalMatrixClient extends DesktopMatrixClient {
    constructor(options = {}) {
        super({
            ...options,
            routingHeadersGetter: () => managedBackendRoutingHeaders(options.routingContextGetter?.()),
            ...(options.baseUrl ? {} : { endpoint: getLocalMatrixEndpoint() }),
        });
    }
}
export { toLocalGatewayPath };
//# sourceMappingURL=local-matrix-client.js.map