export class KeyedOperationQueue {
    operations = new Map();
    async run(key, operation) {
        const previous = this.operations.get(key) ?? Promise.resolve();
        const current = (async () => {
            try {
                await previous;
            }
            catch {
                /* A failed predecessor does not cancel this read. */
            }
            return operation();
        })();
        this.operations.set(key, current);
        try {
            return await current;
        }
        finally {
            if (this.operations.get(key) === current)
                this.operations.delete(key);
        }
    }
}
//# sourceMappingURL=keyed-operation-queue.js.map