export class MemoryScopeMutationCoordinator {
    locks = new Map();
    wakeSink;
    async withScopeMutation(scopeKey, operation, options) {
        while (this.locks.has(scopeKey)) {
            await this.locks.get(scopeKey);
        }
        let release;
        const barrier = new Promise((resolve) => {
            release = resolve;
        });
        this.locks.set(scopeKey, barrier);
        try {
            const result = await operation();
            if (options?.requestWakeOnComplete && this.wakeSink) {
                this.wakeSink();
            }
            return result;
        }
        finally {
            this.locks.delete(scopeKey);
            release();
        }
    }
    bindWakeSink(wake) {
        this.wakeSink = wake;
    }
}
//# sourceMappingURL=scope-mutation.js.map