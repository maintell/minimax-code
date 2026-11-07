import fs from 'node:fs';
import path from 'node:path';
import {} from './legacy-opencode-store-contracts.js';
import { inspectLegacySchema, canReadLegacySessions, buildSessionQuery, buildSessionIdWhere, buildRuntimeFilter, qualifiedColumn, buildSessionOrderBy, loadBetterSqlite3, canReadLegacyMessages, hasColumn, normalizeMessagePageBytes, readStreamedMessageRow, emptyMessageScan, scanMessageRows, readNativeMessagesFromDb, getTableColumns, quoteIdentifier, selectFirstColumn, toLegacyAgent, resolveXdgPath, fileSizeField, inspectOpenCodeNativeSources, countKnownLegacyTables, inspectLegacyDaemonSchemaManifest, normalizeMessageListOptions, normalizeMessageLimit, readLatestParsedMessages, readMessageRow, buildSessionIdResolutionQuery, parseTimestampMs, toSessionType, readVisibility, readPurpose, toLocalStatus, } from './legacy-opencode-store-readers.js';
import { DEFAULT_MESSAGE_PAGE_BYTES } from './legacy-opencode-store-values.js';
export class LegacyOpencodeStore {
    dataDir;
    nowMs;
    constructor(options) {
        this.dataDir = options.dataDir;
        this.nowMs = options.nowMs ?? (() => Date.now());
    }
    async getSession(sessionId) {
        return this.withDb((db) => {
            const schema = inspectLegacySchema(db);
            if (!canReadLegacySessions(schema))
                return undefined;
            const query = buildSessionQuery(schema, {
                where: buildSessionIdWhere(schema),
                orderBy: '',
                limit: 'LIMIT 1',
            });
            const row = db.prepare(query.sql).get(...query.params(sessionId));
            return row ? this.toLocalSession(row) : undefined;
        });
    }
    async listSessions(agentName) {
        return (this.withDb((db) => {
            const schema = inspectLegacySchema(db);
            if (!canReadLegacySessions(schema))
                return [];
            const params = [];
            const filters = [buildRuntimeFilter(schema)];
            if (agentName) {
                filters.push(`${qualifiedColumn('s', 'agent_name')} = ?`);
                params.push(agentName);
            }
            const orderBy = buildSessionOrderBy(schema);
            const query = buildSessionQuery(schema, {
                where: filters.join(' AND '),
                orderBy,
            });
            const rows = db.prepare(query.sql).all(...params);
            return rows.map((row) => this.toLocalSession(row));
        }) ?? []);
    }
    async listMessages(sessionId, limitOrOptions) {
        return (await this.listMessagePage(sessionId, limitOrOptions)).messages;
    }
    async listMessagePage(sessionId, limitOrOptions) {
        return (this.withDb((db) => {
            const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
            if (!resolvedSessionId)
                return { messages: [] };
            return this.listResolvedMessagePage(db, resolvedSessionId, limitOrOptions);
        }) ?? { messages: [] });
    }
    /**
     * Forward-streaming reader over a legacy session's messages, in the same
     * ascending order as {@link listMessages}, yielded one bounded page at a
     * time. The underlying read-only DB handle is opened once for the whole
     * iteration and closed when the generator finishes or the consumer stops
     * early (`for await` + `break`/`return` both trigger the `finally`). Pages are
     * read through better-sqlite3's forward iterator so neither OFFSET rescans nor
     * a second raw-row array stays resident while the consumer writes a page.
     *
     * Both message count and serialized source bytes bound a page. A single row
     * may exceed `maxPageBytes`, but it is yielded alone. Yields nothing when the
     * session or message table is unreadable (same tolerance as
     * {@link listMessagePage}).
     */
    async *streamMessagePages(sessionId, pageSize, maxPageBytes = DEFAULT_MESSAGE_PAGE_BYTES) {
        const dbPath = path.join(this.dataDir, 'sqlite.db');
        if (!fs.existsSync(dbPath))
            return;
        const Database = loadBetterSqlite3();
        if (!Database)
            return;
        const limit = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 500;
        let db;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
        }
        catch {
            return;
        }
        let rows;
        try {
            const schema = inspectLegacySchema(db);
            if (!canReadLegacyMessages(schema))
                return;
            const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
            if (!resolvedSessionId)
                return;
            const idColumn = hasColumn(schema, 'session_messages', 'id') ? 'id' : 'rowid';
            const statement = db.prepare(`
        SELECT ${idColumn} AS id, data
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ${idColumn} ASC
      `);
            const byteLimit = normalizeMessagePageBytes(maxPageBytes);
            rows = statement.iterate(resolvedSessionId);
            yield* this.streamParsedPages(rows, limit, byteLimit);
        }
        finally {
            rows?.return?.();
            db.close();
        }
    }
    *streamParsedPages(rows, limit, byteLimit) {
        let page = [];
        let pageBytes = 0;
        for (;;) {
            let next = rows.next();
            if (next.done)
                break;
            const parsed = readStreamedMessageRow(next.value);
            next = undefined;
            if (!parsed.message)
                continue;
            if (page.length > 0 && pageBytes + parsed.rawBytes > byteLimit) {
                const ready = page;
                page = [];
                pageBytes = 0;
                yield ready;
            }
            page.push(parsed.message);
            pageBytes += parsed.rawBytes;
            if (page.length >= limit || pageBytes >= byteLimit) {
                const ready = page;
                page = [];
                pageBytes = 0;
                yield ready;
            }
        }
        if (page.length > 0)
            yield page;
    }
    async countMessages(sessionId) {
        return (this.withDb((db) => {
            const schema = inspectLegacySchema(db);
            if (!canReadLegacyMessages(schema))
                return 0;
            const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
            if (!resolvedSessionId)
                return 0;
            const row = db
                .prepare('SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?')
                .get(resolvedSessionId);
            return typeof row?.count === 'number' ? row.count : 0;
        }) ?? 0);
    }
    async scanMessages(sessionId) {
        return (this.withDb((db) => {
            const schema = inspectLegacySchema(db);
            if (!canReadLegacyMessages(schema))
                return emptyMessageScan();
            const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
            if (!resolvedSessionId)
                return emptyMessageScan();
            const idColumn = hasColumn(schema, 'session_messages', 'id') ? 'id' : 'rowid';
            const rows = db
                .prepare(`
            SELECT ${idColumn} AS id, data
            FROM session_messages
            WHERE session_id = ?
            ORDER BY ${idColumn} ASC
          `)
                .iterate(resolvedSessionId);
            return scanMessageRows(rows);
        }) ?? emptyMessageScan());
    }
    async listNativeMessages(session) {
        const manifest = await this.getSourceManifest();
        for (const candidate of manifest.opencodeNative?.candidates ?? []) {
            if (!candidate.dbExists)
                continue;
            const result = this.withNativeDb(candidate.dbPath, (db) => readNativeMessagesFromDb(db, candidate, session));
            if (result && result.messages.length > 0)
                return result;
        }
        return undefined;
    }
    async getAgent(agentName) {
        return this.withDb((db) => {
            const columns = getTableColumns(db, 'agents');
            if (!columns.has('agent_name'))
                return undefined;
            const selects = [
                quoteIdentifier('agent_name'),
                selectFirstColumn(columns, ['framework_type'], 'framework_type'),
                selectFirstColumn(columns, ['display_name', 'agent_display_name'], 'display_name'),
                selectFirstColumn(columns, ['description'], 'description'),
                selectFirstColumn(columns, ['avatar'], 'avatar'),
                selectFirstColumn(columns, ['persona'], 'persona'),
                selectFirstColumn(columns, ['system_prompt', 'systemPrompt'], 'system_prompt'),
                selectFirstColumn(columns, ['default_workspace_dir', 'workspace_dir'], 'default_workspace_dir'),
                selectFirstColumn(columns, ['main_session_id', 'root_session_id'], 'root_session_id'),
                selectFirstColumn(columns, ['created_at'], 'created_at'),
                selectFirstColumn(columns, ['updated_at'], 'updated_at'),
            ].filter((select) => Boolean(select));
            const row = db
                .prepare(`
          SELECT ${selects.join(', ')}
          FROM agents
          WHERE agent_name = ?
          LIMIT 1
        `)
                .get(agentName);
            return row ? toLegacyAgent(row) : undefined;
        });
    }
    async getSourceManifest() {
        const sqlitePath = path.join(this.dataDir, 'sqlite.db');
        const walPath = `${sqlitePath}-wal`;
        const shmPath = `${sqlitePath}-shm`;
        const sourceOpenCodeDataPath = path.join(this.dataDir, 'opencode', 'data', 'opencode');
        const sourceOpenCodeStatePath = path.join(this.dataDir, 'opencode', 'state', 'opencode');
        const sourceOpenCodeXdgDataPath = resolveXdgPath('XDG_DATA_HOME', ['.local', 'share'], ['opencode']);
        const sourceOpenCodeXdgStatePath = resolveXdgPath('XDG_STATE_HOME', ['.local', 'state'], ['opencode']);
        const manifest = {
            sourceDataDir: this.dataDir,
            sourceSqlitePath: sqlitePath,
            sourceSqliteExists: fs.existsSync(sqlitePath),
            ...fileSizeField('sourceSqliteSizeBytes', sqlitePath),
            sourceSqliteWalPath: walPath,
            sourceSqliteWalExists: fs.existsSync(walPath),
            ...fileSizeField('sourceSqliteWalSizeBytes', walPath),
            sourceSqliteShmPath: shmPath,
            sourceSqliteShmExists: fs.existsSync(shmPath),
            ...fileSizeField('sourceSqliteShmSizeBytes', shmPath),
            sourceOpenCodeDataPath,
            sourceOpenCodeDataExists: fs.existsSync(sourceOpenCodeDataPath),
            sourceOpenCodeStatePath,
            sourceOpenCodeStateExists: fs.existsSync(sourceOpenCodeStatePath),
            sourceOpenCodeXdgDataPath,
            sourceOpenCodeXdgDataExists: fs.existsSync(sourceOpenCodeXdgDataPath),
            sourceOpenCodeXdgStatePath,
            sourceOpenCodeXdgStateExists: fs.existsSync(sourceOpenCodeXdgStatePath),
            opencodeNative: inspectOpenCodeNativeSources({
                sandboxDataPath: sourceOpenCodeDataPath,
                sandboxStatePath: sourceOpenCodeStatePath,
                xdgDataPath: sourceOpenCodeXdgDataPath,
                xdgStatePath: sourceOpenCodeXdgStatePath,
            }),
        };
        if (!manifest.sourceSqliteExists)
            return manifest;
        const sourceDetails = this.withDb((db) => ({
            tableCounts: countKnownLegacyTables(db),
            legacyDaemonSchema: inspectLegacyDaemonSchemaManifest(db),
        }));
        return sourceDetails
            ? { ...manifest, ...sourceDetails }
            : {
                ...manifest,
                errors: ['legacy_sqlite_unreadable_or_unavailable'],
            };
    }
    listResolvedMessagePage(db, sessionId, limitOrOptions) {
        const schema = inspectLegacySchema(db);
        if (!canReadLegacyMessages(schema))
            return { messages: [] };
        const options = normalizeMessageListOptions(limitOrOptions);
        const limit = normalizeMessageLimit(options.limit);
        const before = options.before;
        const idColumn = hasColumn(schema, 'session_messages', 'id') ? 'id' : 'rowid';
        if (!before && limit > 0) {
            const messagesDescending = readLatestParsedMessages(db, {
                sessionId,
                idColumn,
                limit,
            });
            const hasMore = messagesDescending.length > limit;
            const messages = messagesDescending.slice(0, limit).reverse();
            return {
                messages,
                ...(hasMore && messages[0]?.msg_id ? { nextCursor: messages[0].msg_id } : {}),
            };
        }
        const rows = db
            .prepare(`
        SELECT ${idColumn} AS id, data
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ${idColumn} ASC
      `)
            .all(sessionId);
        const allMessages = rows.flatMap(readMessageRow);
        return this.sliceMessagePage(allMessages, { before, limit });
    }
    sliceMessagePage(allMessages, { before, limit }) {
        const beforeIndex = before ? allMessages.findIndex((message) => message.msg_id === before) : -1;
        const visibleMessages = beforeIndex >= 0 ? allMessages.slice(0, beforeIndex) : allMessages;
        if (limit <= 0)
            return { messages: visibleMessages };
        const start = Math.max(visibleMessages.length - limit, 0);
        const messages = visibleMessages.slice(start);
        const hasMore = start > 0;
        return {
            messages,
            ...(hasMore && messages[0]?.msg_id ? { nextCursor: messages[0].msg_id } : {}),
        };
    }
    resolveStoredSessionId(db, sessionId) {
        const schema = inspectLegacySchema(db);
        if (!canReadLegacySessions(schema))
            return undefined;
        const query = buildSessionIdResolutionQuery(schema);
        const row = db.prepare(query.sql).get(...query.params(sessionId));
        return row?.session_id;
    }
    withDb(fn) {
        const dbPath = path.join(this.dataDir, 'sqlite.db');
        if (!fs.existsSync(dbPath))
            return undefined;
        const Database = loadBetterSqlite3();
        if (!Database)
            return undefined;
        let db;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
        }
        catch {
            return undefined;
        }
        try {
            return fn(db);
        }
        finally {
            db.close();
        }
    }
    withNativeDb(dbPath, fn) {
        if (!fs.existsSync(dbPath))
            return undefined;
        const Database = loadBetterSqlite3();
        if (!Database)
            return undefined;
        let db;
        try {
            db = new Database(dbPath, { readonly: true, fileMustExist: true });
        }
        catch {
            return undefined;
        }
        try {
            return fn(db);
        }
        finally {
            db.close();
        }
    }
    toLocalSession(row) {
        const createdAt = parseTimestampMs(row.created_at, this.nowMs());
        const updatedAt = parseTimestampMs(row.updated_at, createdAt);
        return {
            sessionId: row.session_id,
            agentName: row.agent_name,
            workspaceDir: row.workspace_dir ?? this.defaultWorkspaceDir(row),
            runtime: 'opencode',
            sessionType: toSessionType(row.session_type),
            archived: row.compressed === 1,
            pinned: row.pinned === 1,
            title: row.title,
            parentSessionId: row.parent_session_id,
            visibility: readVisibility(row.extra_data),
            purpose: readPurpose(row.extra_data),
            status: toLocalStatus(row.status),
            createdAtMs: createdAt,
            updatedAtMs: updatedAt,
            legacyRawStatus: row.status,
            ...(row.framework_session_id ? { legacyFrameworkSessionId: row.framework_session_id } : {}),
        };
    }
    defaultWorkspaceDir(row) {
        if (row.session_data_dir)
            return path.join(row.session_data_dir, 'workspace');
        return path.join(this.dataDir, 'sessions', row.session_id, 'workspace');
    }
}
export {} from './legacy-opencode-store-contracts.js';
//# sourceMappingURL=legacy-opencode-store.js.map