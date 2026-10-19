export const migration = {
    version: 21,
    name: 'add_session_history_relative_dir',
    up: (database) => {
        const existing = database
            .prepare("SELECT name FROM pragma_table_info('local_runtime_sessions') WHERE name = ?")
            .all('history_relative_dir');
        if (existing.length > 0)
            return;
        database.exec(`
      ALTER TABLE local_runtime_sessions
        ADD COLUMN history_relative_dir TEXT;
    `);
    },
};
//# sourceMappingURL=migration-0021-add-session-history-relative-dir.js.map