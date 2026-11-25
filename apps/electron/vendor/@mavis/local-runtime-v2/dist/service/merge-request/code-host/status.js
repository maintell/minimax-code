export function deriveStatus(signals) {
    if (signals.state !== 'open')
        return { status: signals.state, blockers: [], mergeable: false };
    const blockers = BLOCKER_RULES.filter(([, applies]) => applies(signals)).map(([blocker]) => blocker);
    if (!signals.platformMergeable && blockers.length === 0)
        blockers.push('other');
    return { status: pickStatus(signals), blockers, mergeable: signals.platformMergeable };
}
/**
 * Why the platform would refuse a merge now: nothing when it would merge, even
 * where the status still names a problem the project does not enforce.
 */
export function refusalBlockers(snapshot) {
    return snapshot.mergeable ? [] : snapshot.blockers;
}
const pipelineFailed = (signals) => signals.pipeline === 'failed';
const pipelineRunning = (signals) => signals.pipeline === 'pending' || signals.pipeline === 'running';
const BLOCKER_RULES = [
    ['draft', (signals) => signals.draft],
    ['conflict', (signals) => signals.conflict],
    ['pipeline_failed', pipelineFailed],
    ['pipeline_running', pipelineRunning],
    ['changes_requested', (signals) => signals.changesRequested],
    ['discussions_unresolved', (signals) => signals.unresolvedDiscussions > 0],
    ['approval_required', (signals) => signals.approvalRequired],
    ['need_rebase', (signals) => signals.needRebase],
    ['checking', (signals) => signals.checking],
];
/**
 * The first matching rule wins. Problems the author must act on outrank
 * waiting, and waiting outranks a platform "mergeable": a merge request whose
 * pipeline failed is not shown as ready even where the project does not
 * require a green pipeline.
 */
const STATUS_RULES = [
    ['conflict', (signals) => signals.conflict],
    ['pipeline_failed', pipelineFailed],
    ['changes_requested', (signals) => signals.changesRequested],
    ['unresolved_discussions', (signals) => signals.unresolvedDiscussions > 0],
    ['pipeline_running', pipelineRunning],
    ['draft', (signals) => signals.draft],
    ['waiting_for_approval', (signals) => signals.approvalRequired],
    ['ready_to_merge', (signals) => signals.platformMergeable],
    ['unknown', (signals) => signals.checking],
];
function pickStatus(signals) {
    return STATUS_RULES.find(([, applies]) => applies(signals))?.[0] ?? 'blocked';
}
/** Display groups: closest to done first, finished last. */
const DISPLAY_GROUP = {
    ready_to_merge: 0,
    pipeline_failed: 1,
    conflict: 1,
    changes_requested: 2,
    unresolved_discussions: 2,
    pipeline_running: 3,
    waiting_for_approval: 4,
    draft: 4,
    blocked: 4,
    unknown: 5,
    merged: 6,
    closed: 7,
};
export function compareForDisplay(a, b) {
    const group = DISPLAY_GROUP[a.status] - DISPLAY_GROUP[b.status];
    if (group !== 0)
        return group;
    const current = Number(b.linkSource === 'current_branch') - Number(a.linkSource === 'current_branch');
    if (current !== 0)
        return current;
    return recency(b) - recency(a);
}
function recency(item) {
    return item.updatedAtMs ?? item.linkedAtMs ?? 0;
}
//# sourceMappingURL=status.js.map