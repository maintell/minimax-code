import { count, inArray } from 'drizzle-orm';
import { sessions } from '../../../../infra/db/schema/sessions.js';
/** Rows per main-database existence query, matching the assignment repository's chunk. */
const SESSION_ORPHAN_CHUNK = 500;
export function createMainSessionIndex(db) {
    return {
        count: async () => db.select({ total: count() }).from(sessions).get()?.total ?? 0,
        existing: async (sessionIds) => new Set(db
            .select({ sessionId: sessions.sessionId })
            .from(sessions)
            .where(inArray(sessions.sessionId, [...sessionIds]))
            .all()
            .map((row) => row.sessionId)),
    };
}
/**
 * Deletes Bunny-store rows whose Session is gone from the main database. The two stores share
 * no foreign key, so this is the startup backstop for a deletion that stopped half-way. Reads
 * the Bunny store, then the main database, then writes the Bunny store; no transaction spans
 * both. Every guard is checked before anything is read.
 */
export async function sweepSessionOrphans(input) {
    if (!input.guard.persistedStateRecovered)
        return { status: 'skipped', reason: 'not-recovered' };
    if (input.guard.mainDatabaseSafeMode)
        return { status: 'skipped', reason: 'safe-mode' };
    if ((await input.sessions.count()) === 0)
        return { status: 'skipped', reason: 'no-sessions' };
    const ids = [...new Set(await input.rows.listSessionIds())];
    const chunkSize = Math.max(1, input.chunkSize ?? SESSION_ORPHAN_CHUNK);
    let orphans = 0;
    let deleted = 0;
    for (let index = 0; index < ids.length; index += chunkSize) {
        const chunk = ids.slice(index, index + chunkSize);
        const existing = await input.sessions.existing(chunk);
        const missing = chunk.filter((sessionId) => !existing.has(sessionId));
        if (missing.length === 0)
            continue;
        orphans += missing.length;
        deleted += await input.rows.deleteForSessions(missing);
    }
    return { status: 'swept', checked: ids.length, orphans, deleted };
}
//# sourceMappingURL=orphan-sweep.js.map