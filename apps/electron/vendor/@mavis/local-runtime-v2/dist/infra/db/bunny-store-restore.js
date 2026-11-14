import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { getTableName, sql } from 'drizzle-orm';
import { BUNNY_SETTING_PREFIX } from './bunny-store.js';
import { BUNNY_STORE_TABLE_METADATA, bunnyArtifactLibrary, bunnyAssignmentTaskEvents, bunnyAssignmentTasks, bunnyMediaDescriptions, bunnySettings, bunnyTaskTelemetry, } from './schema/bunny-store.js';
/** Schema name the backup's Bunny-store copy is attached under while restoring. */
const SOURCE = 'bunny_backup';
const TASKS = getTableName(bunnyAssignmentTasks);
const TASK_EVENTS = getTableName(bunnyAssignmentTaskEvents);
const SETTINGS = getTableName(bunnySettings);
/** Their owners put back the rows the reset snapshot recorded in `data.json`. */
const RESTORED_BY_OWNERS = new Set([
    getTableName(bunnyTaskTelemetry), // Telemetry acknowledgements are never rewound by restore.
    getTableName(bunnyArtifactLibrary),
    getTableName(bunnyMediaDescriptions),
]);
/**
 * Copies Bunny's rows back from a backup's Bunny-store copy, by ownership. The store also
 * holds tasks other assigners recorded, so it is never replaced as a file:
 *
 * - tables `clear()` empties (spaces and their Session links, memory cursors, the owners'
 *   ledger and delivery baseline, and any later Bunny-level table) come back whole; a row
 *   written since the reset keeps its value;
 * - imported files and media descriptions are left to their owners, which restore the rows the
 *   reset snapshot recorded;
 * - settings come back only for `bunny.` keys, replacing what initialization wrote;
 * - tasks stay in the store through initialization, so only tasks Bunny assigned that are
 *   gone since come back, with their events appended. Other assigners' rows are untouched.
 */
export function restoreBunnyStore(bunny, storePath) {
    bunny.run(sql `ATTACH DATABASE ${storePath} AS ${sql.raw(SOURCE)}`);
    try {
        bunny.transaction((tx) => {
            for (const { name } of BUNNY_STORE_TABLE_METADATA) {
                if (name === TASKS || name === TASK_EVENTS || name === SETTINGS)
                    continue;
                if (RESTORED_BY_OWNERS.has(name))
                    continue;
                copyRows(tx, name, { conflict: 'IGNORE' });
            }
            copyRows(tx, SETTINGS, {
                conflict: 'REPLACE',
                where: sql `key LIKE ${`${BUNNY_SETTING_PREFIX}%`}`,
            });
            const missing = JSON.stringify(tx
                .all(sql `SELECT task_id FROM ${sql.raw(`${SOURCE}.${TASKS}`)}
              WHERE assigner_agent_name = ${BUNNY_AGENT_NAME}
                AND task_id NOT IN (SELECT task_id FROM ${sql.raw(`main.${TASKS}`)})`)
                .map((row) => row.task_id));
            const restored = sql `task_id IN (SELECT value FROM json_each(${missing}))`;
            copyRows(tx, TASKS, { conflict: 'IGNORE', where: restored });
            // New sequence numbers keep the live history ordered; a task whose Session another
            // task holds now was not inserted, so its events stay out too.
            copyRows(tx, TASK_EVENTS, {
                conflict: 'IGNORE',
                where: sql `${restored} AND task_id IN (SELECT task_id FROM ${sql.raw(`main.${TASKS}`)}) ORDER BY seq`,
                exclude: ['seq'],
            });
        });
    }
    finally {
        bunny.run(sql.raw(`DETACH DATABASE ${SOURCE}`));
    }
}
/** `INSERT OR <conflict> ... SELECT` over the columns both copies of `table` have. */
function copyRows(tx, table, { conflict, where, exclude = [], }) {
    const source = new Set(tableColumns(tx, SOURCE, table));
    const columns = tableColumns(tx, 'main', table).filter((column) => source.has(column) && !exclude.includes(column));
    if (!columns.length)
        return;
    const list = columns.map((column) => `"${column}"`).join(', ');
    tx.run(sql `${sql.raw(`INSERT OR ${conflict} INTO main."${table}" (${list}) SELECT ${list} FROM ${SOURCE}."${table}"`)}${where ? sql ` WHERE ${where}` : sql ``}`);
}
function tableColumns(tx, schema, table) {
    return tx
        .all(sql.raw(`PRAGMA ${schema}.table_info("${table}")`))
        .map((row) => row.name);
}
//# sourceMappingURL=bunny-store-restore.js.map