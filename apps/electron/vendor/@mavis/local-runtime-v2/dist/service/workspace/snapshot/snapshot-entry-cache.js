export function currentWorkspaceSnapshotId(entries, workspace) {
    return entries.get(workspace)?.snapshotId;
}
export function isCurrentWorkspaceSnapshot(entries, workspace, snapshotId) {
    const entry = entries.get(workspace);
    return Boolean(entry &&
        !entry.disposed &&
        !entry.mutating &&
        !entry.pendingValidation &&
        entry.snapshotId === snapshotId);
}
export function releaseWorkspaceEntry(entries, workspace) {
    const entry = entries.get(workspace);
    if (!entry)
        return false;
    entries.delete(workspace);
    disposeWorkspaceEntry(entry);
    return true;
}
export function clearWorkspaceEntries(entries) {
    for (const entry of entries.values())
        disposeWorkspaceEntry(entry);
    entries.clear();
}
export function evictOldestIdleWorkspaceEntry(entries) {
    let oldest;
    for (const entry of entries.values()) {
        if (!isIdleWorkspaceEntry(entry))
            continue;
        if (!oldest || entry.lastUsed < oldest.lastUsed)
            oldest = entry;
    }
    if (!oldest)
        return false;
    entries.delete(oldest.workspace);
    disposeWorkspaceEntry(oldest);
    return true;
}
export function trimIdleWorkspaceEntries(entries, maxWorkspaces) {
    // Busy entries may temporarily exceed the completed-snapshot budget. Do
    // not evict a newer idle entry merely because the true LRU is still busy;
    // once that work settles, normal LRU order can be restored.
    while (countIdleWorkspaceEntries(entries) > maxWorkspaces) {
        if (!evictOldestIdleWorkspaceEntry(entries))
            return;
    }
}
function disposeWorkspaceEntry(entry) {
    if (entry.disposed)
        return;
    entry.disposed = true;
    const pendingValidation = entry.pendingValidation;
    entry.pendingValidation = undefined;
    pendingValidation?.resolve();
    entry.watcher?.close();
    entry.watcher = undefined;
    entry.watcherSetupPending = false;
    if (entry.changedTimer)
        clearTimeout(entry.changedTimer);
    entry.changedTimer = undefined;
    entry.pendingChanged = undefined;
    entry.base = undefined;
    entry.full = undefined;
    entry.metadata = undefined;
    entry.baseRequest = undefined;
    entry.fullRequest = undefined;
    entry.metadataRequest = undefined;
}
function countIdleWorkspaceEntries(entries) {
    let count = 0;
    for (const entry of entries.values()) {
        if (isIdleWorkspaceEntry(entry))
            count += 1;
    }
    return count;
}
function isIdleWorkspaceEntry(entry) {
    return !(entry.mutating ||
        entry.mutationReservations > 0 ||
        entry.activeReaders > 0 ||
        entry.pendingValidation ||
        entry.pendingChanged ||
        entry.changedTimer ||
        entry.baseRequest ||
        entry.fullRequest ||
        entry.metadataRequest);
}
//# sourceMappingURL=snapshot-entry-cache.js.map