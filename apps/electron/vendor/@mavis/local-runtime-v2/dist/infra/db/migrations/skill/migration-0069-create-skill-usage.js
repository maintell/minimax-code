/**
 * How often the model loaded each Skill through the `skill` tool. The skill catalog
 * keeps the descriptions of the most used Skills when the catalog budget is short;
 * `first_seen_at_ms` protects a newly installed Skill until it had a chance to be used.
 * `skill_key` is the normalized Skill name (NFKC, lower case).
 *
 * Version 69 follows 68 (`create_extension_preview_consents`), the highest number
 * `preview_train` publishes; reusing a published number would collide on merge.
 */
export const migration = {
    version: 69,
    name: 'create_skill_usage',
    up: createSkillUsage,
};
function createSkillUsage(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_skill_usage (
      skill_key TEXT PRIMARY KEY,
      use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
      last_used_at_ms INTEGER NOT NULL DEFAULT 0,
      first_seen_at_ms INTEGER NOT NULL
    )
  `);
}
//# sourceMappingURL=migration-0069-create-skill-usage.js.map