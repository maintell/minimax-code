export class StaleCompactionMessageRepair {
    options;
    constructor(options) {
        this.options = options;
    }
    async repair(sessionId, messages) {
        const lastIndex = messages.length - 1;
        const reconciled = [...messages];
        for (const [index, message] of messages.entries()) {
            if (message.kind !== 'compaction_start')
                continue;
            const emittedByThisProcess = typeof message.timestamp === 'number' &&
                message.timestamp >= this.options.processStartedAtMs;
            if (emittedByThisProcess && index === lastIndex)
                continue;
            const patched = { ...message, kind: 'compaction_failed' };
            await this.options.messages.upsert({ sessionId, message: patched });
            reconciled[index] = patched;
        }
        return reconciled;
    }
}
//# sourceMappingURL=stale-compaction-repair.js.map