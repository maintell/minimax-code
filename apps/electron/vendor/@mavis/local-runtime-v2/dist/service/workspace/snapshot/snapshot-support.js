export class StaleWorkspaceGitSnapshotError extends Error {
    constructor() {
        super('Workspace Git snapshot changed while the request was running');
    }
}
export class WorkspaceGitSnapshotManagerClosedError extends Error {
    constructor() {
        super('Workspace Git snapshot manager is closed');
    }
}
export class WorkspaceGitSnapshotReleasedError extends Error {
    constructor() {
        super('Workspace Git snapshot was released');
    }
}
export function createDeferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
function mergeChangedEvent(current, next) {
    if (!current)
        return next;
    const kind = current.kind === 'repository' || next.kind === 'repository' ? 'repository' : 'workspace';
    const reasonPriority = {
        watcher: 0,
        manual: 1,
        mutation: 2,
        'watcher-error': 3,
    };
    const reason = reasonPriority[next.reason] > reasonPriority[current.reason] ? next.reason : current.reason;
    return { kind, reason };
}
export function publishWorkspaceGitChanged(options) {
    const { entry, kind, reason, onChanged, notificationWindowMs, isCurrent } = options;
    if (!onChanged || !isCurrent())
        return;
    const emit = (nextKind, nextReason) => onChanged({
        workspace: entry.workspace,
        ...(entry.aliases.size > 0 ? { aliases: [...entry.aliases] } : {}),
        snapshotId: entry.snapshotId,
        kind: nextKind,
        reason: nextReason,
    });
    if (notificationWindowMs === 0) {
        emit(kind, reason);
        return;
    }
    entry.pendingChanged = mergeChangedEvent(entry.pendingChanged, { kind, reason });
    entry.changedTimer ??= setTimeout(() => {
        entry.changedTimer = undefined;
        const pending = entry.pendingChanged;
        entry.pendingChanged = undefined;
        if (pending && isCurrent())
            emit(pending.kind, pending.reason);
    }, notificationWindowMs);
}
//# sourceMappingURL=snapshot-support.js.map