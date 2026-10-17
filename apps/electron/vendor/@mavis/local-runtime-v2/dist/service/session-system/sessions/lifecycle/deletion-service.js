import { isPeekSession } from '../repo/normalization.js';
import { SessionServiceError } from '../errors.js';
export class SessionDeletionService {
    options;
    constructor(options) {
        this.options = options;
    }
    async deleteSession(sessionId) {
        const current = await this.options.sessions.get(sessionId);
        if (!current)
            return undefined;
        if (current.runtime !== 'pi-agent') {
            throw new SessionServiceError('runtime-unsupported', 'Legacy opencode Session mutation is unavailable');
        }
        await this.options.cleanup.markLegacyMigrationDeleted(sessionId);
        await this.options.cleanup.deleteCanvas(sessionId);
        // Peek Sessions are ephemeral, but their token/cost ledger is not. Drop
        // transcript, files and every other Session-owned artifact while retaining
        // the usage rows keyed by side sessionId + turnId for attribution.
        if (isPeekSession(current)) {
            await this.options.cleanup.deleteArtifacts(sessionId, { preserveUsage: true });
        }
        else {
            await this.options.cleanup.deleteArtifacts(sessionId);
        }
        await this.options.cleanup.deleteDiff(sessionId);
        await this.options.cleanup.deleteCommunication(sessionId);
        await this.options.cleanup.deleteChannelBindings(sessionId);
        await this.options.cleanup.deleteQuestionnaires(sessionId);
        await this.options.cleanup.deletePermissions(sessionId);
        await this.options.cleanup.deleteGoal(sessionId);
        await this.options.cleanup.deleteQueryCollapse(sessionId);
        await this.options.cleanup.removePin(sessionId);
        await this.options.sessions.reparentChildren(sessionId, current.parentSessionId ?? null);
        await this.options.clearSessionReference(current);
        await this.options.records.deleteSessionRecord(sessionId);
        this.options.facts.handle({ kind: 'deleted', sessionId });
        return current;
    }
}
//# sourceMappingURL=deletion-service.js.map