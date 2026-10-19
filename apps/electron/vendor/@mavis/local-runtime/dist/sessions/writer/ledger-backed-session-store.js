export class LedgerBackedLocalSessionStore {
    delegate;
    writer;
    constructor(options) {
        this.delegate = options.delegate;
        this.writer = options.writer;
    }
    get(sessionId) {
        return this.delegate.get(sessionId);
    }
    async upsert(record) {
        await this.writer.withSessionWriteLock(record.sessionId, async () => {
            const existing = await this.delegate.get(record.sessionId);
            let watermark;
            if (!existing) {
                watermark = await this.writer.recordSessionCreated(record);
            }
            else if (JSON.stringify(existing) !== JSON.stringify(record)) {
                watermark = await this.writer.recordSessionMetadataUpdated(record);
            }
            await this.delegate.upsert(record);
            await this.writer.markProjectionWatermark(watermark);
        });
    }
    async delete(sessionId) {
        await this.writer.withSessionWriteLock(sessionId, async () => {
            const existing = await this.delegate.get(sessionId);
            const watermark = existing ? await this.writer.recordSessionDeleted(sessionId) : undefined;
            await this.delegate.delete(sessionId);
            await this.writer.markProjectionWatermark(watermark);
        });
    }
    list(options) {
        return this.delegate.list(options);
    }
}
//# sourceMappingURL=ledger-backed-session-store.js.map