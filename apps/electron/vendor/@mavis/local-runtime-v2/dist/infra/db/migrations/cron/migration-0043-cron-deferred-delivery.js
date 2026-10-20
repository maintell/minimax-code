export const migration = {
    version: 43,
    name: 'cron_deferred_delivery',
    up: `
    ALTER TABLE local_runtime_v2_cron_runs ADD COLUMN delivery_input_json TEXT;
    ALTER TABLE local_runtime_v2_cron_runs ADD COLUMN retry_at_ms INTEGER;
    ALTER TABLE local_runtime_v2_cron_runs ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0;
  `,
};
//# sourceMappingURL=migration-0043-cron-deferred-delivery.js.map