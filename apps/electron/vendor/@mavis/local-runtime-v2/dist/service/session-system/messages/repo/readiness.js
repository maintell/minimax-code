import { eq } from 'drizzle-orm';
import { legacyMessages, messageRowMigrations } from '../../../../infra/db/schema/messages.js';
import { MessageDataCorruptionError } from './contract.js';
export function ensureMessageRowsReadyInTransaction(db, sessionId, nowMs, write) {
    const marker = db
        .select()
        .from(messageRowMigrations)
        .where(eq(messageRowMigrations.sessionId, sessionId))
        .get();
    if (marker)
        return;
    const source = db
        .select()
        .from(legacyMessages)
        .where(eq(legacyMessages.sessionId, sessionId))
        .get();
    const messages = source ? parseLegacyMessages(source.displayMessagesJson, sessionId) : [];
    messages.forEach(write);
    db.insert(messageRowMigrations)
        .values({ sessionId, displayRowsBackfilledAtMs: nowMs })
        .onConflictDoNothing()
        .run();
    if (source) {
        db.update(legacyMessages)
            .set({ displayMessagesJson: '[]' })
            .where(eq(legacyMessages.sessionId, sessionId))
            .run();
    }
}
function parseLegacyMessages(raw, sessionId) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new MessageDataCorruptionError(sessionId, 'legacy-display-blob');
    }
    if (!Array.isArray(parsed) || !parsed.every(isObject)) {
        throw new MessageDataCorruptionError(sessionId, 'legacy-display-blob');
    }
    return parsed;
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=readiness.js.map