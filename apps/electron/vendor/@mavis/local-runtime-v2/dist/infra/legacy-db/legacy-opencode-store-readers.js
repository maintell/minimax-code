import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadBetterSqlite3Module } from './better-sqlite3-loader.js';
import {} from './legacy-opencode-store-contracts.js';
import { DEFAULT_MESSAGE_PAGE_BYTES } from './legacy-opencode-store-values.js';
const SQLITE_IN_CHUNK_SIZE = 500;
export function readLatestParsedMessages(db, input) {
    const chunkSize = Math.max(input.limit * 4 + 1, 50);
    const messages = [];
    let offset = 0;
    while (messages.length <= input.limit) {
        const rows = db
            .prepare(`
        SELECT ${input.idColumn} AS id, data
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ${input.idColumn} DESC
        LIMIT ? OFFSET ?
      `)
            .all(input.sessionId, chunkSize, offset);
        if (rows.length === 0)
            break;
        for (const row of rows) {
            const message = parseMessageRow(row);
            if (message)
                messages.push(message);
            if (messages.length > input.limit)
                break;
        }
        offset += rows.length;
        if (rows.length < chunkSize)
            break;
    }
    return messages;
}
export function readNativeMessagesFromDb(db, candidate, session) {
    const schema = inspectLegacySchema(db);
    const warnings = [];
    const nativeSessionId = resolveNativeSessionId(db, schema, session);
    if (!nativeSessionId)
        return undefined;
    const messageTable = firstExistingTable(schema, ['message', 'session_message', 'messages']);
    const partTable = firstExistingTable(schema, ['part', 'message_part', 'message_parts']);
    if (!messageTable)
        return undefined;
    const messageColumns = schema.tables.get(messageTable) ?? new Set();
    const messageSessionColumn = firstColumn(messageColumns, ['session_id', 'sessionID']);
    const messageIdColumn = firstColumn(messageColumns, ['id', 'message_id', 'messageID']);
    if (!messageSessionColumn || !messageIdColumn)
        return undefined;
    const messageOrder = buildNativeOrderBy(messageColumns, [
        // opencode 0.7+ column
        'time_created',
        // legacy candidates + generic fallbacks
        'time',
        'timestamp',
        'created_at',
        'seq',
        'id',
    ]);
    const messageRows = db
        .prepare(`
      SELECT *
      FROM ${quoteIdentifier(messageTable)}
      WHERE ${quoteIdentifier(messageSessionColumn)} = ?
      ${messageOrder}
    `)
        .all(nativeSessionId);
    if (messageRows.length === 0)
        return undefined;
    const messageIds = new Set(messageRows.flatMap((row) => {
        const id = readStringField(row, [messageIdColumn, 'id', 'message_id', 'messageID']);
        return id ? [id] : [];
    }));
    const partRowsByMessageId = readNativePartsByMessage(db, {
        schema,
        partTable,
        messageIds,
        warnings,
    });
    return {
        source: candidate,
        nativeSessionId,
        warnings,
        messages: messageRows.flatMap((row) => {
            const message = nativeMessageFromRow(row, messageIdColumn);
            if (!message)
                return [];
            const partRows = partRowsByMessageId.get(message.id) ?? [];
            const parts = partRows.flatMap(nativePartFromRow);
            return [{ ...message, parts: parts.length > 0 ? parts : inferNativePartsFromMessage(row) }];
        }),
    };
}
function readNativePartsByMessage(db, input) {
    const { schema, partTable, messageIds, warnings } = input;
    const partRowsByMessageId = new Map();
    if (!partTable) {
        warnings.push('legacy_native_schema_missing:part');
        return partRowsByMessageId;
    }
    const partColumns = schema.tables.get(partTable) ?? new Set();
    const partMessageColumn = firstColumn(partColumns, ['message_id', 'messageID', 'message']);
    if (partMessageColumn) {
        const partOrder = buildNativeOrderBy(partColumns, [
            'seq',
            // opencode 0.7+ column
            'time_created',
            'time',
            'timestamp',
            'created_at',
            'id',
        ]);
        for (const row of readNativePartRowsForMessages(db, {
            partTable,
            partMessageColumn,
            partOrder,
            messageIds: [...messageIds],
        })) {
            const messageId = readStringField(row, [partMessageColumn]);
            if (!messageId)
                continue;
            const rows = partRowsByMessageId.get(messageId) ?? [];
            rows.push(row);
            partRowsByMessageId.set(messageId, rows);
        }
    }
    else {
        warnings.push(`legacy_native_schema_missing:${partTable}.message_id`);
    }
    return partRowsByMessageId;
}
function readNativePartRowsForMessages(db, input) {
    if (input.messageIds.length === 0)
        return [];
    const rows = [];
    for (let index = 0; index < input.messageIds.length; index += SQLITE_IN_CHUNK_SIZE) {
        const chunk = input.messageIds.slice(index, index + SQLITE_IN_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        rows.push(...db
            .prepare(`
          SELECT *
          FROM ${quoteIdentifier(input.partTable)}
          WHERE ${quoteIdentifier(input.partMessageColumn)} IN (${placeholders})
          ${input.partOrder}
        `)
            .all(...chunk));
    }
    return rows;
}
function resolveNativeSessionId(db, schema, session) {
    const candidates = [session.legacyFrameworkSessionId, session.sessionId].filter((value) => typeof value === 'string' && value.length > 0);
    const sessionTable = firstExistingTable(schema, ['session', 'sessions']);
    if (!sessionTable)
        return candidates[0];
    const columns = schema.tables.get(sessionTable) ?? new Set();
    const idColumn = firstColumn(columns, ['id', 'session_id', 'sessionID']);
    if (!idColumn)
        return candidates[0];
    const parentColumns = ['id', 'session_id', 'sessionID', 'parent_id', 'parentID'].filter((column) => columns.has(column));
    for (const candidate of candidates) {
        for (const column of parentColumns) {
            const row = db
                .prepare(`
          SELECT ${quoteIdentifier(idColumn)} AS id
          FROM ${quoteIdentifier(sessionTable)}
          WHERE ${quoteIdentifier(column)} = ?
          LIMIT 1
        `)
                .get(candidate);
            const id = typeof row?.id === 'string' ? row.id : undefined;
            if (id)
                return id;
        }
    }
    return candidates[0];
}
function nativeMessageFromRow(row, messageIdColumn) {
    const id = readStringField(row, [messageIdColumn, 'id', 'message_id', 'messageID']);
    if (!id)
        return undefined;
    // opencode wraps the message payload (including role/modelID/providerID) in
    // `data`; the outer row only has id / session_id / time_created. Merge so
    // we can read either shape uniformly.
    const parsed = parseNativeJson(readStringField(row, ['data']));
    const merged = mergeNativeRow(parsed, row);
    const roleValue = readStringField(merged, ['role']);
    const modelValue = readStringField(merged, ['model', 'modelID', 'model_id']);
    const providerValue = readStringField(merged, ['provider', 'providerID', 'provider_id']);
    const apiValue = readStringField(merged, ['api', 'apiID', 'api_id']);
    const timestamp = readNativeTimestamp(merged);
    return {
        id,
        ...(roleValue ? { role: roleValue } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
        ...(modelValue ? { model: modelValue } : {}),
        ...(providerValue ? { provider: providerValue } : {}),
        ...(apiValue ? { api: apiValue } : {}),
        raw: row,
    };
}
function mergeNativeRow(parsed, row) {
    return isLegacyMessageObject(parsed) ? { ...parsed, ...row } : row;
}
function nativePartFromRow(row) {
    const parsed = parseNativeJson(readStringField(row, ['data']));
    const merged = mergeNativeRow(parsed, row);
    const type = readStringField(merged, ['type']) ?? 'text';
    // Opencode wraps tool-call + tool-result together inside `data.state`. Lift
    // that block up so `convertNativeMessagesToPiHistory` can split it into a
    // pi-agent `toolCall` block plus a follow-up `toolResult` message without
    // re-inspecting field-name variants.
    const state = readNativeToolState(parsed);
    const toolCallId = readStringField(merged, [
        'toolCallID',
        'tool_call_id',
        'toolCallId',
        // opencode: `part.data.callID`
        'callID',
        'callId',
        'call_id',
    ]);
    const toolName = readStringField(merged, [
        'toolName',
        'tool_name',
        'name',
        // opencode: `part.data.tool`
        'tool',
    ]);
    const status = readNativePartStatus(merged, state);
    const timestamp = readNativeTimestamp(merged);
    return [
        {
            ...(readStringField(merged, ['id']) ? { id: readStringField(merged, ['id']) } : {}),
            type,
            ...(readStringField(merged, ['text', 'content'])
                ? { text: readStringField(merged, ['text', 'content']) }
                : {}),
            data: parsed ?? readStringField(row, ['data']),
            ...(toolCallId ? { toolCallId } : {}),
            ...(toolName ? { toolName } : {}),
            ...(status ? { status } : {}),
            ...(state ? { state } : {}),
            ...(timestamp !== undefined ? { timestamp } : {}),
            raw: row,
        },
    ];
}
function readNativePartStatus(row, state) {
    return (readStringField(row, ['status', 'state']) ??
        (typeof state?.status === 'string' ? state.status : undefined));
}
function inferNativePartsFromMessage(row) {
    const parsed = parseNativeJson(readStringField(row, ['data']));
    if (Array.isArray(parsed))
        return parsed.flatMap((item) => nativePartFromUnknown(item));
    if (parsed && typeof parsed === 'object') {
        const record = parsed;
        if (Array.isArray(record.parts))
            return record.parts.flatMap((item) => nativePartFromUnknown(item));
        if (Array.isArray(record.content))
            return record.content.flatMap((item) => nativePartFromUnknown(item));
        return nativePartFromUnknown(record);
    }
    const text = readStringField(row, ['text', 'data']);
    return text ? [{ type: 'text', text, raw: row }] : [];
}
function nativePartFromUnknown(value) {
    if (typeof value === 'string')
        return [{ type: 'text', text: value }];
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return [];
    return nativePartFromRow(value);
}
export function inspectLegacySchema(db) {
    const tables = new Map();
    for (const tableName of listUserTables(db)) {
        tables.set(tableName, getTableColumns(db, tableName));
    }
    return { tables };
}
export function canReadLegacySessions(schema) {
    return hasColumn(schema, 'sessions', 'session_id') && hasColumn(schema, 'sessions', 'agent_name');
}
export function canReadLegacyMessages(schema) {
    return (hasColumn(schema, 'session_messages', 'session_id') &&
        hasColumn(schema, 'session_messages', 'data'));
}
export function buildSessionQuery(schema, options) {
    const joins = [buildAgentJoin(schema), buildPeerJoin(schema)].filter(Boolean).join('\n');
    const sql = `
    SELECT
      ${buildSessionSelect(schema).join(',\n      ')}
    FROM sessions s
    ${joins}
    WHERE ${options.where}
    ${options.orderBy ?? ''}
    ${options.limit ?? ''}
  `;
    return {
        sql,
        params(sessionId) {
            return hasColumn(schema, 'sessions', 'framework_session_id')
                ? [sessionId, sessionId]
                : [sessionId];
        },
    };
}
export function buildSessionIdWhere(schema) {
    const idPredicates = [`${qualifiedColumn('s', 'session_id')} = ?`];
    if (hasColumn(schema, 'sessions', 'framework_session_id')) {
        idPredicates.push(`${qualifiedColumn('s', 'framework_session_id')} = ?`);
    }
    return `${buildRuntimeFilter(schema)} AND (${idPredicates.join(' OR ')})`;
}
export function buildSessionIdResolutionQuery(schema) {
    return {
        sql: `
      SELECT ${qualifiedColumn('s', 'session_id')} AS session_id
      FROM sessions s
      ${[buildAgentJoin(schema)].filter(Boolean).join('\n')}
      WHERE ${buildSessionIdWhere(schema)}
      LIMIT 1
    `,
        params(sessionId) {
            return hasColumn(schema, 'sessions', 'framework_session_id')
                ? [sessionId, sessionId]
                : [sessionId];
        },
    };
}
function buildSessionSelect(schema) {
    return [
        sessionColumn(schema, 'session_id'),
        sessionColumn(schema, 'framework_session_id'),
        sessionColumn(schema, 'agent_name'),
        sessionColumn(schema, 'session_type', 'session_type', '0'),
        sessionColumn(schema, 'title'),
        sessionColumn(schema, 'workspace_dir'),
        sessionColumn(schema, 'status'),
        sessionColumn(schema, 'session_data_dir'),
        sessionColumn(schema, 'compressed', 'compressed', '0'),
        sessionColumn(schema, 'framework_type'),
        peerColumn(schema, 'parent_session_id'),
        sessionColumn(schema, 'extra_data'),
        sessionColumn(schema, 'pinned', 'pinned', '0'),
        sessionColumn(schema, 'pinned_at'),
        sessionColumn(schema, 'created_at'),
        sessionColumn(schema, 'updated_at'),
    ];
}
function sessionColumn(schema, column, alias = column, fallback = 'NULL') {
    return hasColumn(schema, 'sessions', column)
        ? `${qualifiedColumn('s', column)} AS ${quoteIdentifier(alias)}`
        : `${fallback} AS ${quoteIdentifier(alias)}`;
}
function peerColumn(schema, column) {
    return canJoinSessionPeers(schema)
        ? `${qualifiedColumn('p', column)} AS ${quoteIdentifier(column)}`
        : `NULL AS ${quoteIdentifier(column)}`;
}
function buildAgentJoin(schema) {
    return canJoinAgents(schema)
        ? `LEFT JOIN agents a ON ${qualifiedColumn('a', 'agent_name')} = ${qualifiedColumn('s', 'agent_name')}`
        : '';
}
function buildPeerJoin(schema) {
    return canJoinSessionPeers(schema)
        ? `LEFT JOIN session_peers p ON ${qualifiedColumn('p', 'session_id')} = ${qualifiedColumn('s', 'session_id')}`
        : '';
}
function canJoinAgents(schema) {
    return hasColumn(schema, 'agents', 'agent_name');
}
function canJoinSessionPeers(schema) {
    return (hasColumn(schema, 'session_peers', 'session_id') &&
        hasColumn(schema, 'session_peers', 'parent_session_id'));
}
export function buildRuntimeFilter(schema) {
    const sessionFramework = hasColumn(schema, 'sessions', 'framework_type');
    const agentFramework = canJoinAgents(schema) && hasColumn(schema, 'agents', 'framework_type');
    if (sessionFramework && agentFramework) {
        return `(${qualifiedColumn('s', 'framework_type')} = 'opencode' OR (${qualifiedColumn('s', 'framework_type')} IS NULL AND (${legacyAgentFrameworkPredicate()})))`;
    }
    if (sessionFramework) {
        return `(${qualifiedColumn('s', 'framework_type')} = 'opencode' OR ${qualifiedColumn('s', 'framework_type')} IS NULL)`;
    }
    if (agentFramework) {
        return `(${legacyAgentFrameworkPredicate()})`;
    }
    return '1 = 1';
}
function legacyAgentFrameworkPredicate() {
    return `${qualifiedColumn('a', 'framework_type')} = 'opencode' OR ${qualifiedColumn('a', 'framework_type')} IS NULL OR ${qualifiedColumn('a', 'agent_name')} IS NULL`;
}
export function buildSessionOrderBy(schema) {
    const parts = [
        hasColumn(schema, 'sessions', 'session_type')
            ? `${qualifiedColumn('s', 'session_type')} DESC`
            : undefined,
        hasColumn(schema, 'sessions', 'pinned') ? `${qualifiedColumn('s', 'pinned')} DESC` : undefined,
        hasColumn(schema, 'sessions', 'pinned_at')
            ? `${qualifiedColumn('s', 'pinned_at')} DESC`
            : undefined,
        hasColumn(schema, 'sessions', 'updated_at')
            ? `${qualifiedColumn('s', 'updated_at')} DESC`
            : undefined,
        `${qualifiedColumn('s', 'session_id')} ASC`,
    ].filter((part) => Boolean(part));
    return `ORDER BY ${parts.join(', ')}`;
}
export function hasColumn(schema, tableName, columnName) {
    return schema.tables.get(tableName)?.has(columnName) ?? false;
}
function firstExistingTable(schema, tableNames) {
    return tableNames.find((tableName) => schema.tables.has(tableName));
}
function firstColumn(columns, columnNames) {
    return columnNames.find((columnName) => columns.has(columnName));
}
function buildNativeOrderBy(columns, candidates) {
    const column = firstColumn(columns, candidates);
    return column ? `ORDER BY ${quoteIdentifier(column)} ASC` : '';
}
function readStringField(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
        if (typeof value === 'number' && Number.isFinite(value))
            return String(value);
    }
    return undefined;
}
function readTimestampField(record) {
    for (const key of ['time', 'timestamp', 'created_at', 'updated_at']) {
        const value = record[key];
        const parsed = parseOptionalTimestampMs(value);
        if (parsed !== undefined)
            return parsed;
    }
    return undefined;
}
/**
 * Native opencode timestamps live under three shapes we need to cover:
 * - `time` as scalar ms (older versions);
 * - `time` as object `{ start, end }` (part rows) or `{ created, completed }`
 *   (message rows);
 * - `time_created` / `time_updated` outer columns on message/part rows.
 *
 * `readTimestampField` alone missed both nested and column shapes, which is
 * why migrated rows fell back to the current wall-clock and lost cross-turn
 * ordering. Kept next to it so both helpers evolve together.
 */
function readNativeTimestamp(record) {
    const flat = readTimestampField(record);
    if (flat !== undefined)
        return flat;
    const nested = record['time'];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const scope = nested;
        for (const key of ['created', 'start', 'completed', 'end', 'updated', 'time']) {
            const value = parseOptionalTimestampMs(scope[key]);
            if (value !== undefined)
                return value;
        }
    }
    for (const key of ['time_created', 'time_updated']) {
        const value = parseOptionalTimestampMs(record[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
/**
 * Extract the `state` block from an opencode-native `part.data` payload for
 * `type === 'tool'` parts. Callers get a normalized `{ status, input,
 * output?, error?, metadata? }` object so `convertNativeMessagesToPiHistory`
 * can split a single opencode tool part into pi-agent's separate
 * `toolCall` block + `toolResult` message without re-parsing raw JSON.
 * Returns undefined for non-object / non-state payloads so falsy branches
 * stay simple.
 */
function readNativeToolState(data) {
    if (!isLegacyMessageObject(data))
        return undefined;
    const scope = data.state;
    if (!isLegacyMessageObject(scope))
        return undefined;
    const status = typeof scope['status'] === 'string' ? scope['status'] : undefined;
    const errorValue = typeof scope['error'] === 'string' ? scope['error'] : undefined;
    return {
        ...(status ? { status } : {}),
        ...(scope['input'] !== undefined ? { input: scope['input'] } : {}),
        ...(scope['output'] !== undefined ? { output: scope['output'] } : {}),
        ...(errorValue ? { error: errorValue } : {}),
        ...(scope['metadata'] !== undefined ? { metadata: scope['metadata'] } : {}),
    };
}
function parseNativeJson(value) {
    if (!value)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
export function qualifiedColumn(tableAlias, columnName) {
    return `${quoteIdentifier(tableAlias)}.${quoteIdentifier(columnName)}`;
}
export function loadBetterSqlite3() {
    try {
        return loadBetterSqlite3Module();
    }
    catch {
        return undefined;
    }
}
export function toSessionType(value) {
    return value === 1 ? 'root' : 'branch';
}
export function toLocalStatus(value) {
    const normalized = value?.trim().toLowerCase();
    if (normalized === 'finished' ||
        normalized === 'error' ||
        normalized === 'aborted' ||
        normalized === 'interrupted') {
        return normalized;
    }
    if (!normalized)
        return 'finished';
    return legacyStatusAlias(normalized);
}
function legacyStatusAlias(value) {
    if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(value))
        return 'finished';
    if (['failed', 'failure'].includes(value))
        return 'error';
    if (['cancelled', 'canceled'].includes(value))
        return 'aborted';
    return 'interrupted';
}
export function parseTimestampMs(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'string')
        return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric))
        return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
export function toLegacyAgent(row) {
    const name = readString(row.agent_name);
    if (!name)
        return undefined;
    const frameworkType = readString(row.framework_type);
    if (frameworkType && frameworkType !== 'opencode')
        return undefined;
    return { name, displayName: readString(row.display_name) ?? name, ...legacyAgentDetails(row) };
}
function legacyAgentDetails(row) {
    const createdAt = parseOptionalTimestampMs(row.created_at);
    const updatedAt = parseOptionalTimestampMs(row.updated_at);
    return {
        ...(readString(row.description) ? { description: readString(row.description) } : {}),
        ...(readString(row.avatar) ? { avatar: readString(row.avatar) } : {}),
        ...(readString(row.persona) ? { persona: readString(row.persona) } : {}),
        ...(readString(row.system_prompt) ? { systemPrompt: readString(row.system_prompt) } : {}),
        ...(readString(row.default_workspace_dir)
            ? { defaultWorkspaceDir: readString(row.default_workspace_dir) }
            : {}),
        ...(readString(row.root_session_id) ? { rootSessionId: readString(row.root_session_id) } : {}),
        ...(createdAt !== undefined ? { createdAtMs: createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAtMs: updatedAt } : {}),
    };
}
function parseOptionalTimestampMs(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value !== 'string')
        return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric))
        return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function readString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
