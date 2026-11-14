import { logger } from '../../../../infra/logging/logger.js';
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
        const previousMainSessionId = this.options.sideChats?.relation(sessionId)?.mainSessionId;
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
        await this.deleteAssignmentBestEffort(sessionId);
        await this.options.cleanup.deletePermissions(sessionId);
        await this.options.cleanup.deleteGoal(sessionId);
        await this.options.cleanup.deleteQueryCollapse(sessionId);
        await this.options.cleanup.removePin(sessionId);
        await this.options.sessions.reparentChildren(sessionId, current.parentSessionId ?? null);
        await this.options.clearSessionReference(current);
        // Last before the record: an earlier cleanup failure keeps the Session and
        // its previews intact; a missed file is reclaimed by the startup sweep.
        await this.options.cleanup.deletePptPreview(sessionId);
        await this.options.records.deleteSessionRecord(sessionId);
        this.options.facts.handle({
            kind: 'deleted',
            sessionId,
            ...(previousMainSessionId ? { previousMainSessionId } : {}),
        });
        return current;
    }
    /** The Bunny store never blocks deleting a Session; the startup orphan sweep retries. */
    async deleteAssignmentBestEffort(sessionId) {
        try {
            await this.options.cleanup.deleteAssignment(sessionId);
        }
        catch (error) {
            logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Could not delete the Session task row; the startup orphan sweep removes it');
        }
    }
}
//# sourceMappingURL=deletion-service.js.map