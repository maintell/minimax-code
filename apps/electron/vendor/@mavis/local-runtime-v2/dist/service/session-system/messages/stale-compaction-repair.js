export class StaleCompactionMessageRepair {
    options;
    constructor(options) {
        this.options = options;
    }
    needsRepair(messages) {
        return messages.some((message, index) => this.isStale(message, index, messages.length));
    }
    async repair(sessionId, messages) {
        const reconciled = [...messages];
        for (const [index, message] of messages.entries()) {
            if (!this.isStale(message, index, messages.length))
                continue;
            const patched = { ...message, kind: 'compaction_failed' };
            await this.options.messages.upsert({ sessionId, message: patched });
            reconciled[index] = patched;
        }
        return reconciled;
    }
    isStale(message, index, length) {
        if (message.kind !== 'compaction_start')
            return false;
        const emittedByThisProcess = typeof message.timestamp === 'number' && message.timestamp >= this.options.processStartedAtMs;
        return !emittedByThisProcess || index !== length - 1;
    }
}
//# sourceMappingURL=stale-compaction-repair.js.map