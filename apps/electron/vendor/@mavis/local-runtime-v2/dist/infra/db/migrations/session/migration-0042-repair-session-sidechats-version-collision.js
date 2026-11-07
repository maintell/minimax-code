import { migration as sessionClioMigration } from './migration-0041-create-session-clio.js';
// version 37 在 SideChat 与 Memory 分支分别发布过；保留历史 marker，
// 在新的全局版本补建 SideChat。Memory 38 已支持从缺少旧 Memory 表的数据库升级。
const TABLE_SQL = `CREATE TABLE local_runtime_session_sidechats (
  side_session_id TEXT PRIMARY KEY REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
  main_session_id TEXT NOT NULL REFERENCES local_runtime_sessions(session_id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL,
  CONSTRAINT local_runtime_session_sidechats_not_self CHECK (side_session_id <> main_session_id)
)`;
const INDEX_SQL = `CREATE INDEX idx_local_runtime_session_sidechats_main_created
  ON local_runtime_session_sidechats(main_session_id, created_at_ms DESC, side_session_id ASC)`;
export const migration = {
    version: 42,
    name: 'repair_session_sidechats_version_collision',
    up(database) {
        // Earlier SideChat builds occupied 41. Restore Clio from its frozen DDL
        // when that marker caused the canonical 41 migration to be skipped.
        if (database
            .prepare("SELECT 1 FROM sqlite_master WHERE name = 'local_runtime_session_clio_state'")
            .all().length === 0) {
            if (typeof sessionClioMigration.up === 'string')
                database.exec(sessionClioMigration.up);
            else
                sessionClioMigration.up(database);
        }
        for (const [name, sql] of [
            ['local_runtime_session_sidechats', TABLE_SQL],
            ['idx_local_runtime_session_sidechats_main_created', INDEX_SQL],
        ]) {
            const rows = database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').all(name);
            if (rows.length === 0) {
                database.exec(sql);
                continue;
            }
            const existing = rows[0];
            if (rows.length !== 1 ||
                typeof existing.sql !== 'string' ||
                normalize(existing.sql) !== normalize(sql)) {
                throw new Error(`SideChat migration 42 contract mismatch: ${name}`);
            }
        }
    },
};
function normalize(sql) {
    return sql.replace(/\s+/gu, '').replace(/;$/u, '').toLowerCase();
}
//# sourceMappingURL=migration-0042-repair-session-sidechats-version-collision.js.map