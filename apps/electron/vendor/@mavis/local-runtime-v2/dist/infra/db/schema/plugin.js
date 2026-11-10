import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const pluginOfficialStates = sqliteTable('local_runtime_plugin_official_state', {
    principalId: text('principal_id').notNull(),
    deployment: text('deployment').notNull(),
    stateJson: text('state_json').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [primaryKey({ columns: [table.principalId, table.deployment] })]);
export const pluginDisabledLocalRoots = sqliteTable('local_runtime_plugin_local_disabled', {
    canonicalRoot: text('canonical_root').primaryKey(),
    updatedAtMs: integer('updated_at_ms').notNull(),
});
/** User-disabled Mini App permissions; an absent row means the declared permission is enabled. */
export const pluginMiniAppPermissions = sqliteTable('local_runtime_plugin_miniapp_permission', {
    pluginId: text('plugin_id').notNull(),
    pluginSource: text('plugin_source', { enum: ['local', 'official'] }).notNull(),
    permission: text('permission').notNull(),
    enabled: integer('enabled').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
}, (table) => [
    primaryKey({ columns: [table.pluginId, table.pluginSource, table.permission] }),
    check('local_runtime_plugin_miniapp_permission_source', sql `${table.pluginSource} IN ('local', 'official')`),
    check('local_runtime_plugin_miniapp_permission_enabled', sql `${table.enabled} IN (0, 1)`),
]);
//# sourceMappingURL=plugin.js.map