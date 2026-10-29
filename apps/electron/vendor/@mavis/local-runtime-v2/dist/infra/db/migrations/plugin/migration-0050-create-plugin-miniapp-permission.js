/** Stores user-disabled Mini App permissions; an absent row keeps a declared permission enabled. */
export const migration = {
    version: 50,
    name: 'create_plugin_miniapp_permission',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_plugin_miniapp_permission (
      plugin_id TEXT NOT NULL,
      plugin_source TEXT NOT NULL,
      permission TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, plugin_source, permission),
      CONSTRAINT local_runtime_plugin_miniapp_permission_source
        CHECK (plugin_source IN ('local', 'official')),
      CONSTRAINT local_runtime_plugin_miniapp_permission_enabled CHECK (enabled IN (0, 1))
    );
  `,
};
//# sourceMappingURL=migration-0050-create-plugin-miniapp-permission.js.map