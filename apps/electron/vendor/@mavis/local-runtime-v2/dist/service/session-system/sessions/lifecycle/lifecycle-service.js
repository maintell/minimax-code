export class SessionLifecycleService {
    options;
    constructor(options) {
        this.options = options;
    }
    createSession(input) {
        return this.options.records.createSession(input);
    }
    createInternalSession(input) {
        return this.options.records.createInternalSession(input);
    }
    createRootSession(input) {
        return this.options.records.createRootSession(input);
    }
    archiveSession(sessionId, archived = true) {
        return this.mutateSession(sessionId, { archived });
    }
    mutateSession(sessionId, fields) {
        if (fields.archived !== true)
            return this.mutateAndEmit(sessionId, fields);
        return this.options.maintenance.runExclusive(sessionId, (lane) => this.archiveSessionInMaintenanceLane(sessionId, lane));
    }
    /** 在持久化时核对原标题，保留并发写入的用户名称。 */
    async renameSession(sessionId, title, expectedTitle, signal) {
        const updated = await this.options.records.mutateSession(sessionId, { title, titleSource: 'auto' }, undefined, { title: expectedTitle, ...(signal ? { signal } : {}) });
        this.emitMutationFacts(updated, { title });
    }
    async archiveSessionInMaintenanceLane(sessionId, lane) {
        const fields = { archived: true };
        const updated = await lane.run(() => this.options.records.mutateSession(sessionId, fields));
        await lane.run(() => this.options.clearSessionReference(updated));
        await lane.run(() => this.options.preferences.removePin(sessionId));
        this.emitMutationFacts(updated, fields);
        return updated;
    }
    async archiveSessionById(sessionId) {
        await this.archiveSession(sessionId, true);
    }
    async mutateAndEmit(sessionId, fields) {
        const updated = await this.options.records.mutateSession(sessionId, fields);
        this.emitMutationFacts(updated, fields);
        return updated;
    }
    emitMutationFacts(session, fields) {
        if (fields.title !== undefined && fields.title !== null) {
            this.options.facts.handle({ kind: 'title-updated', session, title: fields.title });
        }
        if (Object.hasOwn(fields, 'effectiveModel') ||
            Object.hasOwn(fields, 'effectiveModelVariant') ||
            Object.hasOwn(fields, 'effectiveModelThinking') ||
            Object.hasOwn(fields, 'effectiveModelContextWindow') ||
            Object.hasOwn(fields, 'effectiveModelMaxOutputTokens')) {
            this.options.facts.handle({ kind: 'model-updated', session });
        }
        if (fields.archived !== undefined) {
            this.options.facts.handle({
                kind: 'archive-changed',
                sessionId: session.sessionId,
                archived: fields.archived,
            });
        }
        if (Object.hasOwn(fields, 'interactionMode')) {
            this.options.facts.handle({ kind: 'interaction-mode-updated', session });
        }
    }
}
//# sourceMappingURL=lifecycle-service.js.map