/**
 * Drops the merge request links that Turn ends recorded from the branch of the
 * Session's directory. Several Sessions often share one checkout, so every
 * Session in a checkout on a long-lived branch was linked to that branch's
 * merge request (for example the release merge request of an integration
 * branch). Turn ends no longer record anything; links now come from what the
 * Session did: an agent creating or pushing to a merge request, a change made
 * from the panel, or the user linking one.
 *
 * Destructive on purpose and without a backup: the rows were derived, never
 * typed by the user, and only Internal and test builds ever wrote them.
 */
export const migration = {
    version: 72,
    name: 'drop_turn_end_merge_request_links',
    up: dropTurnEndMergeRequestLinks,
};
function dropTurnEndMergeRequestLinks(database) {
    database.exec(`DELETE FROM local_runtime_v2_session_merge_requests WHERE source = 'branch'`);
}
//# sourceMappingURL=migration-0072-drop-turn-end-merge-request-links.js.map