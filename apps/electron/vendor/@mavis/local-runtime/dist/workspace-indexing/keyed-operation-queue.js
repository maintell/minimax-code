export class KeyedOperationQueue {
    operations = new Map();
    async run(key, operation) {
        const previous = this.operations.get(key) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
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