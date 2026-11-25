/** Keep reply identity private until the Host has durably committed the outcome. */
export class CommittedReplyRelay {
    observer;
    replies = new WeakMap();
    constructor(observer) {
        this.observer = observer;
    }
    remember(outcome, scope, replyMessageId) {
        if (!this.observer() || outcome.status !== 'completed' || !replyMessageId)
            return;
        this.replies.set(outcome, { sessionId: scope.sessionId, turnId: scope.turnId, replyMessageId });
    }
    committed(outcome) {
        const reply = this.replies.get(outcome);
        this.replies.delete(outcome);
        if (!reply)
            return;
        try {
            this.observer()?.(reply);
        }
        catch {
            /* Optional observers cannot fail a committed Turn. */
        }
    }
}
//# sourceMappingURL=committed-reply.js.map