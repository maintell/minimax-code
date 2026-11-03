import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { collectV2SessionArtifactDiagnostics, resolveV2SessionArtifactPathsSync, } from './v2-session-artifacts.js';
import { ledgerFileSizeSync, needsJsonlLineBoundarySync, recoverFailedLedgerAppendSync, } from '../file/ledger-append-recovery.js';
import { compareLedgerEvents, scanLedgerEventsSync } from '../file/ledger-read.js';
import { isRecord, listTables, parseJsonOrThrow, parseJsonValueOrThrow, quoteIdentifier, rewriteStructuredValue, tableColumns, } from './agent-name-conflict-migration-files.js';
const JSON_COLUMNS = new Set([
    'record_json',
    'data_json',
    'items_json',
    'config_json',
    'request_json',
    'origin_channel_context_json',
    'payload_json',
    'value_json',
]);
const DIRECT_AGENT_TABLES = new Set([
    'local_runtime_crons',
    'local_runtime_cron_legacy_imports',
    'local_runtime_cron_session_history',
    'local_runtime_token_usage',
    'local_runtime_turn_diffs',
    'local_runtime_turn_diff_journal',
    'questionnaire_requests',
]);
const JSON_AGENT_TABLES = new Set([
    'local_runtime_agents',
    'local_runtime_sessions',
    'local_runtime_queues',
    'local_runtime_queue_items',
    'local_runtime_background_tasks',
    'local_runtime_crons',
    'questionnaire_requests',
    'local_runtime_preferences',
]);
const AGENT_REFERENCE_PREFERENCE_KEYS = new Set(['starred-agents', 'pinned-items-order']);
export function rewriteRuntimeReferences(dataDir, db, mappings, nowMs) {
    let updated = 0;
    const sessionRecords = [];
    const applyDbChanges = () => {
        const tables = listTables(db);
        for (const table of tables) {
            updated += rewriteRuntimeTable(db, { table, mappings, sessionRecords });
        }
        if (tables.includes('local_runtime_agents'))
            updated += rewriteRuntimeAgentRows(db, mappings, nowMs);
    };
    const applyRuntimeTransaction = db.transaction?.(applyDbChanges);
    if (applyRuntimeTransaction)
        applyRuntimeTransaction();
    else
        applyDbChanges();
    const knownSessionIds = new Set(sessionRecords.map((session) => session.sessionId));
    for (const session of discoverAffectedLedgerSessions(dataDir, mappings)) {
        if (knownSessionIds.has(session.sessionId))
            continue;
        const rewritten = rewriteStructuredValue(session.record, mappings, false);
        if (!isRecord(rewritten.value))
            continue;
        sessionRecords.push({ sessionId: session.sessionId, record: rewritten.value });
        knownSessionIds.add(session.sessionId);
    }
    for (const session of sessionRecords) {
        if (appendSessionMetadataEvent(dataDir, db, session, nowMs))
            updated += 1;
    }
    return updated;
}
function rewriteRuntimeTable(db, input) {
    let updated = 0;
    const { table, mappings, sessionRecords } = input;
    const columns = tableColumns(db, table);
    if (DIRECT_AGENT_TABLES.has(table) && columns.has('agent_name')) {
        for (const mapping of mappings) {
            const result = db
                .prepare(`UPDATE ${quoteIdentifier(table)} SET agent_name = ? WHERE agent_name = ?`)
                .run(mapping.to, mapping.from);
            updated += result.changes ?? 0;
        }
    }
    if (!JSON_AGENT_TABLES.has(table))
        return updated;
    for (const column of columns) {
        if (!JSON_COLUMNS.has(column))
            continue;
        updated += rewriteRuntimeColumn(db, { table, column, mappings, sessionRecords });
    }
    return updated;
}
function rewriteRuntimeColumn(db, input) {
    const { table, column, mappings, sessionRecords } = input;
    let updated = 0;
    const preferenceKeySelect = table === 'local_runtime_preferences' ? ', key AS __key' : '';
    const rows = db
        .prepare(`SELECT rowid AS __rowid, ${quoteIdentifier(column)} AS __value${preferenceKeySelect} FROM ${quoteIdentifier(table)}`)
        .all();
    for (const row of rows) {
        if (typeof row.__rowid !== 'number' || typeof row.__value !== 'string')
            continue;
        if (table === 'local_runtime_preferences' && !isAgentPreferenceKey(row.__key))
            continue;
        const value = rewriteStructuredValue(parseJsonValueOrThrow(row.__value, `${table}.${column}`), mappings, table === 'local_runtime_preferences' && isAgentPreferenceKey(row.__key));
        if (value.changed) {
            db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE rowid = ?`).run(JSON.stringify(value.value), row.__rowid);
            updated += value.count;
        }
        collectRewrittenSession({ table, column, mappings, sessionRecords }, value);
    }
    return updated;
}
function isAgentPreferenceKey(value) {
    return typeof value === 'string' && AGENT_REFERENCE_PREFERENCE_KEYS.has(value);
}
function collectRewrittenSession(input, value) {
    if (input.table !== 'local_runtime_sessions' || input.column !== 'record_json')
        return;
    const record = value.value;
    if (isRecord(record) &&
        typeof record.sessionId === 'string' &&
        (value.changed || input.mappings.some((mapping) => record.agentName === mapping.to))) {
        input.sessionRecords.push({ sessionId: record.sessionId, record });
    }
}
// `local_runtime_agents.name` is the v2 projection's primary key.
function rewriteRuntimeAgentRows(db, mappings, nowMs) {
    let updated = 0;
    for (const mapping of mappings) {
        const row = db
            .prepare('SELECT record_json FROM local_runtime_agents WHERE name = ?')
            .get(mapping.from);
        if (!row)
            continue;
        const record = typeof row.record_json === 'string'
            ? parseJsonOrThrow(row.record_json, 'local_runtime_agents.record_json')
            : {};
        const rewritten = rewriteStructuredValue(record, [mapping], false);
        if (isRecord(rewritten.value) && rewritten.value.name === mapping.from) {
            rewritten.value = { ...rewritten.value, name: mapping.to };
            rewritten.changed = true;
            rewritten.count += 1;
        }
        db.prepare('UPDATE local_runtime_agents SET name = ?, record_json = ?, updated_at_ms = ? WHERE name = ?').run(mapping.to, JSON.stringify(rewritten.value), nowMs(), mapping.from);
        updated += 1 + rewritten.count;
    }
    return updated;
}
export function discoverAffectedLedgerSessions(dataDir, mappings) {
    const diagnostics = collectV2SessionArtifactDiagnostics(dataDir, {
        maxSessions: Number.MAX_SAFE_INTEGER,
    });
    const affected = [];
    for (const diagnostic of diagnostics.sessions) {
        if (!diagnostic.files.ledger.exists)
            continue;
        const paths = resolveV2SessionArtifactPathsSync(dataDir, diagnostic.sessionId);
        if (!fs.existsSync(paths.ledger))
            continue;
        const events = scanLedgerEventsSync(paths.ledger, diagnostic.sessionId).map(({ event }) => event);
        const latestSessionEvent = events
            .filter((event) => event.kind === 'session.created' || event.kind === 'session.metadata_updated')
            .reduce((current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current), undefined);
        const record = readSessionEventRecord(latestSessionEvent);
        if (!record || typeof record.agentName !== 'string')
            continue;
        if (!mappings.some((mapping) => record.agentName === mapping.from || record.agentName === mapping.to)) {
            continue;
        }
        affected.push({ sessionId: diagnostic.sessionId, paths, record });
    }
    return affected;
}
function readSessionEventRecord(event) {
    if (!isRecord(event))
        return undefined;
    return isRecord(event.record) ? event.record : undefined;
}
function appendSessionMetadataEvent(dataDir, db, session, nowMs) {
    const { sessionId, record } = session;
    const paths = resolveV2SessionArtifactPathsSync(dataDir, sessionId);
    if (!fs.existsSync(paths.ledger))
        return false;
    const events = scanLedgerEventsSync(paths.ledger, sessionId).map(({ event }) => event);
    const dbWatermark = db
        .prepare('SELECT last_seq, last_event_id FROM local_runtime_ledger_watermarks WHERE session_id = ?')
        .get(sessionId);
    const projectionWatermark = db
        .prepare('SELECT last_seq, last_event_id FROM local_runtime_session_projection_watermarks WHERE session_id = ?')
        .get(sessionId);
    const latestLedgerEvent = events.reduce((current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current), undefined);
    const lastSeq = latestSequence(latestLedgerEvent, dbWatermark);
    const latestSessionEvent = events
        .filter((event) => event.kind === 'session.created' || event.kind === 'session.metadata_updated')
        .reduce((current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current), undefined);
    const latestSessionRecord = readSessionEventRecord(latestSessionEvent);
    if (latestSessionRecord &&
        latestSessionEvent &&
        latestSessionRecord.agentName === record.agentName) {
        const previousLedgerTip = events
            .filter((event) => compareLedgerEvents(event, latestSessionEvent) < 0)
            .reduce((current, next) => (!current || compareLedgerEvents(next, current) > 0 ? next : current), undefined);
        const projectionTarget = latestLedgerEvent && compareLedgerEvents(latestLedgerEvent, latestSessionEvent) > 0
            ? latestSessionEvent
            : (latestLedgerEvent ?? latestSessionEvent);
        const watermarkChanged = repairSessionWatermarks(db, {
            sessionId,
            ledgerTip: latestLedgerEvent ?? latestSessionEvent,
            projectionTarget,
            previousLedgerWatermark: dbWatermark,
            previousProjectionWatermark: projectionWatermark,
            directPreviousLedgerTip: previousLedgerTip,
            updatedAtMs: nowMs(),
        });
        fs.rmSync(paths.snapshot, { force: true });
        return watermarkChanged;
    }
    const createdAtMs = nowMs();
    const event = {
        schemaVersion: 1,
        eventId: `evt_${sessionId}_${lastSeq + 1}_${randomUUID().replace(/-/g, '')}`,
        sessionId,
        seq: lastSeq + 1,
        createdAtMs,
        kind: 'session.metadata_updated',
        record,
    };
    appendLedgerEvent(paths.ledger, event);
    repairSessionWatermarks(db, {
        sessionId,
        ledgerTip: event,
        projectionTarget: event,
        previousLedgerWatermark: dbWatermark,
        previousProjectionWatermark: projectionWatermark,
        directPreviousLedgerTip: latestLedgerEvent,
        updatedAtMs: createdAtMs,
    });
    fs.rmSync(paths.snapshot, { force: true });
    return true;
}
function latestSequence(event, watermark) {
    return Math.max(event?.seq ?? 0, Number(watermark?.last_seq ?? 0), 0);
}
function appendLedgerEvent(ledger, event) {
    const contents = `${needsJsonlLineBoundarySync(ledger) ? '\n' : ''}${JSON.stringify(event)}\n`;
    const preAppendSize = ledgerFileSizeSync(ledger);
    try {
        fs.appendFileSync(ledger, contents, 'utf8');
    }
    catch (error) {
        if (!recoverFailedLedgerAppendSync(ledger, preAppendSize, contents, error))
            throw error;
    }
}
function repairSessionWatermarks(db, input) {
    const { sessionId, ledgerTip, projectionTarget, previousLedgerWatermark, previousProjectionWatermark, directPreviousLedgerTip, updatedAtMs, } = input;
    const ledgerChanged = !watermarkMatches(previousLedgerWatermark, ledgerTip);
    if (ledgerChanged) {
        db.prepare(`INSERT INTO local_runtime_ledger_watermarks (session_id, last_seq, last_event_id, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq,last_event_id=excluded.last_event_id,updated_at_ms=excluded.updated_at_ms`).run(sessionId, ledgerTip.seq, ledgerTip.eventId, updatedAtMs);
    }
    const projectionCanAdvance = watermarkMatches(previousProjectionWatermark, projectionTarget) ||
        (directPreviousLedgerTip !== undefined &&
            watermarkMatches(previousProjectionWatermark, directPreviousLedgerTip));
    const projectionChanged = projectionCanAdvance && !watermarkMatches(previousProjectionWatermark, projectionTarget);
    if (projectionChanged) {
        db.prepare(`INSERT INTO local_runtime_session_projection_watermarks (session_id, last_seq, last_event_id, updated_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_seq=excluded.last_seq,last_event_id=excluded.last_event_id,updated_at_ms=excluded.updated_at_ms`).run(sessionId, projectionTarget.seq, projectionTarget.eventId, updatedAtMs);
    }
    return ledgerChanged || projectionChanged;
}
function watermarkMatches(watermark, event) {
    return (Number(watermark?.last_seq ?? 0) === event.seq && watermark?.last_event_id === event.eventId);
}
//# sourceMappingURL=agent-name-conflict-migration-runtime.js.map