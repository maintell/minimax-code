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
/**
 * The Provider rejected the checkpoint request for the images it carries (for
 * example `Too many images in request: 31 > 30`). Re-sending the same
 * candidate fails identically, so the candidate ladder retries the same
 * history with attachments replaced by text instead of failing (#425).
 */
export class CheckpointCandidateMediaRejectedError extends Error {
    name = 'CheckpointCandidateMediaRejectedError';
    constructor(cause) {
        super('Provider rejected checkpoint input because it carried too many images.', { cause });
    }
}
//# sourceMappingURL=contracts.js.map