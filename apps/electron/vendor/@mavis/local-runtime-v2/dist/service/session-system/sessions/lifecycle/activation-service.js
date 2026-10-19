export class SessionActivationService {
    options;
    constructor(options) {
        this.options = options;
    }
    async prepareForUserActivation(sessionId) {
        const updated = await this.options.writer.reopenArchivedSession(sessionId);
        if (!updated)
            return undefined;
        if (updated.archived) {
            throw new Error(`Session ${sessionId} remained archived after activation preparation.`);
        }
        this.options.facts.handle({ kind: 'archive-changed', sessionId, archived: false });
        return freezeSnapshot(updated);
    }
}
function freezeSnapshot(record) {
    const runLocation = record.runLocation ? Object.freeze({ ...record.runLocation }) : undefined;
    return Object.freeze({ ...record, runLocation });
}
//# sourceMappingURL=activation-service.js.map