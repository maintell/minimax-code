import { sql } from 'drizzle-orm';
import { normalizeSkillUsageKey, } from '@mavis/context-manager';
import { skillUsage } from '../../../infra/db/schema/skill-usage.js';
/** Rows per `INSERT … ON CONFLICT DO NOTHING`; four bound values each. */
const FIRST_SEEN_BATCH_ROWS = 200;
/**
 * Local usage counts of the `skill` tool, keyed by `normalizeSkillUsageKey(name)`.
 * Usage only ranks catalog descriptions, so every method fails open: a read error
 * reads as no usage and a write error drops that one count.
 */
export class SkillUsageStore {
    db;
    logger;
    constructor(db, logger) {
        this.db = db;
        this.logger = logger;
    }
    /** One successful load of `key`; creates the row on its first use. */
    recordUse(key, nowMs) {
        try {
            this.db
                .insert(skillUsage)
                .values({ skillKey: key, useCount: 1, lastUsedAtMs: nowMs, firstSeenAtMs: nowMs })
                .onConflictDoUpdate({
                target: skillUsage.skillKey,
                set: {
                    useCount: sql `${skillUsage.useCount} + 1`,
                    lastUsedAtMs: sql `max(${skillUsage.lastUsedAtMs}, ${nowMs})`,
                },
            })
                .run();
        }
        catch (error) {
            this.warn('record_use', error);
        }
    }
    /** Records when the catalog first listed each key; existing rows keep theirs. */
    ensureFirstSeen(keys, nowMs) {
        const unique = [...new Set(keys)];
        try {
            this.db.transaction((tx) => {
                for (let start = 0; start < unique.length; start += FIRST_SEEN_BATCH_ROWS) {
                    tx.insert(skillUsage)
                        .values(unique.slice(start, start + FIRST_SEEN_BATCH_ROWS).map((skillKey) => ({
                        skillKey,
                        useCount: 0,
                        lastUsedAtMs: 0,
                        firstSeenAtMs: nowMs,
                    })))
                        .onConflictDoNothing({ target: skillUsage.skillKey })
                        .run();
                }
            });
        }
        catch (error) {
            this.warn('ensure_first_seen', error);
        }
    }
    /**
     * The catalog window's usage read: first sight of every listed name, then all rows.
     * Only a window that commits stamps first sight; a read-only build (manual
     * compaction, title, advisor) must not start the new-Skill protection clock.
     */
    readCatalogUsage(names, nowMs, commit = true) {
        if (commit)
            this.ensureFirstSeen(names.map(normalizeSkillUsageKey), nowMs);
        return this.readAll();
    }
    readAll() {
        try {
            return new Map(this.db
                .select()
                .from(skillUsage)
                .all()
                .map((row) => [
                row.skillKey,
                {
                    useCount: row.useCount,
                    lastUsedAtMs: row.lastUsedAtMs,
                    firstSeenAtMs: row.firstSeenAtMs,
                },
            ]));
        }
        catch (error) {
            this.warn('read_all', error);
            return new Map();
        }
    }
    warn(operation, error) {
        try {
            this.logger?.warn({
                event: 'skill_usage_store_failed',
                operation,
                reason: error instanceof Error ? error.message : String(error),
            }, '[skill-usage] store operation failed; the catalog ranks without it');
        }
        catch {
            // Diagnostics must not affect the caller.
        }
    }
}
//# sourceMappingURL=usage-store.js.map