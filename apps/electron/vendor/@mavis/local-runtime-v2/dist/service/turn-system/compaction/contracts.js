export class ContextCompactionError extends Error {
    code;
    stage;
    name = 'ContextCompactionError';
    diagnostics;
    constructor(code, stage, message, options) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.code = code;
        this.stage = stage;
        if (options?.diagnostics !== undefined)
            this.diagnostics = options.diagnostics;
    }
}
/**
 * The candidate is too large to checkpoint in one Provider request, normalized
 * at the request boundary. The candidate ladder advances to the next, smaller
 * candidate regardless of `reason`.
 */
export class CheckpointCandidateTooLargeError extends Error {
    reason;
    name = 'CheckpointCandidateTooLargeError';
    constructor(cause, reason = 'input_overflow') {
        super(reason === 'output_exhausted'
            ? 'Checkpoint output budget was exhausted before any checkpoint text.'
            : 'Provider rejected checkpoint input because it exceeded the context limit.', { cause });
        this.reason = reason;
    }
}
//# sourceMappingURL=contracts.js.map