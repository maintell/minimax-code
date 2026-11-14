export const migration = {
    version: 65,
    name: 'cron_run_scheduled_for',
    up: `
    ALTER TABLE local_runtime_v2_cron_runs ADD COLUMN scheduled_for_ms INTEGER;
  `,
};
//# sourceMappingURL=migration-0065-add-cron-run-scheduled-for.js.map