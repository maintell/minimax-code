/**
 * Backup overlay for the shipped migration catalog.
 *
 * `MigrationEntry.backup` made pre-migration backups opt-in, but the
 * already-merged catalog entries predate the flag and are frozen (their file
 * hashes are pinned against the merge base), so none of them can declare it
 * in place. Without this overlay the opt-in switch silently removed the
 * pre-migration copy that the always-on backup used to give lossy upgrades.
 * The overlay re-attaches the demand outside the frozen files: initialize
 * applies it to the shipped catalog before any consumer (backup stage,
 * strict slices, recovery runner) sees the entries.
 *
 * Inventory of every registered migration (standard: rewrites or deletes
 * existing primary user data rows → demands a backup; purely additive DDL,
 * INSERT-only copies that keep their source, or idempotent recomputation of
 * derived state → does not):
 *
 * | ver | name                                              | backup | reason |
 * |-----|---------------------------------------------------|--------|--------|
 * | 1   | runtime_v2_baseline                               | no     | CREATE-only baseline DDL |
 * | 2   | copy-legacy-cron-data                             | no     | INSERT-only copy; legacy source rows retained |
 * | 3   | add_scheduler_schedule_generation                 | no     | conditional ADD COLUMN |
 * | 4   | copy-legacy-cron-run-history                      | no     | INSERT-only copy rerun |
 * | 5   | adopt_plugin_state                                | no     | CREATE IF NOT EXISTS; drops only the plugin migration bookkeeping table |
 * | 6   | create_session_storage                            | no     | CREATE tables/FTS/triggers only |
 * | 7   | backfill_session_storage                          | YES    | rewrites every session row from record_json; drops and rebuilds local_runtime_projects |
 * | 8   | normalize_turn_ingress                            | YES    | blanks input_json to digests; deletes and rebuilds sequence + client-request rows |
 * | 9   | session_query_indexes                             | no     | ADD COLUMN + backfill of the new columns only |
 * | 10  | converge_session_queue                            | YES    | INSERT-SELECT merge then DELETE of source queue rows; drops terminal items |
 * | 11  | create_file_api_upload_cache                      | no     | CREATE table |
 * | 12  | restore_legacy_primary_agent                      | YES    | rewrites session agent_name + FTS terms; prior value not retained |
 * | 13  | backfill_v1_session_record_json                   | no     | fills only literal '{}' placeholders |
 * | 14  | create-agents                                     | no     | CREATE table + indexes |
 * | 15  | repair_legacy_default_projects                    | YES    | flips project classification; original project_workspace_dir nulled |
 * | 16  | create_query_collapse_view_states                 | no     | CREATE table |
 * | 17  | align_project_task_aggregates                     | no     | trigger DDL + recompute of derived aggregates |
 * | 18  | restore_project_v5_trigger_compatibility          | no     | trigger DDL + derived aggregates recompute |
 * | 20  | create_task_session_bindings                      | no     | CREATE table |
 * | 21  | add_session_history_relative_dir                  | no     | ADD COLUMN |
 * | 22  | create_queue_pauses                               | no     | CREATE table |
 * | 23  | create_miniapp_state                              | no     | CREATE + contract asserts |
 * | 24  | create_canvas                                     | no     | CREATE tables |
 * | 25  | create_session_resources                          | no     | CREATE IF NOT EXISTS |
 * | 26  | relax_source_tool_call_index                      | no     | index rebuild, structure only |
 * | 27  | repair_task_session_bindings_version_collision    | no     | CREATE IF NOT EXISTS |
 * | 28  | repair_session_history_relative_dir_version_coll. | no     | conditional ADD COLUMN |
 * | 29  | repair_queue_pauses_version_collision             | no     | CREATE IF NOT EXISTS |
 * | 30  | repair_liveboard_state_version_collision          | no     | create-if-missing + contract assert |
 * | 31  | repair_canvas_version_collision                   | no     | CREATE IF NOT EXISTS |
 * | 32  | repair_query_continuation_duration                | no     | idempotent recompute of derived display anchors from retained ingress facts |
 * | 33  | converge_channel_session_project_schema           | YES    | rewrites session_kind/visibility of hidden channel-like sessions; prior kind lost |
 * | 34  | restore_shared_project_schema_compatibility       | no     | index/trigger DDL only |
 * | 35  | converge_published_schema_version_collisions      | no     | conditional re-asserts + derived recompute |
 * | 36  | repair_cron_manual_request_index                  | no     | conditional CREATE INDEX |
 * | 37  | create_memory_v2                                  | no     | CREATE tables (superseded by 38) |
 * | 38  | rebuild_memory_v2                                 | no     | drops legacy Memory tables only when empty (refuses otherwise); recreates structure |
 * | 39  | memory_governance_revision                        | no     | ADD COLUMN |
 * | 40  | memory_executions                                 | no     | CREATE tables |
 * | 41  | create_session_clio                               | no     | CREATE tables |
 * | 42  | repair_session_sidechats_version_collision        | no     | CREATE table/index if missing; contract assert |
 * | 43  | cron_deferred_delivery                            | no     | ADD COLUMN |
 * | 44  | converge_rc_sidechat_version_collision            | YES    | replays m33's channel backfill (rewrites session_kind/visibility) plus 34/42 repairs |
 *
 * The Memory version-collision adoption (`memory-migration-recovery.ts`) is
 * not a catalog entry but replays m33, so initialize treats a pending
 * adoption as a backup demand of its own.
 *
 * See `.harness/docs/adr/local-runtime-migration-fault-tolerance.md`.
 */
const BACKUP_DEMANDING_VERSIONS = new Set([7, 8, 10, 12, 15, 33, 44]);
/**
 * Returns the catalog with `backup: true` spread onto every entry whose
 * version is in {@link BACKUP_DEMANDING_VERSIONS}. Entries are otherwise
 * untouched and unknown versions pass through unchanged, so applying the
 * overlay twice is a no-op.
 */
export function applyBackupOverlay(catalog) {
    return catalog.map((entry) => BACKUP_DEMANDING_VERSIONS.has(entry.version) && entry.backup !== true
        ? { ...entry, backup: true }
        : entry);
}
//# sourceMappingURL=migration-backup-overlay.js.map