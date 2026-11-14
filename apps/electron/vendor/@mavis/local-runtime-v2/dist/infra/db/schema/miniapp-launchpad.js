import { desc, sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const miniAppCreations = sqliteTable('local_runtime_miniapp_creations', {
    accountId: text('account_id').notNull(),
    deployment: text('deployment').notNull(),
    id: text('id').notNull(),
    pluginId: text('plugin_id').notNull(),
    status: text('status', {
        enum: ['building', 'waiting', 'ready', 'failed', 'interrupted'],
    }).notNull(),
    sessionId: text('session_id'),
    sourceSessionId: text('source_session_id'),
    recommendationId: text('recommendation_id'),
    requirements: text('requirements').notNull(),
    sourceSummary: text('source_summary'),
    sourceTitle: text('source_title'),
    sourceCapturedAt: integer('source_captured_at_ms'),
    workspaceDir: text('workspace_dir'),
    error: text('error'),
    createdAt: integer('created_at_ms').notNull(),
}, (table) => [
    primaryKey({ columns: [table.accountId, table.deployment, table.id] }),
    check('miniapp_creation_status', sql `${table.status} IN ('building', 'waiting', 'ready', 'failed', 'interrupted')`),
    check('miniapp_creation_created_at', sql `${table.createdAt} >= 0`),
    index('idx_miniapp_creations_status').on(table.accountId, table.deployment, table.status, desc(table.createdAt), desc(table.id)),
    index('idx_miniapp_creations_plugin').on(table.accountId, table.deployment, table.pluginId),
    index('idx_miniapp_creations_source_session').on(table.accountId, table.deployment, table.sourceSessionId),
    index('idx_miniapp_creations_session').on(table.accountId, table.deployment, table.sessionId),
]);
export const MINIAPP_CREATION_INDEX_NAMES = new Set([
    'idx_miniapp_creations_status',
    'idx_miniapp_creations_plugin',
    'idx_miniapp_creations_source_session',
    'idx_miniapp_creations_session',
]);
//# sourceMappingURL=miniapp-launchpad.js.map