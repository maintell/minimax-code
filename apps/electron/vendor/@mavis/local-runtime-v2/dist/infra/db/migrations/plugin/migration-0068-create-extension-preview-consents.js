/**
 * Session preview records in `extension_preview_consents`, keyed by `(session, plugin)`.
 * `bound_digest` is the candidate the last activation or reload bound; preview permission is
 * managed separately by the `extension` / `preview` permission rule.
 *
 * The drop of `extension_session_grants` covers databases created by pre-release train builds; a
 * profile that already recorded version 56 from a build before this migration was renumbered must
 * start a fresh profile, because the migration ledger is version-only.
 */
export const migration = {
    version: 68,
    name: 'create_extension_preview_consents',
    up: `
    CREATE TABLE IF NOT EXISTS extension_preview_consents (
      session_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      bound_digest TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, plugin_id)
    );
    DROP TABLE IF EXISTS extension_session_grants;
  `,
};
//# sourceMappingURL=migration-0068-create-extension-preview-consents.js.map