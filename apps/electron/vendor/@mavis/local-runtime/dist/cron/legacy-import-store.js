import { withLocalRuntimeDb } from '../persistence/db.js';
export class SqliteCronLegacyImportStore {
    dataDir;
    nowMs;
    constructor(dataDir, nowMs = () => Date.now()) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    async has(agentName, cronName) {
        return this.withDb((db) => {
            const row = db
                .prepare(`SELECT 1 FROM local_runtime_cron_legacy_imports
           WHERE agent_name = ? AND cron_name = ?`)
                .get(agentName, cronName);
            return row !== undefined;
        });
    }
    async record(agentName, cronName) {
        this.withDb((db) => {
            db.prepare(`INSERT OR IGNORE INTO local_runtime_cron_legacy_imports
           (agent_name, cron_name, imported_at_ms)
         VALUES (?, ?, ?)`).run(agentName, cronName, this.nowMs());
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
//# sourceMappingURL=legacy-import-store.js.map