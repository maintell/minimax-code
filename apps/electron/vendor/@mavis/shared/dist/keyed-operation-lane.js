/** Serializes operations per key without coupling unrelated keys. */
export class KeyedOperationLane {
    tails = new Map();
    async acquire(key) {
        const previous = this.tails.get(key) ?? Promise.resolve();
        let releaseGate = () => undefined;
        const gate = new Promise((resolve) => {
            releaseGate = resolve;
        });
        const current = waitForLane(previous, gate);
        this.tails.set(key, current);
        await ignoreLaneFailure(previous);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            releaseGate();
            if (this.tails.get(key) === current)
                this.tails.delete(key);
        };
    }
    async run(key, operation) {
        const release = await this.acquire(key);
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
}
async function waitForLane(previous, gate) {
    await ignoreLaneFailure(previous);
    await gate;
}
async function ignoreLaneFailure(lane) {
    try {
        await lane;
    }
    catch {
        // A failed predecessor must not poison later operations for the same key.
    }
}
//# sourceMappingURL=keyed-operation-lane.js.map