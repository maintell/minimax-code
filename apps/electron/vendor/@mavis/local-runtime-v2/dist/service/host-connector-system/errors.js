export class ConnectorGatewayError extends Error {
    code;
    outcome;
    invocationId;
    diagnostic;
    constructor(code, message, outcome, invocationIdOrDetails) {
        super(message);
        this.code = code;
        this.outcome = outcome;
        this.name = 'ConnectorGatewayError';
        this.invocationId =
            typeof invocationIdOrDetails === 'string'
                ? invocationIdOrDetails
                : invocationIdOrDetails?.invocationId;
        this.diagnostic =
            typeof invocationIdOrDetails === 'string' ? undefined : invocationIdOrDetails?.diagnostic;
    }
}
//# sourceMappingURL=errors.js.map