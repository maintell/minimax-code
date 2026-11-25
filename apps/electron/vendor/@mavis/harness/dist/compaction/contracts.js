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
const MEDIA_REJECTION_MESSAGES = {
    image_limit: 'Provider rejected checkpoint input because it carried too many images.',
    media_count: 'Provider rejected checkpoint input because it carried more images or videos than one request may carry.',
    media_content: 'Provider rejected checkpoint input because it could not take an image or video it carried.',
};
/**
 * The Provider rejected the checkpoint request for the media it carries (for
 * example `Too many images in request: 31 > 30`, or MiniMax's
 * `invalid params, 400 (2013)` for a video it cannot decode). Re-sending the
 * same candidate fails identically, so the candidate ladder retries the same
 * history with attachments replaced by text instead of failing (#425).
 */
export class CheckpointCandidateMediaRejectedError extends Error {
    reason;
    name = 'CheckpointCandidateMediaRejectedError';
    constructor(cause, reason = 'image_limit') {
        super(MEDIA_REJECTION_MESSAGES[reason], { cause });
        this.reason = reason;
    }
}
//# sourceMappingURL=contracts.js.map