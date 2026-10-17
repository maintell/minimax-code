import { and, eq } from 'drizzle-orm';
import { sessions } from '../../../../infra/db/schema/sessions.js';
/**
 * Coordinates deletion only inside the owning local-runtime process.
 *
 * Durable Turn settlement remains in TurnSystem. The Session gate deliberately
 * does not persist deletion state or fence unrelated Session tree mutations.
 */
export class SessionDeletionGate {
    options;
    turnAdmission;
    queueAdmission;
    deleting = new Set();
    constructor(options) {
        this.options = options;
        this.turnAdmission = {
            rejectionInTransaction: (db, input) => this.turnRejection(db, input.sessionId),
        };
        this.queueAdmission = {
            rejectionInTransaction: (db, input) => this.queueRejection(db, input.sessionId),
        };
    }
    begin(sessionId) {
        if (!sessionExists(this.options.db, sessionId)) {
            this.deleting.delete(sessionId);
            return Promise.resolve({ status: 'not-found' });
        }
        const status = this.deleting.has(sessionId) ? 'already-deleting' : 'started';
        this.deleting.add(sessionId);
        return Promise.resolve({ status });
    }
    complete(sessionId) {
        this.deleting.delete(sessionId);
    }
    turnRejection(db, sessionId) {
        if (!sessionExists(db, sessionId))
            return 'invalid-session';
        return this.deleting.has(sessionId) ? 'session-deleting' : undefined;
    }
    queueRejection(db, sessionId) {
        const rejection = this.turnRejection(db, sessionId);
        if (rejection === 'invalid-session')
            return 'session-not-found';
        return rejection === 'session-deleting' ? 'maintenance-active' : undefined;
    }
}
function sessionExists(db, sessionId) {
    return Boolean(db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
        .get());
}
//# sourceMappingURL=deletion-gate.js.map