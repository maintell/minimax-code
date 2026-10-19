/** Typed verifier failure that preserves every available physical-call usage sample. */
export class VerificationDispatchError extends Error {
    code;
    usage;
    name = 'VerificationDispatchError';
    traceRef;
    constructor(code, message, usage, options) {
        super(message, options);
        this.code = code;
        this.usage = usage;
        this.traceRef = options?.traceRef;
    }
}
//# sourceMappingURL=verifier-port.js.map