import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
/**
 * Merge requests linked to a Session. The current branch's merge request is
 * derived on read and only lands here once a Turn ends on that branch.
 * `removed_at_ms` keeps the user's removal so automatic recording does not
 * bring the link back.
 */
export const sessionMergeRequests = sqliteTable('local_runtime_v2_session_merge_requests', {
    sessionId: text('session_id').notNull(),
    refKey: text('ref_key').notNull(),
    platform: text('platform').notNull(),
    host: text('host').notNull(),
    projectPath: text('project_path').notNull(),
    number: integer('number').notNull(),
    webUrl: text('web_url').notNull(),
    source: text('source').notNull(),
    linkedAtMs: integer('linked_at_ms').notNull(),
    removedAtMs: integer('removed_at_ms'),
}, (table) => [primaryKey({ columns: [table.sessionId, table.refKey] })]);
//# sourceMappingURL=session-merge-requests.js.map