export function getTableColumns(db, tableName) {
    try {
        return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()
            .map((row) => row.name)
            .filter((name) => typeof name === 'string'));
    }
    catch {
        return new Set();
    }
}
function listUserTables(db) {
    try {
        return db
            .prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name ASC
        `)
            .all()
            .map((row) => row.name)
            .filter((name) => typeof name === 'string');
    }
    catch {
        return [];
    }
}
export function selectFirstColumn(columns, candidates, alias) {
    const column = candidates.find((candidate) => columns.has(candidate));
    return column ? `${quoteIdentifier(column)} AS ${quoteIdentifier(alias)}` : undefined;
}
export function quoteIdentifier(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function tableExists(db, tableName) {
    try {
        return Boolean(db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
            .get(tableName));
    }
    catch {
        return false;
    }
}
export function countKnownLegacyTables(db) {
    const counts = {};
    for (const tableName of [
        'agents',
        'sessions',
        'session_peers',
        'session_messages',
        'permission_requests',
        'questionnaire_requests',
        'session_turn_file_changes',
        'session_turn_file_change_journal',
        'token_usage',
        'delegation_message',
        'logic_version',
    ]) {
        if (!tableExists(db, tableName))
            continue;
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get();
        counts[tableName] = typeof row?.count === 'number' ? row.count : 0;
    }
    return counts;
}
export function inspectLegacyDaemonSchemaManifest(db) {
    const schema = inspectLegacySchema(db);
    const tables = tableColumnsRecord(schema);
    const indexes = tableIndexesRecord(db, Object.keys(tables));
    const logicVersion = readLogicVersion(db);
    const warnings = legacyDaemonSchemaWarnings(schema);
    return {
        fingerprint: fingerprintJson({ tables, indexes, logicVersion }),
        ...(logicVersion !== undefined ? { logicVersion } : {}),
        tables,
        indexes,
        detectedShape: detectLegacyDaemonShape(schema),
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}
function tableColumnsRecord(schema) {
    return Object.fromEntries([...schema.tables.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tableName, columns]) => [tableName, [...columns].sort()]));
}
function tableIndexesRecord(db, tableNames) {
    const indexes = {};
    for (const tableName of tableNames) {
        try {
            const rows = db
                .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
                .all();
            const names = rows
                .map((row) => row.name)
                .filter((name) => typeof name === 'string')
                .sort();
            if (names.length > 0)
                indexes[tableName] = names;
        }
        catch {
            // best-effort schema report only
        }
    }
    return indexes;
}
function readLogicVersion(db) {
    if (!tableExists(db, 'logic_version'))
        return undefined;
    try {
        const row = db.prepare('SELECT version FROM logic_version WHERE id = 1').get();
        return typeof row?.version === 'number' ? row.version : undefined;
    }
    catch {
        return undefined;
    }
}
function detectLegacyDaemonShape(schema) {
    if (canReadLegacySessions(schema) && canReadLegacyMessages(schema))
        return 'legacy-daemon';
    if (schema.tables.has('sessions') || schema.tables.has('session_messages')) {
        return 'partial-legacy-daemon';
    }
    return 'unknown';
}
function legacyDaemonSchemaWarnings(schema) {
    const warnings = [];
    if (!schema.tables.has('sessions'))
        warnings.push('legacy_schema_missing:sessions');
    if (!schema.tables.has('session_messages'))
        warnings.push('legacy_schema_missing:session_messages');
    if (!hasColumn(schema, 'sessions', 'framework_session_id')) {
        warnings.push('legacy_schema_missing:sessions.framework_session_id');
    }
    if (!schema.tables.has('agents'))
        warnings.push('legacy_schema_missing:agents');
    if (!schema.tables.has('session_peers'))
        warnings.push('legacy_schema_missing:session_peers');
    return warnings;
}
export function inspectOpenCodeNativeSources(input) {
    const candidates = [
        inspectOpenCodeNativeCandidate('sandbox-data', input.sandboxDataPath),
        inspectOpenCodeNativeCandidate('sandbox-state', input.sandboxStatePath),
        inspectOpenCodeNativeCandidate('xdg-data', input.xdgDataPath),
        inspectOpenCodeNativeCandidate('xdg-state', input.xdgStatePath),
    ];
    return { candidates };
}
function inspectOpenCodeNativeCandidate(kind, candidatePath) {
    const dbPath = path.join(candidatePath, 'opencode.db');
    const base = {
        kind,
        path: candidatePath,
        exists: fs.existsSync(candidatePath),
        dbPath,
        dbExists: fs.existsSync(dbPath),
        ...fileSizeField('dbSizeBytes', dbPath),
    };
    if (!base.dbExists)
        return base;
    const details = inspectSqliteSchemaFile(dbPath);
    return { ...base, ...details };
}
function inspectSqliteSchemaFile(dbPath) {
    const Database = loadBetterSqlite3();
    if (!Database)
        return { error: 'better_sqlite3_unavailable' };
    let db;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
    }
    catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
    try {
        const schema = inspectLegacySchema(db);
        const tables = tableColumnsRecord(schema);
        return {
            tables,
            schemaFingerprint: fingerprintJson({ tables }),
        };
    }
    catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
    finally {
        db.close();
    }
}
export function resolveXdgPath(envName, defaultParts, childParts) {
    const configured = process.env[envName];
    const base = typeof configured === 'string' && configured.trim()
        ? configured
        : path.join(os.homedir(), ...defaultParts);
    return path.join(base, ...childParts);
}
function fingerprintJson(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function fileSizeField(key, filePath) {
    try {
        if (!fs.existsSync(filePath))
            return {};
        return { [key]: fs.statSync(filePath).size };
    }
    catch {
        return {};
    }
}
function parseExtraData(raw) {
    if (!raw)
        return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
export function readVisibility(raw) {
    const value = parseExtraData(raw).visibility;
    return value === 'hidden' ? 'hidden' : 'visible';
}
export function readPurpose(raw) {
    const value = parseExtraData(raw).purpose;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function normalizeMessageListOptions(limitOrOptions) {
    return typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : (limitOrOptions ?? {});
}
export function normalizeMessageLimit(limit) {
    return limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}
export function normalizeMessagePageBytes(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MESSAGE_PAGE_BYTES;
}
export function readMessageRow(row) {
    const message = parseMessageRow(row);
    return message ? [message] : [];
}
export function readStreamedMessageRow(row) {
    return {
        message: parseMessageRow(row),
        rawBytes: Buffer.byteLength(row.data, 'utf8'),
    };
}
function parseMessageRow(row) {
    try {
        // Legacy records may lack fields such as msg_id; the scan reports them separately.
        const parsed = JSON.parse(row.data);
        return isLegacyMessageObject(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function isLegacyMessageObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function emptyMessageScan() {
    const emptyChecksum = fingerprintJson([]);
    return {
        sourceCount: 0,
        parseErrorCount: 0,
        missingMsgIdCount: 0,
        duplicateMsgIdCount: 0,
        duplicateSourceMsgIds: [],
        rawChecksum: emptyChecksum,
        parsedChecksum: emptyChecksum,
    };
}
export function scanMessageRows(rows) {
    const rawHash = crypto.createHash('sha256');
    const parsedHash = crypto.createHash('sha256');
    parsedHash.update('[');
    let sourceCount = 0;
    let parsedCount = 0;
    let parseErrorCount = 0;
    let missingMsgIdCount = 0;
    let duplicateMsgIdCount = 0;
    const seen = new Set();
    const duplicateSourceMsgIds = new Set();
    for (const row of rows) {
        sourceCount += 1;
        rawHash.update(String(row.id));
        rawHash.update('\0');
        rawHash.update(row.data);
        rawHash.update('\n');
        const message = parseMessageRow(row);
        if (!message) {
            parseErrorCount += 1;
            continue;
        }
        if (parsedCount > 0)
            parsedHash.update(',');
        parsedHash.update(JSON.stringify(message));
        parsedCount += 1;
        const msgId = typeof message.msg_id === 'string' ? message.msg_id : '';
        if (!msgId) {
            missingMsgIdCount += 1;
        }
        else if (seen.has(msgId)) {
            duplicateMsgIdCount += 1;
            if (msgId.trim())
                duplicateSourceMsgIds.add(msgId);
        }
        else {
            seen.add(msgId);
        }
    }
    parsedHash.update(']');
    return {
        sourceCount,
        parseErrorCount,
        missingMsgIdCount,
        duplicateMsgIdCount,
        duplicateSourceMsgIds: [...duplicateSourceMsgIds],
        rawChecksum: rawHash.digest('hex'),
        parsedChecksum: parsedHash.digest('hex'),
    };
}
//# sourceMappingURL=legacy-opencode-store-readers.js.map