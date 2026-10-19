export const migration = {
    version: 39,
    name: 'memory_governance_revision',
    up(database) {
        database.exec(`
      ALTER TABLE local_runtime_v2_memory_scopes ADD COLUMN governance_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE local_runtime_v2_memory_scopes ADD COLUMN consolidated_governance_revision INTEGER NOT NULL DEFAULT 0;
    `);
    },
};
//# sourceMappingURL=migration-0039-memory-governance-revision.js.map