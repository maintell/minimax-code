import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { sessionFileSyncs } from '../../../../infra/db/schema/session-file-sync.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
/** Keeps every `IN (...)` well under SQLite's bound-parameter limit. */
const PATH_QUERY_CHUNK = 500;
export function createSessionFileSyncRepository(options) {
    const { db } = options;
    return {
        async querySources({ nodeIds, offset, limit }) {
            const rows = db
                .select({
                sessionId: sessionFileSyncs.sessionId,
                path: sessionFileSyncs.path,
                nodeId: sessionFileSyncs.nodeId,
                updatedAtMs: sessionFileSyncs.updatedAtMs,
                sha256: sessionFileSyncs.sha256,
                accountId: sessionFileSyncs.accountId,
            })
                .from(sessionFileSyncs)
                .innerJoin(sessions, eq(sessionFileSyncs.sessionId, sessions.sessionId))
                .where(and(eq(sessions.columnarVersion, 3), eq(sessions.visibility, 'visible'), nodeIds ? inArray(sessionFileSyncs.nodeId, [...nodeIds]) : undefined))
                .orderBy(desc(sessionFileSyncs.updatedAtMs), asc(sessionFileSyncs.sessionId), asc(sessionFileSyncs.path))
                .limit(limit)
                .offset(offset)
                .all();
            return rows.map((row) => ({ ...row, accountId: row.accountId ?? undefined }));
        },
        async invalidateSources(sources) {
            return db.transaction((tx) => sources.flatMap((source) => tx
                .delete(sessionFileSyncs)
                .where(and(eq(sessionFileSyncs.sessionId, source.sessionId), eq(sessionFileSyncs.path, source.path), eq(sessionFileSyncs.nodeId, source.nodeId), eq(sessionFileSyncs.updatedAtMs, source.updatedAtMs), eq(sessionFileSyncs.sha256, source.sha256), source.accountId
                ? eq(sessionFileSyncs.accountId, source.accountId)
                : isNull(sessionFileSyncs.accountId)))
                .returning({
                sessionId: sessionFileSyncs.sessionId,
                path: sessionFileSyncs.path,
                nodeId: sessionFileSyncs.nodeId,
                updatedAtMs: sessionFileSyncs.updatedAtMs,
                sha256: sessionFileSyncs.sha256,
            })
                .all()));
        },
        async bindOwner(sources, accountId) {
            db.transaction((tx) => {
                for (const source of sources)
                    tx.update(sessionFileSyncs)
                        .set({ accountId })
                        .where(and(eq(sessionFileSyncs.sessionId, source.sessionId), eq(sessionFileSyncs.path, source.path), eq(sessionFileSyncs.nodeId, source.nodeId), eq(sessionFileSyncs.updatedAtMs, source.updatedAtMs), eq(sessionFileSyncs.sha256, source.sha256), isNull(sessionFileSyncs.accountId)))
                        .run();
            });
        },
        async getByPaths(sessionId, paths) {
            const unique = [...new Set(paths)];
            const records = [];
            for (let start = 0; start < unique.length; start += PATH_QUERY_CHUNK) {
                const chunk = unique.slice(start, start + PATH_QUERY_CHUNK);
                records.push(...db
                    .select()
                    .from(sessionFileSyncs)
                    .where(and(eq(sessionFileSyncs.sessionId, sessionId), inArray(sessionFileSyncs.path, chunk)))
                    .all());
            }
            return records;
        },
        async upsert(record) {
            db.insert(sessionFileSyncs)
                .values(record)
                .onConflictDoUpdate({
                target: [sessionFileSyncs.sessionId, sessionFileSyncs.path],
                set: {
                    nodeId: record.nodeId,
                    accountId: record.accountId ?? null,
                    sha256: record.sha256,
                    size: record.size,
                    mtimeMs: record.mtimeMs,
                    drivePath: record.drivePath,
                    updatedAtMs: sql `max(${sessionFileSyncs.updatedAtMs} + 1, ${record.updatedAtMs})`,
                },
            })
                .run();
        },
        async updateStat(input) {
            // Guarded by sha256 so a concurrent re-upload's row is never stamped with this stat.
            db.update(sessionFileSyncs)
                .set({ size: input.size, mtimeMs: input.mtimeMs })
                .where(and(eq(sessionFileSyncs.sessionId, input.sessionId), eq(sessionFileSyncs.path, input.path), eq(sessionFileSyncs.sha256, input.sha256)))
                .run();
        },
        async deleteSession(sessionId) {
            db.delete(sessionFileSyncs).where(eq(sessionFileSyncs.sessionId, sessionId)).run();
        },
    };
}
//# sourceMappingURL=file-syncs.js.map