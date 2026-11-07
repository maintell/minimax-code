import { migration as cronDeferredDelivery } from '../cron/migration-0043-cron-deferred-delivery.js';
/**
 * Unreleased Goal builds recorded their Goal table and request ledger as
 * versions 43 and 44, which Cron deferred delivery and the RC/SideChat
 * convergence own, so such a profile skipped both. Those builds followed this
 * train's history through 42, which 44 only re-asserts; the Cron columns of 43
 * are what such a profile lacks. Every other profile already has them.
 */
export const migration = {
    version: 45,
    name: 'repair_goal_branch_version_collision',
    up(database) {
        if (hasColumn(database, 'local_runtime_v2_cron_runs', 'delivery_input_json'))
            return;
        if (typeof cronDeferredDelivery.up === 'string')
            database.exec(cronDeferredDelivery.up);
        else
            cronDeferredDelivery.up(database);
    },
};
function hasColumn(database, table, column) {
    return database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => row.name === column);
}
//# sourceMappingURL=migration-0045-repair-goal-branch-version-collision.js.map