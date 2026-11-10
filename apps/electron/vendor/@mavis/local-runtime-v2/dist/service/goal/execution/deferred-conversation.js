/**
 * The runtime conversation the Goal owner submits through.
 *
 * It exists only once Session Applications are built, but Goal work can start
 * earlier: TurnSystem readiness resumes pending Session deletions, which delete
 * the Session's Goal and cancel its staged kickoff. A call made before binding
 * waits for the binding instead of failing, so that cancellation still reaches
 * the Queue.
 */
export class DeferredGoalConversation {
    bound;
    closedError;
    waiters = [];
    port = {
        query: this.defer('query'),
        ingress: this.defer('ingress'),
    };
    bind(conversation) {
        if (this.closedError)
            return;
        this.bound = conversation;
        for (const waiter of this.takeWaiters())
            waiter.resolve(conversation);
    }
    /**
     * The runtime is shutting down, possibly before startup ever bound the
     * conversation: waiting calls fail instead of hanging, and so do later ones.
     */
    close() {
        if (this.bound || this.closedError)
            return;
        const error = new Error('Runtime conversation closed before it was bound');
        this.closedError = error;
        for (const waiter of this.takeWaiters())
            waiter.reject(error);
    }
    takeWaiters() {
        const waiters = this.waiters;
        this.waiters = [];
        return waiters;
    }
    waitForBinding() {
        if (this.bound)
            return Promise.resolve(this.bound);
        if (this.closedError)
            return Promise.reject(this.closedError);
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
    defer(part) {
        const handler = {
            get: (_target, member) => {
                if (this.bound)
                    return readMember(this.bound[part], member);
                return async (...args) => {
                    const conversation = await this.waitForBinding();
                    const method = readMember(conversation[part], member);
                    if (typeof method !== 'function') {
                        throw new Error(`Runtime conversation ${part}.${String(member)} is unavailable`);
                    }
                    return method(...args);
                };
            },
        };
        return new Proxy({}, handler);
    }
}
function readMember(target, member) {
    const value = Reflect.get(target, member);
    return typeof value === 'function' ? value.bind(target) : value;
}
//# sourceMappingURL=deferred-conversation.js.map