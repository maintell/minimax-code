export class SessionArtifactService {
    owners;
    constructor(owners) {
        this.owners = owners;
    }
    async ensureReportsDirectory(sessionId) {
        return this.owners.reports.ensureDirectory(sessionId);
    }
    /** Where each compaction keeps the full history it replaced. */
    async resolveSnapshotsDirectory(sessionId) {
        return this.owners.snapshots.resolveDirectory(sessionId);
    }
    async deleteSession(sessionId, options = {}) {
        const operations = [
            () => this.owners.queue.deleteSession(sessionId),
            () => this.owners.files.deleteSession(sessionId),
            ...(options.preserveUsage ? [] : [() => this.owners.usage.deleteSession(sessionId)]),
            () => this.owners.messages.deleteSessionData(sessionId),
            () => this.deleteLegacyHistory(sessionId),
            () => this.owners.canonicalHistory.delete(sessionId),
            () => this.owners.stream.deleteSession(sessionId),
        ];
        const results = await Promise.allSettled(operations.map(execute));
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length > 0) {
            throw new AggregateError(errors, `Session-owned artifact deletion failed: ${sessionId}`);
        }
    }
    async deleteLegacyHistory(sessionId) {
        try {
            await this.owners.history.deleteSessionData(sessionId);
        }
        catch (error) {
            this.owners.onLegacyCleanupError?.(error, sessionId);
        }
    }
}
async function execute(operation) {
    await operation();
}
//# sourceMappingURL=artifact-service.js.map