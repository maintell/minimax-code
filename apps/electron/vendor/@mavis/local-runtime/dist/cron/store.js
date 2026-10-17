import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CronConfigSchema, } from '@mavis/cron';
import { withLocalRuntimeDb } from '../persistence/db.js';
export class SqliteLocalCronStore {
    dataDir;
    nowMs;
    constructor(dataDir, nowMs = () => Date.now()) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    async configPath(agentName, cronName) {
        return path.join(this.resolveDataDir(), 'local-crons', agentName, `${cronName}.json`);
    }
    async get(agentName, cronName) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          WHERE agent_name = ? AND cron_name = ?
        `)
                .get(agentName, cronName);
            if (!row)
                return undefined;
            // Lazy back-fill so any row read through the store always has a cron_id
            // persisted, even if it escaped the migration sweep.
            this.ensureRowCronId(db, row);
            return parseCronConfig(row.config_json);
        });
    }
    async listByAgent(agentName) {
        return this.withDb((db) => {
            const rows = db
                .prepare(`
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          WHERE agent_name = ?
          ORDER BY cron_name ASC
        `)
                .all(agentName);
            return rows.flatMap((row) => this.rowToLoadResult(db, row));
        });
    }
    async listAll() {
        return this.withDb((db) => {
            const rows = db
                .prepare(`
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          ORDER BY agent_name ASC, cron_name ASC
        `)
                .all();
            return rows.flatMap((row) => this.rowToLoadResult(db, row));
        });
    }
    async getByCronId(cronId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT agent_name, cron_name, config_json, cron_id FROM local_runtime_crons
          WHERE cron_id = ?
        `)
                .get(cronId);
            if (!row)
                return undefined;
            return this.rowToLoadResult(db, row)[0];
        });
    }
    async resolveKeyByCronId(cronId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT agent_name, cron_name FROM local_runtime_crons
          WHERE cron_id = ?
        `)
                .get(cronId);
            if (!row?.agent_name || !row?.cron_name)
                return undefined;
            return { agentName: row.agent_name, cronName: row.cron_name };
        });
    }
    async create(agentName, cronName, config) {
        const parsed = normalizeCronConfig(config);
        this.withDb((db) => {
            const existing = db
                .prepare(`
          SELECT 1 FROM local_runtime_crons
          WHERE agent_name = ? AND cron_name = ?
        `)
                .get(agentName, cronName);
            if (existing) {
                throw new Error(`Cron task already exists: ${agentName}/${cronName}`);
            }
            db.prepare(`
        INSERT INTO local_runtime_crons (agent_name, cron_name, config_json, updated_at_ms, cron_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(agentName, cronName, JSON.stringify(parsed), this.nowMs(), randomUUID());
        });
        return parsed;
    }
    async update(agentName, cronName, fields) {
        const current = await this.get(agentName, cronName);
        if (!current)
            throw new Error(`Cron task not found: ${agentName}/${cronName}`);
        const updated = normalizeCronConfig(applyCronConfigUpdate(current, fields));
        this.withDb((db) => {
            db.prepare(`
        UPDATE local_runtime_crons
        SET config_json = ?, updated_at_ms = ?
        WHERE agent_name = ? AND cron_name = ?
      `).run(JSON.stringify(updated), this.nowMs(), agentName, cronName);
        });
        return updated;
    }
    async delete(agentName, cronName) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                db.prepare(`
          DELETE FROM local_runtime_crons
          WHERE agent_name = ? AND cron_name = ?
        `).run(agentName, cronName);
                db.prepare(`
          DELETE FROM local_runtime_cron_session_history
          WHERE agent_name = ? AND cron_name = ?
        `).run(agentName, cronName);
            });
        });
    }
    async appendSessionRun(agentName, cronName, record) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_cron_session_history (
          agent_name, cron_name, session_id, created_at_ms
        ) VALUES (?, ?, ?, ?)
      `).run(agentName, cronName, record.sessionId, record.createdAt);
        });
    }
    async getSessionHistory(agentName, cronName) {
        return this.withDb((db) => {
            const rows = db
                .prepare(`
          SELECT session_id, created_at_ms
          FROM local_runtime_cron_session_history
          WHERE agent_name = ? AND cron_name = ?
          ORDER BY created_at_ms ASC, id ASC
        `)
                .all(agentName, cronName);
            return rows.flatMap((row) => {
                if (!row.session_id || typeof row.created_at_ms !== 'number')
                    return [];
                return [{ sessionId: row.session_id, createdAt: row.created_at_ms }];
            });
        });
    }
    async replaceSessionHistory(agentName, cronName, records) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                db.prepare(`
          DELETE FROM local_runtime_cron_session_history
          WHERE agent_name = ? AND cron_name = ?
        `).run(agentName, cronName);
                const insert = db.prepare(`
          INSERT INTO local_runtime_cron_session_history (
            agent_name, cron_name, session_id, created_at_ms
          ) VALUES (?, ?, ?, ?)
        `);
                for (const record of records) {
                    insert.run(agentName, cronName, record.sessionId, record.createdAt);
                }
            });
        });
    }
    async deleteSessionHistory(agentName, cronName) {
        this.withDb((db) => {
            db.prepare(`
        DELETE FROM local_runtime_cron_session_history
        WHERE agent_name = ? AND cron_name = ?
      `).run(agentName, cronName);
        });
    }
    rowToLoadResult(db, row) {
        if (!row.agent_name || !row.cron_name)
            return [];
        const config = parseCronConfig(row.config_json);
        if (!config)
            return [];
        const cronId = this.ensureRowCronId(db, row);
        return [
            {
                agentName: row.agent_name,
                cronName: row.cron_name,
                config,
                cronId,
                configPath: path.join(this.resolveDataDir(), 'local-crons', row.agent_name, `${row.cron_name}.json`),
            },
        ];
    }
    /**
     * Guarantee the row carries a persisted cron_id. Migration back-fill should
     * already cover every row, but a row read with `cron_id IS NULL` (e.g. one
     * written by an older path) is repaired in place here so callers always see
     * a stable id. Mutates `row.cron_id` and returns the resolved value.
     */
    ensureRowCronId(db, row) {
        if (typeof row.cron_id === 'string' && row.cron_id.length > 0)
            return row.cron_id;
        if (!row.agent_name || !row.cron_name)
            return '';
        const minted = randomUUID();
        db.prepare(`
      UPDATE local_runtime_crons
      SET cron_id = ?
      WHERE agent_name = ? AND cron_name = ? AND cron_id IS NULL
    `).run(minted, row.agent_name, row.cron_name);
        // Re-read so a concurrent writer that won the back-fill race wins here too.
        const persisted = db
            .prepare('SELECT cron_id FROM local_runtime_crons WHERE agent_name = ? AND cron_name = ?')
            .get(row.agent_name, row.cron_name);
        const resolved = typeof persisted?.cron_id === 'string' && persisted.cron_id.length > 0
            ? persisted.cron_id
            : minted;
        row.cron_id = resolved;
        return resolved;
    }
    resolveDataDir() {
        return typeof this.dataDir === 'function' ? this.dataDir() : this.dataDir;
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function normalizeCronConfig(config) {
    return CronConfigSchema.parse(config);
}
function parseCronConfig(raw) {
    if (!raw)
        return undefined;
    try {
        return normalizeCronConfig(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
function applyCronConfigUpdate(config, fields) {
    return {
        ...config,
        ...(fields.disabled !== undefined ? { disabled: fields.disabled } : {}),
        ...(fields.schedule !== undefined ? { schedule: fields.schedule } : {}),
        ...(fields.prompt !== undefined ? { prompt: fields.prompt } : {}),
        ...(fields.session !== undefined ? { session: fields.session } : {}),
        ...(fields.timezone !== undefined
            ? fields.timezone === null
                ? { timezone: undefined }
                : { timezone: fields.timezone }
            : {}),
        ...(fields.activeHours !== undefined
            ? fields.activeHours === null
                ? { activeHours: undefined }
                : { activeHours: fields.activeHours }
            : {}),
        ...(fields.delivery !== undefined
            ? fields.delivery === null
                ? { delivery: undefined }
                : { delivery: fields.delivery }
            : {}),
        ...(fields.report_to_root !== undefined
            ? fields.report_to_root === null
                ? { report_to_root: undefined }
                : { report_to_root: fields.report_to_root }
            : {}),
        ...(fields.report_to_main !== undefined
            ? fields.report_to_main === null
                ? { report_to_main: undefined }
                : { report_to_main: fields.report_to_main }
            : {}),
    };
}
function runInTransaction(db, fn) {
    if (db.transaction) {
        db.transaction(fn)();
        return;
    }
    db.exec('BEGIN');
    try {
        fn();
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
//# sourceMappingURL=store.js.map