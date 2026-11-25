/** Stable error crossing back to the Worker; `outcome` is set on `mcp.call` failures. */
export class ExtensionServiceError extends Error {
    code;
    outcome;
    constructor(code, message, outcome) {
        super(message);
        this.name = 'ExtensionServiceError';
        this.code = code;
        if (outcome)
            this.outcome = outcome;
    }
}
/** Stable failure of an `extension` tool action; the application maps it to the tool error. */
export class ExtensionAuthoringError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'ExtensionAuthoringError';
        this.code = code;
    }
}
//# sourceMappingURL=errors.js.map