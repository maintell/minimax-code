import { HostConnectorGateway } from './gateway.js';
export function initializeHostConnectorSystem(options) {
    const gateway = new HostConnectorGateway(options);
    return {
        gateway,
        authContextChanged: () => gateway.authContextChanged(),
        close: () => gateway.close(),
    };
}
//# sourceMappingURL=initialize.js.map