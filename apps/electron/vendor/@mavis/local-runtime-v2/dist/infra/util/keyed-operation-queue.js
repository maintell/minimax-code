export class KeyedOperationQueue {
    operations = new Map();
    async run(key, operation) {
        const previous = this.operations.get(key) ?? Promise.resolve();
        const current = this.runAfter(previous, operation);
        this.operations.set(key, current);
        try {
            return await current;
        }
        finally {
            if (this.operations.get(key) === current)
                this.operations.delete(key);
        }
    }
    async runAfter(previous, operation) {
        try {
            await previous;
        }
        catch {
            // An earlier failure must not prevent this key's next operation from running.
        }
        return operation();
    }
}
//# sourceMappingURL=keyed-operation-queue.js.map