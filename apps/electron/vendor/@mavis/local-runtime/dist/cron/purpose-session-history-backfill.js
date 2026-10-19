import { MEMORY_CLEANUP_CRON_NAME, parseCronSessionPurpose } from '@mavis/shared/cron-purpose';
import { logger } from '../common/logger.js';
import { withLocalRuntimeDb } from '../persistence/db.js';
export const CRON_PURPOSE_SESSION_HISTORY_BACKFILL_KEY = 'cron-purpose-session-history-backfill-v1';
export class SqliteCronDataMigrationStore {
    dataDir;
    nowMs;
    constructor(dataDir, nowMs = () => Date.now()) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    async has(migrationKey) {
        return this.withDb((db) => {
            const row = db
                .prepare(`SELECT 1 FROM local_runtime_cron_data_migrations
           WHERE migration_key = ?`)
                .get(migrationKey);
            return row !== undefined;
        });
    }
    async record(migrationKey, details) {
        this.withDb((db) => {
            db.prepare(`INSERT OR IGNORE INTO local_runtime_cron_data_migrations
           (migration_key, applied_at_ms, details_json)
         VALUES (?, ?, ?)`).run(migrationKey, this.nowMs(), JSON.stringify(details));
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
/**
 * One-shot compatibility backfill for the DesktopService cron_id migration.
 *
 * Older runtime/UI paths grouped cron runs from session metadata
 * (`purpose=cron:<agent>:<cron>`), while the IDL DesktopService contract reads
 * from `local_runtime_cron_session_history` by cron_id. This imports the
 * metadata-tagged runs into the native history table once per dataDir so the UI
 * does not need to re-scan aggregate sessions on every sidebar render.
 */
export async function backfillCronSessionHistoryFromPurposeSessions(deps) {
    const result = {
        scanned: 0,
        backfilled: 0,
        touchedTasks: 0,
        skippedAlreadyApplied: false,
        skippedInvalidPurpose: 0,
        skippedMemoryCleanup: 0,
        skippedNoTask: 0,
        skippedExistingSession: 0,
        failed: 0,
    };
    try {
        if (await deps.dataMigrationStore.has(CRON_PURPOSE_SESSION_HISTORY_BACKFILL_KEY)) {
            result.skippedAlreadyApplied = true;
            return result;
        }
        const sessions = await deps.listAllSessions(undefined, {
            includeHidden: true,
            includePurposePrefix: 'cron:',
        });
        const grouped = groupPurposeSessions(sessions, result);
        for (const group of grouped.values()) {
            const task = await deps.cronStore.get(group.agentName, group.cronName);
            if (!task) {
                result.skippedNoTask += group.records.length;
                continue;
            }
            const existing = await deps.cronStore.getSessionHistory(group.agentName, group.cronName);
            const bySessionId = new Map(existing.map((record) => [record.sessionId, record]));
            let added = 0;
            for (const record of group.records) {
                if (bySessionId.has(record.sessionId)) {
                    result.skippedExistingSession += 1;
                    continue;
                }
                bySessionId.set(record.sessionId, record);
                added += 1;
            }
            if (added === 0)
                continue;
            const merged = [...bySessionId.values()].sort((left, right) => left.createdAt - right.createdAt || left.sessionId.localeCompare(right.sessionId));
            await deps.cronStore.replaceSessionHistory(group.agentName, group.cronName, merged);
            result.backfilled += added;
            result.touchedTasks += 1;
        }
        await deps.dataMigrationStore.record(CRON_PURPOSE_SESSION_HISTORY_BACKFILL_KEY, {
            scanned: result.scanned,
            backfilled: result.backfilled,
            touchedTasks: result.touchedTasks,
            skippedInvalidPurpose: result.skippedInvalidPurpose,
            skippedMemoryCleanup: result.skippedMemoryCleanup,
            skippedNoTask: result.skippedNoTask,
            skippedExistingSession: result.skippedExistingSession,
        });
        if (result.backfilled > 0) {
            logger.info({ ...result }, '[cron-history-backfill] Imported purpose-tagged cron sessions');
        }
    }
    catch (err) {
        result.failed += 1;
        logger.error({ ...result, err: err instanceof Error ? err.message : String(err) }, '[cron-history-backfill] Failed to import purpose-tagged cron sessions');
    }
    return result;
}
function groupPurposeSessions(sessions, result) {
    const grouped = new Map();
    const seenByGroup = new Map();
    for (const session of sessions) {
        result.scanned += 1;
        const parsed = parseCronSessionPurpose(session.purpose);
        if (!parsed) {
            result.skippedInvalidPurpose += 1;
            continue;
        }
        if (parsed.cronName === MEMORY_CLEANUP_CRON_NAME) {
            result.skippedMemoryCleanup += 1;
            continue;
        }
        const key = `${parsed.agentName}:${parsed.cronName}`;
        const seen = seenByGroup.get(key) ?? new Set();
        if (seen.has(session.sessionId)) {
            result.skippedExistingSession += 1;
            continue;
        }
        seen.add(session.sessionId);
        seenByGroup.set(key, seen);
        const group = grouped.get(key) ?? {
            agentName: parsed.agentName,
            cronName: parsed.cronName,
            records: [],
        };
        group.records.push({ sessionId: session.sessionId, createdAt: session.createdAtMs });
        grouped.set(key, group);
    }
    return grouped;
}
//# sourceMappingURL=purpose-session-history-backfill.js.map