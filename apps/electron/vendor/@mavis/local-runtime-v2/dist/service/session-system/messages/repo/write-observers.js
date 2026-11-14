import { eq } from 'drizzle-orm';
import { sessions } from '../../../../infra/db/schema/sessions.js';
const NONE = [];
/**
 * The observers of one database's message writes, shared by every writer of its
 * message rows. Which observers a Session has is read once from its row and
 * kept: a Session that no observer sees then writes with no extra statement and
 * no observer call. Without observers nothing is read at all.
 */
export class MessageWriteObservers {
    observers;
    bySession = new Map();
    constructor(observers = NONE) {
        this.observers = observers;
    }
    written(tx, sessionId, messageId) {
        for (const observer of this.of(tx, sessionId))
            observer.written(tx, { sessionId, messageId });
    }
    deleted(tx, deletion) {
        if (deletion.messageIds?.length === 0)
            return;
        for (const observer of this.of(tx, deletion.sessionId))
            observer.deleted(tx, deletion);
        if (deletion.sessionDataDeleted)
            this.bySession.delete(deletion.sessionId);
    }
    of(tx, sessionId) {
        if (this.observers.length === 0)
            return NONE;
        const known = this.bySession.get(sessionId);
        if (known)
            return known;
        let row;
        try {
            row = tx
                .select({ agentName: sessions.agentName, sessionKind: sessions.sessionKind })
                .from(sessions)
                .where(eq(sessions.sessionId, sessionId))
                .get();
        }
        catch {
            // Undecided: every observer runs and contains its own failures.
            return this.observers;
        }
        // Without its row (deleted before its messages) the Session stays undecided.
        if (!row)
            return this.observers;
        const session = row;
        const observing = this.observers.filter((observer) => observer.observes(session));
        const kept = observing.length === 0 ? NONE : observing;
        this.bySession.set(sessionId, kept);
        return kept;
    }
}
//# sourceMappingURL=write-observers.js.map