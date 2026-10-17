/**
 * Keeps Queue fact ownership in SessionSystem while allowing TurnSystem to
 * settle live submit completion handles from committed removal facts.
 */
export class QueueCommittedFactHub {
    downstream;
    subscribers = new Set();
    constructor(downstream) {
        this.downstream = downstream;
    }
    handle(facts) {
        this.downstream.handle(facts);
        for (const subscriber of this.subscribers)
            subscriber(facts);
    }
    subscribe(subscriber) {
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }
}
//# sourceMappingURL=committed-fact-hub.js.map