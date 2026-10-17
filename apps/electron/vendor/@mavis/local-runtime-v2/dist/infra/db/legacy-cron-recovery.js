import { Cron } from 'croner';
/**
 * Version 2 is already published, so startup repairs the one legacy shape that
 * would make that migration abort before the frozen migration runner sees it.
 */
export function disableLegacyCronsWithoutFutureRun(options) {
    if (!options.version2Pending || !tableExists(options.database, 'local_runtime_crons'))
        return 0;
    const rows = options.database.rawDb
        .prepare('SELECT rowid, config_json FROM local_runtime_crons ORDER BY rowid')
        .all();
    const update = options.database.rawDb.prepare('UPDATE local_runtime_crons SET config_json = ? WHERE rowid = ?');
    const now = new Date(options.nowMs ?? Date.now());
    let disabledCount = 0;
    const repair = options.database.rawDb.transaction(() => {
        for (const row of rows) {
            const config = parseCandidate(row.config_json);
            if (!config || config.disabled || config.scheduleType === 'once')
                continue;
            if (typeof config.schedule !== 'string' || config.schedule.trim() === '')
                continue;
            let timer;
            try {
                timer = new Cron(config.schedule, {
                    timezone: typeof config.timezone === 'string' ? config.timezone : undefined,
                    paused: true,
                    unref: true,
                });
            }
            catch {
                // Syntax and timezone errors retain the published migration's failure semantics.
                continue;
            }
            try {
                if (timer.nextRun(now) !== null)
                    continue;
            }
            finally {
                timer.stop();
            }
            update.run(JSON.stringify({ ...config, disabled: true }), row.rowid);
            disabledCount += 1;
        }
    });
    repair();
    return disabledCount;
}
function parseCandidate(configJson) {
    try {
        const value = JSON.parse(configJson);
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? value
            : undefined;
    }
    catch {
        return undefined;
    }
}
function tableExists(database, tableName) {
    return Boolean(database.rawDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName));
}
//# sourceMappingURL=legacy-cron-recovery.js.map