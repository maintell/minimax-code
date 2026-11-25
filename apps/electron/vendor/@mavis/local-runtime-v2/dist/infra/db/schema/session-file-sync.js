import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
/** Local Session file → cloud asset node, one row per real path (migration 52). */
export const sessionFileSyncs = sqliteTable('local_runtime_session_file_syncs', {
    sessionId: text('session_id').notNull(),
    path: text('path').notNull(),
    nodeId: text('node_id').notNull(),
    sha256: text('sha256').notNull(),
    /** Stat of the file when `sha256` was known to match it; -1 forces a hash on the next read. */
    size: integer('size').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    drivePath: text('drive_path'),
    updatedAtMs: integer('updated_at_ms').notNull(),
    accountId: text('account_id'),
}, (table) => [
    primaryKey({ columns: [table.sessionId, table.path] }),
    index('idx_session_file_sync_node').on(table.nodeId),
]);
//# sourceMappingURL=session-file-sync.js.map