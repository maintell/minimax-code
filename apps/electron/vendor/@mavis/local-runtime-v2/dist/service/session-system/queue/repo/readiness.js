import { eq } from 'drizzle-orm';
import { queueRowMigrations } from '../../../../infra/db/schema/queue.js';
export function ensureQueueRowsReadyInTransaction(db, sessionId, nowMs) {
    const marker = db
        .select()
        .from(queueRowMigrations)
        .where(eq(queueRowMigrations.sessionId, sessionId))
        .get();
    if (marker)
        return;
    db.insert(queueRowMigrations)
        .values({ sessionId, queueRowsBackfilledAtMs: nowMs })
        .onConflictDoNothing()
        .run();
}
//# sourceMappingURL=readiness.js.map