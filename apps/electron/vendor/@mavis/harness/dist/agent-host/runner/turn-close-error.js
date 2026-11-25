export class AgentHostTurnCloseError extends Error {
    reason;
    abortReason;
    name = 'AgentHostTurnCloseError';
    constructor(reason, abortReason) {
        super(reason === 'aborted' && abortReason
            ? `Accepted Turn was aborted before close: ${abortReason}.`
            : `Accepted Turn close failed: ${reason}.`);
        this.reason = reason;
        this.abortReason = abortReason;
    }
}
//# sourceMappingURL=turn-close-error.js.map