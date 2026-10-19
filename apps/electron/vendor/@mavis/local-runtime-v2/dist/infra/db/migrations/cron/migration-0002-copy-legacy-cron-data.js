import { createHash } from 'node:crypto';
import { Cron } from 'croner';
export const migration = {
    version: 2,
    name: 'copy-legacy-cron-data',
    up: copyLegacyCronData,
};
function copyLegacyCronData(database) {
    if (!tableExists(database, 'local_runtime_crons'))
        return;
    const appliedAtMs = Date.now();
    timestamp(appliedAtMs, 'migration nowMs');
    const rows = database
        .prepare(`SELECT agent_name, cron_name, config_json, updated_at_ms, cron_id
       FROM local_runtime_crons
       ORDER BY agent_name, cron_name`)
        .all();
    const insertJob = database.prepare(`INSERT INTO local_runtime_v2_scheduler_jobs
       (scheduler_id, handler_key, schedule_json, run_count, state, next_run_at_ms,
        created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertDefinition = database.prepare(`INSERT INTO local_runtime_v2_cron_definitions
       (cron_id, scheduler_id, agent_name, name, prompt, target_session_id,
        revision, deleted_at_ms, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
        timestamp(row.updated_at_ms, 'legacy updatedAtMs');
        const config = parseLegacyConfig(row.config_json);
        const schedule = legacySchedule(config);
        const cronId = validCronId(row.cron_id) ?? stableLegacyId('cron', row.agent_name, row.cron_name);
        const schedulerId = stableLegacyId('scheduler', cronId);
        const state = legacySchedulerState(config, schedule, appliedAtMs);
        insertJob.run(schedulerId, 'cron.run', JSON.stringify(schedule), 0, state, legacyNextRunAtMs(schedule, state, appliedAtMs), row.updated_at_ms, row.updated_at_ms);
        insertDefinition.run(cronId, schedulerId, row.agent_name, row.cron_name, config.prompt, legacyTargetSessionId(config) ?? null, 0, null, row.updated_at_ms, row.updated_at_ms);
    }
    copyLegacyCronRunHistory(database);
}
/** Frozen history projection shared by fresh version 2 and compatibility version 4. */
export function copyLegacyCronRunHistory(database, options = {}) {
    if (!tableExists(database, 'local_runtime_v2_cron_runs'))
        return;
    const cronIds = loadMigratedLegacyCronIds(database);
    const persistedRuns = loadPersistedCronRuns(database);
    const nativeHistory = copyNativeLegacyRunHistory(database, cronIds, persistedRuns);
    copyPurposeLegacyRunHistory(database, cronIds, nativeHistory.sessions, persistedRuns);
    if (options.warnOnOrphanedNativeRows) {
        warnAboutOrphanedLegacyHistory(nativeHistory.orphanedRowCount);
    }
}
function loadMigratedLegacyCronIds(database) {
    const cronIds = new Map();
    if (!tableExists(database, 'local_runtime_crons'))
        return cronIds;
    const migratedCronIds = new Set(database.prepare('SELECT cron_id FROM local_runtime_v2_cron_definitions').all().map((row) => row.cron_id));
    const legacyRows = database
        .prepare(`SELECT agent_name, cron_name, config_json, updated_at_ms, cron_id
       FROM local_runtime_crons
       ORDER BY agent_name, cron_name`)
        .all();
    for (const row of legacyRows) {
        const cronId = validCronId(row.cron_id) ?? stableLegacyId('cron', row.agent_name, row.cron_name);
        if (!migratedCronIds.has(cronId)) {
            throw new Error(`Legacy Cron Definition was not migrated: ${row.agent_name}/${row.cron_name}`);
        }
        cronIds.set(legacyCronKey(row.agent_name, row.cron_name), cronId);
    }
    return cronIds;
}
function loadPersistedCronRuns(database) {
    const rows = database
        .prepare(`SELECT run_id, cron_id, scheduler_trigger_id, trigger_source, session_id, status,
              created_at_ms, execution_claimed_at_ms, delivered_at_ms, failed_at_ms,
              error_code, error
       FROM local_runtime_v2_cron_runs`)
        .all();
    return new Map(rows.map((row) => [row.run_id, row]));
}
function copyNativeLegacyRunHistory(database, cronIds, persistedRuns) {
    const sessions = new Set();
    let orphanedRowCount = 0;
    if (!tableExists(database, 'local_runtime_cron_session_history')) {
        return { sessions, orphanedRowCount };
    }
    const historyRows = database
        .prepare(`SELECT id, agent_name, cron_name, session_id, created_at_ms
       FROM local_runtime_cron_session_history
       ORDER BY created_at_ms, id`)
        .all();
    for (const row of historyRows) {
        const agentName = nonEmpty(row.agent_name, 'legacy history agentName');
        const cronName = nonEmpty(row.cron_name, 'legacy history cronName');
        const cronId = cronIds.get(legacyCronKey(agentName, cronName));
        if (!cronId) {
            orphanedRowCount += 1;
            continue;
        }
        const sourceId = String(requiredNumber(row.id, 'legacy history id'));
        const sessionId = nonEmpty(row.session_id, 'legacy history sessionId');
        const createdAtMs = requiredNumber(row.created_at_ms, 'legacy history createdAtMs');
        insertLegacyRun(database, persistedRuns, {
            cronId,
            sessionId,
            createdAtMs,
            sourceKind: 'history',
            sourceId,
        });
        sessions.add(legacyRunSessionKey(cronId, sessionId));
    }
    return { sessions, orphanedRowCount };
}
function warnAboutOrphanedLegacyHistory(rowCount) {
    if (rowCount === 0)
        return;
    process.emitWarning(`Skipped ${rowCount} orphaned legacy Cron history ${rowCount === 1 ? 'row' : 'rows'}`, { code: 'MAVIS_CRON_MIGRATION_ORPHAN_HISTORY_SKIPPED' });
}
function copyPurposeLegacyRunHistory(database, cronIds, nativeSessions, persistedRuns) {
    if (!tableExists(database, 'local_runtime_sessions'))
        return;
    const sessionRows = database
        .prepare(`SELECT session_id, record_json, updated_at_ms
       FROM local_runtime_sessions
       ORDER BY updated_at_ms, session_id`)
        .all();
    for (const row of sessionRows) {
        const record = parseLegacySessionRecord(row.record_json);
        if (!record)
            continue;
        const purpose = parseLegacyCronSessionPurpose(record.purpose);
        if (!purpose || purpose.cronName === 'memory-cleanup')
            continue;
        const cronId = cronIds.get(legacyCronKey(purpose.agentName, purpose.cronName));
        if (!cronId)
            continue;
        const sessionId = nonEmpty(row.session_id, 'legacy session sessionId');
        if (nativeSessions.has(legacyRunSessionKey(cronId, sessionId)))
            continue;
        insertLegacyRun(database, persistedRuns, {
            cronId,
            sessionId,
            createdAtMs: requiredNumber(record.createdAtMs, 'legacy session createdAtMs'),
            sourceKind: 'session',
            sourceId: sessionId,
        });
    }
}
function insertLegacyRun(database, persistedRuns, input) {
    // V1 rows prove only that a Cron session existed. scheduled + delivered keeps
    // old sessions visible in the UI; it is not evidence of successful delivery.
    const digest = stableLegacyDigest(input.cronId, input.sourceKind, input.sourceId);
    const expected = {
        run_id: `legacy-run-${digest}`,
        cron_id: input.cronId,
        scheduler_trigger_id: `legacy-trigger-${digest}`,
        trigger_source: 'scheduled',
        session_id: input.sessionId,
        status: 'delivered',
        created_at_ms: input.createdAtMs,
        execution_claimed_at_ms: input.createdAtMs,
        delivered_at_ms: input.createdAtMs,
        failed_at_ms: null,
        error_code: null,
        error: null,
    };
    const existing = persistedRuns.get(expected.run_id);
    if (existing) {
        if (legacyRunFingerprint(existing) !== legacyRunFingerprint(expected)) {
            throw new Error(`Legacy Cron run conflicts with existing data: ${expected.run_id}`);
        }
        return;
    }
    database
        .prepare(`INSERT INTO local_runtime_v2_cron_runs
         (run_id, cron_id, scheduler_trigger_id, trigger_source, session_id, status,
          created_at_ms, execution_claimed_at_ms, delivered_at_ms, failed_at_ms,
          error_code, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(expected.run_id, expected.cron_id, expected.scheduler_trigger_id, expected.trigger_source, expected.session_id, expected.status, expected.created_at_ms, expected.execution_claimed_at_ms, expected.delivered_at_ms, expected.failed_at_ms, expected.error_code, expected.error);
    persistedRuns.set(expected.run_id, expected);
}
function legacyRunFingerprint(run) {
    return JSON.stringify([
        run.cron_id,
        run.scheduler_trigger_id,
        run.trigger_source,
        run.session_id,
        run.status,
        run.created_at_ms,
        run.execution_claimed_at_ms,
        run.delivered_at_ms,
        run.failed_at_ms,
        run.error_code,
        run.error,
    ]);
}
function parseLegacySessionRecord(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null)
            return undefined;
        const record = parsed;
        if (typeof record.purpose !== 'string')
            return undefined;
        return { purpose: record.purpose, createdAtMs: record.createdAtMs };
    }
    catch {
        return undefined;
    }
}
function parseLegacyCronSessionPurpose(purpose) {
    const prefix = 'cron:';
    if (!purpose.startsWith(prefix))
        return undefined;
    const [agentName, ...cronNameParts] = purpose.slice(prefix.length).split(':');
    const cronName = cronNameParts.join(':');
    return agentName && cronName ? { agentName, cronName } : undefined;
}
function legacyCronKey(agentName, cronName) {
    return `${agentName.length}:${agentName}${cronName}`;
}
function legacyRunSessionKey(cronId, sessionId) {
    return `${cronId.length}:${cronId}${sessionId}`;
}
function tableExists(database, tableName) {
    const rows = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all();
    return rows.some((row) => row.name === tableName);
}
function parseLegacyConfig(raw) {
    const parsed = asRecord(JSON.parse(raw));
    const scheduleType = parsed.scheduleType === 'once' ? 'once' : 'recurring';
    return {
        prompt: nonEmpty(parsed.prompt, 'config.prompt'),
        disabled: parsed.disabled === true,
        scheduleType,
        ...(typeof parsed.schedule === 'string' ? { schedule: parsed.schedule } : {}),
        ...(typeof parsed.timezone === 'string' ? { timezone: parsed.timezone } : {}),
        ...(typeof parsed.runAtMs === 'number' ? { runAtMs: parsed.runAtMs } : {}),
        ...(typeof parsed.session === 'object' && parsed.session !== null
            ? { session: parsed.session }
            : {}),
    };
}
function legacySchedule(config) {
    if (config.scheduleType === 'once') {
        return { kind: 'once', runAtMs: requiredNumber(config.runAtMs, 'config.runAtMs') };
    }
    return {
        kind: 'cron',
        expression: nonEmpty(config.schedule, 'config.schedule'),
        ...(config.timezone === undefined
            ? {}
            : { timezone: nonEmpty(config.timezone, 'config.timezone') }),
    };
}
function legacySchedulerState(config, schedule, nowMs) {
    if (config.disabled)
        return 'cancelled';
    if (schedule.kind === 'once' && schedule.runAtMs <= nowMs)
        return 'expired';
    return 'active';
}
function legacyNextRunAtMs(schedule, state, nowMs) {
    if (state !== 'active')
        return null;
    if (schedule.kind === 'once')
        return schedule.runAtMs;
    const timer = new Cron(schedule.expression, {
        timezone: schedule.timezone,
        paused: true,
        unref: true,
    });
    try {
        const nextRun = timer.nextRun(new Date(nowMs));
        if (!nextRun)
            throw new Error('Legacy Cron schedule has no future run');
        return nextRun.getTime();
    }
    finally {
        timer.stop();
    }
}
function legacyTargetSessionId(config) {
    return config.session?.mode === 'sessionId' && config.session.sessionId
        ? nonEmpty(config.session.sessionId, 'config.session.sessionId')
        : undefined;
}
function validCronId(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
function stableLegacyId(kind, ...parts) {
    return `legacy-${kind}-${stableLegacyDigest(...parts)}`;
}
function stableLegacyDigest(...parts) {
    return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}
function asRecord(value) {
    if (typeof value !== 'object' || value === null)
        throw new Error('Legacy Cron config is invalid');
    return value;
}
function nonEmpty(value, field) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${field} must be non-empty`);
    }
    return value;
}
function requiredNumber(value, field) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`${field} is invalid`);
    return value;
}
function timestamp(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a Unix millisecond integer`);
    }
}
//# sourceMappingURL=migration-0002-copy-legacy-cron-data.js.map