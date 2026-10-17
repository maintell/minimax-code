export class CommittedQueueService {
    options;
    constructor(options) {
        this.options = options;
    }
    listPendingSessionIds() {
        return this.options.queue.listPendingSessionIds();
    }
    snapshot(sessionId) {
        return this.consume(this.options.queue.snapshot(sessionId));
    }
    continueQueue(sessionId, expectedPause) {
        return this.consume(this.options.queue.continueQueue(sessionId, expectedPause));
    }
    pauseIfPending(input) {
        return this.consume(this.options.queue.pauseIfPending(input));
    }
    list(sessionId) {
        return this.consume(this.options.queue.list(sessionId));
    }
    findByClientRequestId(sessionId, clientRequestId) {
        return this.consume(this.options.queue.findByClientRequestId(sessionId, clientRequestId));
    }
    get(sessionId, itemId) {
        return this.consume(this.options.queue.get(sessionId, itemId));
    }
    enqueue(input) {
        return this.consume(this.options.queue.enqueue(input));
    }
    update(input) {
        return this.consume(this.options.queue.update(input));
    }
    promote(sessionId, itemId, source) {
        return this.consume(this.options.queue.promote(sessionId, itemId, source));
    }
    async cancel(sessionId, itemId) {
        const result = await this.options.queue.cancel(sessionId, itemId);
        this.options.facts.handle(result.facts);
        const value = result.value;
        if (!value || value === 'not_editable')
            return value;
        const removal = result.facts.find((fact) => fact.kind === 'removed' && fact.itemId === value.itemId && fact.reason === 'cancelled');
        if (!removal || removal.kind !== 'removed') {
            throw new Error(`Queue cancellation did not emit a removal fact: ${sessionId}/${itemId}`);
        }
        return { ...value, removedAtMs: removal.removedAtMs };
    }
    clearUserManageable(sessionId) {
        return this.consume(this.options.queue.clearUserManageable(sessionId));
    }
    reorder(input) {
        return this.consume(this.options.queue.reorder(input));
    }
    async deleteSession(sessionId) {
        await this.consume(this.options.queue.deleteSession(sessionId));
    }
    requireMutableSession(sessionId) {
        return this.options.queue.requireMutableSession(sessionId);
    }
    async consume(operation) {
        const result = await operation;
        this.options.facts.handle(result.facts);
        return result.value;
    }
}
//# sourceMappingURL=committed-service.js.map