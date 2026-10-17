import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildLegacyMessagePage, decodeLegacyAgentRow, decodeLegacyDisplayMessage, decodeLegacySessionRow, emptyLegacyMessageScan, LegacyOpencodeSourceCorruptionError, resolveLegacyNativeCandidateInputs, scanLegacyMessageValues, } from './model.js';
const DEFAULT_MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;
export function createLegacyOpencodeReadonlySource(options) {
    return new SqliteLegacyOpencodeReadonlySource(options);
}
class SqliteLegacyOpencodeReadonlySource {
    options;
    daemonPath;
    constructor(options) {
        this.options = options;
        this.daemonPath = join(options.sourceDataDir, 'sqlite.db');
    }
    async getSession(sessionId) {
        return this.withDaemon((db) => {
            const schema = inspectSchema(db);
            if (!canReadSessions(schema))
                return undefined;
            const rows = querySessions(db, schema);
            return rows
                .map((row) => this.decodeSession(row))
                .find((session) => session.sessionId === sessionId || session.legacyFrameworkSessionId === sessionId);
        });
    }
    async listSessions(agentName) {
        return (this.withDaemon((db) => {
            const schema = inspectSchema(db);
            if (!canReadSessions(schema))
                return [];
            return querySessions(db, schema, agentName)
                .map((row) => this.decodeSession(row))
                .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
        }) ?? []);
    }
    async listMessages(sessionId, options) {
        return (await this.listMessagePage(sessionId, options)).messages;
    }
    async *streamMessagePages(sessionId, pageSize, maxPageBytes = DEFAULT_MESSAGE_PAGE_BYTES) {
        if (!existsSync(this.daemonPath))
            return;
        const Database = this.constructorFor();
        const db = new Database(this.daemonPath, { readonly: true, fileMustExist: true });
        let rows;
        try {
            const schema = inspectSchema(db);
            if (!canReadMessages(schema))
                return;
            const storedId = resolveStoredSessionId(db, schema, sessionId);
            if (!storedId)
                return;
            rows = messageRows(db, storedId);
            const countLimit = normalizeMessagePageSize(pageSize);
            const byteLimit = normalizeMessagePageBytes(maxPageBytes);
            for (const page of boundedMessagePages(rows, countLimit, byteLimit))
                yield page;
        }
        finally {
            rows?.return?.();
            db.close();
        }
    }
    async listMessagePage(sessionId, options) {
        return (this.withDaemon((db) => {
            const schema = inspectSchema(db);
            if (!canReadMessages(schema))
                return { messages: [] };
            const storedId = resolveStoredSessionId(db, schema, sessionId);
            if (!storedId)
                return { messages: [] };
            const parsed = readMessageRows(db, storedId).map((row) => decodeLegacyDisplayMessage(requireString(row, 'data')));
            return buildLegacyMessagePage(parsed, options);
        }) ?? { messages: [] });
    }
    async countMessages(sessionId) {
        return (this.withDaemon((db) => {
            const schema = inspectSchema(db);
            if (!canReadMessages(schema))
                return 0;
            const storedId = resolveStoredSessionId(db, schema, sessionId);
            if (!storedId)
                return 0;
            const row = db
                .prepare('SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?')
                .get(storedId);
            return readNumber(row, 'count');
        }) ?? 0);
    }
    async scanMessages(sessionId) {
        return (this.withDaemon((db) => {
            const schema = inspectSchema(db);
            if (!canReadMessages(schema))
                return emptyLegacyMessageScan();
            const storedId = resolveStoredSessionId(db, schema, sessionId);
            if (!storedId)
                return emptyLegacyMessageScan();
            return scan(messageRows(db, storedId));
        }) ?? emptyLegacyMessageScan());
    }
    async listNativeMessages(session) {
        for (const candidateInput of resolveLegacyNativeCandidateInputs(this.options)) {
            if (!existsSync(candidateInput.dbPath))
                continue;
            const candidate = inspectNativeCandidate(candidateInput, this.constructorFor());
            const result = this.withDatabase(candidate.dbPath, (db) => readNative(db, candidate, session.legacyFrameworkSessionId ?? session.sessionId));
            if (result?.messages.length)
                return result;
        }
        return undefined;
    }
    async getAgent(agentName) {
        return this.withDaemon((db) => {
            const schema = inspectSchema(db);
            const columns = schema.tables.get('agents');
            if (!columns?.has('agent_name'))
                return undefined;
            const row = db.prepare('SELECT * FROM agents WHERE agent_name = ? LIMIT 1').get(agentName);
            const frameworkType = optionalString(row, 'framework_type');
            if (!row || (frameworkType && frameworkType !== 'opencode'))
                return undefined;
            return decodeLegacyAgentRow(row);
        });
    }
    async getSourceManifest() {
        const walPath = `${this.daemonPath}-wal`;
        const shmPath = `${this.daemonPath}-shm`;
        const candidates = resolveLegacyNativeCandidateInputs(this.options).map((candidate) => inspectNativeCandidate(candidate, this.constructorFor()));
        const sourceOpenCodeDataPath = join(this.options.sourceDataDir, 'opencode', 'data', 'opencode');
        const sourceOpenCodeStatePath = join(this.options.sourceDataDir, 'opencode', 'state', 'opencode');
        const sourceOpenCodeXdgDataPath = candidatePath(candidates, 'xdg-data');
        const sourceOpenCodeXdgStatePath = candidatePath(candidates, 'xdg-state');
        const base = {
            sourceDataDir: this.options.sourceDataDir,
            sourceSqlitePath: this.daemonPath,
            sourceSqliteExists: existsSync(this.daemonPath),
            ...size('sourceSqliteSizeBytes', this.daemonPath),
            sourceSqliteWalPath: walPath,
            sourceSqliteWalExists: existsSync(walPath),
            ...size('sourceSqliteWalSizeBytes', walPath),
            sourceSqliteShmPath: shmPath,
            sourceSqliteShmExists: existsSync(shmPath),
            ...size('sourceSqliteShmSizeBytes', shmPath),
            sourceOpenCodeDataPath,
            sourceOpenCodeDataExists: existsSync(sourceOpenCodeDataPath),
            sourceOpenCodeStatePath,
            sourceOpenCodeStateExists: existsSync(sourceOpenCodeStatePath),
            sourceOpenCodeXdgDataPath,
            sourceOpenCodeXdgDataExists: Boolean(sourceOpenCodeXdgDataPath && existsSync(sourceOpenCodeXdgDataPath)),
            sourceOpenCodeXdgStatePath,
            sourceOpenCodeXdgStateExists: Boolean(sourceOpenCodeXdgStatePath && existsSync(sourceOpenCodeXdgStatePath)),
            opencodeNative: { candidates },
        };
        if (!existsSync(this.daemonPath))
            return base;
        try {
            const details = this.withDatabase(this.daemonPath, (db) => {
                const schema = inspectSchema(db);
                return {
                    legacyDaemonSchema: daemonManifest(db, schema),
                    tableCounts: tableCounts(db, schema),
                };
            });
            return { ...base, ...details };
        }
        catch {
            return { ...base, errors: ['legacy_sqlite_unreadable_or_unavailable'] };
        }
    }
    withDaemon(operation) {
        if (!existsSync(this.daemonPath))
            return undefined;
        return this.withDatabase(this.daemonPath, operation);
    }
    decodeSession(row) {
        const session = decodeLegacySessionRow(row);
        if (session.workspaceDir)
            return session;
        const sessionDataDir = optionalString(row, 'session_data_dir');
        return {
            ...session,
            isDefaultWorkspace: true,
            workspaceDir: sessionDataDir
                ? join(sessionDataDir, 'workspace')
                : join(this.options.sourceDataDir, 'sessions', session.sessionId, 'workspace'),
        };
    }
    withDatabase(path, operation) {
        const Database = this.constructorFor();
        const db = new Database(path, { readonly: true, fileMustExist: true });
        try {
            return operation(db);
        }
        finally {
            db.close();
        }
    }
    constructorFor() {
        const overridePath = process.env.MAVIS_SQLITE3_MODULE_PATH?.trim();
        const require = overridePath
            ? createRequire(join(overridePath, 'package.json'))
            : createRequire(import.meta.url);
        const loaded = require('better-sqlite3');
        return (loaded.default ?? loaded);
    }
}
function inspectSchema(db) {
    const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .flatMap((row) => {
        const name = optionalString(row, 'name');
        return name ? [name] : [];
    });
    return {
        tables: new Map(names.map((name) => [
            name,
            new Set(db
                .prepare(`PRAGMA table_info("${safeIdentifier(name)}")`)
                .all()
                .flatMap((row) => {
                const column = optionalString(row, 'name');
                return column ? [column] : [];
            })),
        ])),
    };
}
function canReadSessions(schema) {
    const columns = schema.tables.get('sessions');
    return Boolean(columns?.has('session_id') &&
        columns.has('agent_name') &&
        columns.has('session_type') &&
        columns.has('created_at') &&
        columns.has('updated_at'));
}
function canReadMessages(schema) {
    const columns = schema.tables.get('session_messages');
    return Boolean(columns?.has('session_id') && columns.has('data'));
}
function querySessions(db, schema, agentName) {
    if (!canReadSessions(schema))
        return [];
    const statement = db.prepare(`SELECT s.*
     FROM sessions s
     ${legacyAgentJoin(schema)}
     WHERE ${legacySessionRuntimeFilter(schema)}${agentName ? ' AND s.agent_name = ?' : ''}`);
    return agentName ? statement.all(agentName) : statement.all();
}
function resolveStoredSessionId(db, schema, sessionId) {
    if (!canReadSessions(schema))
        return sessionId;
    const hasFrameworkId = schema.tables.get('sessions')?.has('framework_session_id') ?? false;
    const framework = hasFrameworkId ? 's.framework_session_id' : 'NULL AS framework_session_id';
    const where = hasFrameworkId
        ? 's.session_id = ? OR s.framework_session_id = ?'
        : 's.session_id = ? OR s.session_id = ?';
    const row = db
        .prepare(`SELECT s.session_id, ${framework}
       FROM sessions s
       ${legacyAgentJoin(schema)}
       WHERE ${legacySessionRuntimeFilter(schema)} AND (${where})
       LIMIT 1`)
        .get(sessionId, sessionId);
    const storedSessionId = optionalString(row, 'session_id');
    const frameworkSessionId = optionalString(row, 'framework_session_id');
    if (!storedSessionId || !frameworkSessionId || storedSessionId === frameworkSessionId) {
        return storedSessionId;
    }
    if (hasMessageRows(db, storedSessionId))
        return storedSessionId;
    return hasMessageRows(db, frameworkSessionId) ? frameworkSessionId : storedSessionId;
}
function hasMessageRows(db, sessionId) {
    return Boolean(db
        .prepare('SELECT 1 AS found FROM session_messages WHERE session_id = ? LIMIT 1')
        .get(sessionId));
}
function legacyAgentJoin(schema) {
    return hasAgentFramework(schema) ? 'LEFT JOIN agents a ON a.agent_name = s.agent_name' : '';
}
function legacySessionRuntimeFilter(schema) {
    const sessionFramework = schema.tables.get('sessions')?.has('framework_type') ?? false;
    const agentFramework = hasAgentFramework(schema);
    if (sessionFramework && agentFramework) {
        return `(s.framework_type = 'opencode' OR
      (s.framework_type IS NULL AND (${legacyAgentRuntimePredicate()})))`;
    }
    if (sessionFramework) {
        return "(s.framework_type = 'opencode' OR s.framework_type IS NULL)";
    }
    return agentFramework ? `(${legacyAgentRuntimePredicate()})` : '1 = 1';
}
function hasAgentFramework(schema) {
    const columns = schema.tables.get('agents');
    return Boolean(columns?.has('agent_name') && columns.has('framework_type'));
}
function legacyAgentRuntimePredicate() {
    return "a.framework_type = 'opencode' OR a.framework_type IS NULL OR a.agent_name IS NULL";
}
function readMessageRows(db, sessionId) {
    return db
        .prepare('SELECT rowid AS source_rowid, data FROM session_messages WHERE session_id = ? ORDER BY rowid')
        .all(sessionId);
}
function messageRows(db, sessionId) {
    return db
        .prepare('SELECT rowid AS source_rowid, data FROM session_messages WHERE session_id = ? ORDER BY rowid')
        .iterate(sessionId);
}
function* boundedMessagePages(rows, countLimit, byteLimit) {
    let page = [];
    let pageBytes = 0;
    for (const row of rows) {
        const raw = requireString(row, 'data');
        const message = decodeLegacyDisplayMessage(raw);
        const rawBytes = Buffer.byteLength(raw, 'utf8');
        if (page.length > 0 && pageBytes + rawBytes > byteLimit) {
            yield page;
            page = [];
            pageBytes = 0;
        }
        page.push(message);
        pageBytes += rawBytes;
        if (page.length >= countLimit || pageBytes >= byteLimit) {
            yield page;
            page = [];
            pageBytes = 0;
        }
    }
    if (page.length > 0)
        yield page;
}
function scan(rows) {
    return scanLegacyMessageValues(messageData(rows));
}
function* messageData(rows) {
    for (const row of rows)
        yield optionalString(row, 'data') ?? '';
}
function normalizeMessagePageSize(value) {
    return Number.isFinite(value) && value > 0 ? Math.min(1000, Math.floor(value)) : 500;
}
function normalizeMessagePageBytes(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MESSAGE_PAGE_BYTES;
}
function inspectNativeCandidate(input, Database) {
    const base = {
        kind: input.kind,
        path: dirname(input.dbPath),
        exists: existsSync(dirname(input.dbPath)),
        dbPath: input.dbPath,
        dbExists: existsSync(input.dbPath),
        ...size('dbSizeBytes', input.dbPath),
    };
    if (!base.dbExists)
        return base;
    try {
        const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
        try {
            const schema = inspectSchema(db);
            const tables = Object.fromEntries([...schema.tables].map(([name, columns]) => [name, [...columns].sort()]));
            return { ...base, tables, schemaFingerprint: digest(JSON.stringify(tables)) };
        }
        finally {
            db.close();
        }
    }
    catch {
        return { ...base, error: 'native_sqlite_unreadable' };
    }
}
function candidatePath(candidates, kind) {
    return candidates.find((candidate) => candidate.kind === kind)?.path ?? '';
}
function readNative(db, candidate, sessionId) {
    const schema = inspectSchema(db);
    const shape = resolveNativeMessageShape(schema);
    if (!shape)
        return undefined;
    const nativeSessionId = resolveNativeSessionId(db, schema, sessionId);
    const rows = db
        .prepare(`SELECT * FROM "${safeIdentifier(shape.messageTable)}"
       WHERE "${safeIdentifier(shape.sessionColumn)}" = ? ${shape.messageOrder}`)
        .all(nativeSessionId);
    if (rows.length === 0)
        return undefined;
    const messages = rows.map((row) => decodeNativeMessage(db, row, shape));
    return messages.length
        ? { source: candidate, nativeSessionId, messages, warnings: shape.warnings }
        : undefined;
}
function decodeNativeMessage(db, row, shape) {
    if (!isRecord(row))
        throw new LegacyOpencodeSourceCorruptionError('native-message');
    const id = readStringField(row, [shape.idColumn, 'id', 'message_id', 'messageID']);
    if (!id)
        throw new LegacyOpencodeSourceCorruptionError('native-message-id');
    const parsed = parseNativeJson(optionalString(row, 'data'), 'native-message');
    const merged = isRecord(parsed) ? { ...parsed, ...row } : row;
    const partRows = readNativePartRows(db, id, shape);
    const decodedParts = partRows.flatMap(decodeNativePart);
    const parts = decodedParts.length > 0 ? decodedParts : inferNativeParts(row, parsed);
    const role = readStringField(merged, ['role']);
    const model = readStringField(merged, ['model', 'modelID', 'model_id']);
    const provider = readStringField(merged, ['provider', 'providerID', 'provider_id']);
    const api = readStringField(merged, ['api', 'apiID', 'api_id']);
    const timestamp = readNativeTimestamp(merged);
    return {
        id,
        ...optionalProperty('role', role),
        ...optionalProperty('timestamp', timestamp),
        ...optionalProperty('model', model),
        ...optionalProperty('provider', provider),
        ...optionalProperty('api', api),
        parts,
        raw: row,
    };
}
function decodeNativePart(row) {
    if (!isRecord(row))
        return [];
    const parsed = parseNativeJson(optionalString(row, 'data'), 'native-part');
    const merged = isRecord(parsed) ? { ...parsed, ...row } : row;
    const id = readStringField(merged, ['id']);
    const type = readStringField(merged, ['type']) ?? 'text';
    const text = readStringField(merged, ['text', 'content']);
    const toolCallId = readStringField(merged, [
        'toolCallID',
        'tool_call_id',
        'toolCallId',
        'callID',
        'callId',
        'call_id',
    ]);
    const toolName = readStringField(merged, ['toolName', 'tool_name', 'name', 'tool']);
    const state = readNativeState(parsed);
    const status = readStringField(merged, ['status', 'state']) ??
        (typeof state?.status === 'string' ? state.status : undefined);
    const timestamp = readNativeTimestamp(merged);
    return [
        {
            ...optionalProperty('id', id),
            type,
            ...optionalProperty('text', text),
            ...optionalProperty('data', parsed),
            ...optionalProperty('toolCallId', toolCallId),
            ...optionalProperty('toolName', toolName),
            ...optionalProperty('status', status),
            ...optionalProperty('timestamp', timestamp),
            ...optionalProperty('state', state),
            raw: row,
        },
    ];
}
function resolveNativeMessageShape(schema) {
    const messageTable = firstTable(schema, ['message', 'session_message', 'messages']);
    if (!messageTable)
        return undefined;
    const messageColumns = schema.tables.get(messageTable) ?? new Set();
    const sessionColumn = firstColumn(messageColumns, ['session_id', 'sessionID']);
    const idColumn = firstColumn(messageColumns, ['id', 'message_id', 'messageID']);
    if (!sessionColumn || !idColumn)
        return undefined;
    const partTable = firstTable(schema, ['part', 'message_part', 'message_parts']);
    const partShape = partTable ? nativePartShape(schema, partTable) : undefined;
    return {
        idColumn,
        messageTable,
        sessionColumn,
        messageOrder: orderBy(messageColumns, [
            'time_created',
            'time',
            'timestamp',
            'created_at',
            'seq',
            idColumn,
        ]),
        warnings: nativeShapeWarnings(partTable, partShape),
        ...optionalProperty('partTable', partTable),
        ...optionalProperty('partShape', partShape),
    };
}
function nativeShapeWarnings(partTable, partShape) {
    if (!partTable)
        return ['legacy_native_schema_missing:part'];
    return partShape ? [] : [`legacy_native_schema_missing:${partTable}.message_id`];
}
function readNativePartRows(db, messageId, shape) {
    if (!shape.partTable || !shape.partShape)
        return [];
    return db
        .prepare(`SELECT * FROM "${safeIdentifier(shape.partTable)}"
       WHERE "${safeIdentifier(shape.partShape.messageColumn)}" = ? ${shape.partShape.order}`)
        .all(messageId);
}
function nativePartShape(schema, table) {
    const columns = schema.tables.get(table) ?? new Set();
    const messageColumn = firstColumn(columns, ['message_id', 'messageID', 'message']);
    return messageColumn
        ? {
            messageColumn,
            order: orderBy(columns, ['seq', 'time_created', 'time', 'timestamp', 'created_at', 'id']),
        }
        : undefined;
}
function resolveNativeSessionId(db, schema, sessionId) {
    const sessionTable = firstTable(schema, ['session', 'sessions']);
    if (!sessionTable)
        return sessionId;
    const columns = schema.tables.get(sessionTable) ?? new Set();
    const idColumn = firstColumn(columns, ['id', 'session_id', 'sessionID']);
    if (!idColumn)
        return sessionId;
    const lookupColumns = ['id', 'session_id', 'sessionID', 'parent_id', 'parentID'].filter((column) => columns.has(column));
    for (const lookupColumn of lookupColumns) {
        const row = db
            .prepare(`SELECT "${safeIdentifier(idColumn)}" AS id
         FROM "${safeIdentifier(sessionTable)}"
         WHERE "${safeIdentifier(lookupColumn)}" = ? LIMIT 1`)
            .get(sessionId);
        const resolved = optionalString(row, 'id');
        if (resolved)
            return resolved;
    }
    return sessionId;
}
function inferNativeParts(row, parsed) {
    if (Array.isArray(parsed))
        return parsed.flatMap(nativePartFromUnknown);
    if (isRecord(parsed)) {
        if (Array.isArray(parsed.parts))
            return parsed.parts.flatMap(nativePartFromUnknown);
        if (Array.isArray(parsed.content))
            return parsed.content.flatMap(nativePartFromUnknown);
        if (readStringField(parsed, ['text', 'content']))
            return decodeNativePart(parsed);
    }
    const text = readStringField(row, ['text']);
    return text ? [{ type: 'text', text, raw: row }] : [];
}
function nativePartFromUnknown(value) {
    if (typeof value === 'string')
        return [{ type: 'text', text: value }];
    return isRecord(value) ? decodeNativePart(value) : [];
}
function firstTable(schema, candidates) {
    return candidates.find((candidate) => schema.tables.has(candidate));
}
function firstColumn(columns, candidates) {
    return candidates.find((candidate) => columns.has(candidate));
}
function orderBy(columns, candidates) {
    const column = firstColumn(columns, candidates);
    return column ? `ORDER BY "${safeIdentifier(column)}" ASC` : '';
}
function readStringField(value, keys) {
    for (const key of keys) {
        const candidate = value[key];
        if (typeof candidate === 'string' && candidate.length > 0)
            return candidate;
        if (typeof candidate === 'number' && Number.isFinite(candidate))
            return String(candidate);
    }
    return undefined;
}
function readNativeTimestamp(value) {
    for (const key of ['time', 'timestamp', 'created_at', 'updated_at']) {
        const timestamp = nativeTimestampValue(value[key]);
        if (timestamp !== undefined)
            return timestamp;
    }
    const nested = value.time;
    if (isRecord(nested)) {
        for (const key of ['created', 'start', 'completed', 'end', 'updated', 'time']) {
            const timestamp = nativeTimestampValue(nested[key]);
            if (timestamp !== undefined)
                return timestamp;
        }
    }
    for (const key of ['time_created', 'time_updated']) {
        const timestamp = nativeTimestampValue(value[key]);
        if (timestamp !== undefined)
            return timestamp;
    }
    return undefined;
}
function nativeTimestampValue(value) {
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
function readNativeState(value) {
    return isRecord(value) && isRecord(value.state) ? value.state : undefined;
}
function parseNativeJson(value, source) {
    if (!value)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        throw new LegacyOpencodeSourceCorruptionError(source);
    }
}
function optionalProperty(key, value) {
    return value === undefined ? {} : { [key]: value };
}
function daemonManifest(db, schema) {
    const tables = Object.fromEntries([...schema.tables].map(([name, columns]) => [name, [...columns].sort()]));
    const indexRows = db
        .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .all();
    const indexes = {};
    indexRows.forEach((row) => {
        const name = requireString(row, 'name');
        indexes[name] = db
            .prepare(`PRAGMA index_info("${safeIdentifier(name)}")`)
            .all()
            .flatMap((entry) => {
            const column = optionalString(entry, 'name');
            return column ? [column] : [];
        });
    });
    return {
        fingerprint: digest(JSON.stringify({ tables, indexes })),
        tables,
        indexes,
        detectedShape: detectedShape(schema),
    };
}
function detectedShape(schema) {
    if (canReadSessions(schema) && canReadMessages(schema))
        return 'legacy-daemon';
    return schema.tables.size > 0 ? 'partial-legacy-daemon' : 'unknown';
}
function tableCounts(db, schema) {
    const known = ['sessions', 'session_messages', 'agents'];
    return Object.fromEntries(known
        .filter((name) => schema.tables.has(name))
        .map((name) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get();
        return [name, readNumber(row, 'count')];
    }));
}
function safeIdentifier(value) {
    if (!/^[a-z0-9_]+$/iu.test(value))
        throw new Error('Invalid SQLite identifier');
    return value;
}
function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}
function size(key, path) {
    return existsSync(path) ? { [key]: statSync(path).size } : {};
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasKey(value, key) {
    return isRecord(value) && Object.hasOwn(value, key);
}
function optionalString(value, key) {
    return hasKey(value, key) && typeof value[key] === 'string' ? value[key] : undefined;
}
function requireString(value, key) {
    const found = optionalString(value, key);
    if (found === undefined)
        throw new LegacyOpencodeSourceCorruptionError(key);
    return found;
}
function optionalNumber(value, key) {
    return hasKey(value, key) && typeof value[key] === 'number' ? value[key] : undefined;
}
function readNumber(value, key) {
    const found = optionalNumber(value, key);
    if (found === undefined || !Number.isFinite(found)) {
        throw new LegacyOpencodeSourceCorruptionError(key);
    }
    return found;
}
//# sourceMappingURL=readonly-source.js.map