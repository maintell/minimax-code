import { createHash } from 'node:crypto';
import path from 'node:path';
import { mutateLocalTurnDiff, readLocalSessionDiff, readLocalTurnDiff, } from './diff-api.js';
import { applyLocalTurnDiffSnapshotMutation } from './file-changes.js';
/**
 * Narrow compatibility capability for the v2-owned public Diff entrypoints.
 * It exposes only the retained v1 Diff implementation and never routes a
 * request through the legacy HTTP host.
 */
export class LocalTurnDiffCapability {
    store;
    nowMs;
    constructor(store, nowMs = () => Date.now()) {
        this.store = store;
        this.nowMs = nowMs;
    }
    getSessionDiff(session, messageId) {
        return readLocalSessionDiff({
            diffStore: this.store,
            session,
            ...(messageId ? { messageId } : {}),
        });
    }
    getTurnDiff(sessionId, selector) {
        return readLocalTurnDiff({
            diffStore: this.store,
            sessionId,
            ...(selector ? { selector } : {}),
        });
    }
    mutateTurnDiff(sessionId, action, selector) {
        return mutateLocalTurnDiff({
            diffStore: this.store,
            sessionId,
            action,
            nowMs: this.nowMs,
            ...(selector ? { selector } : {}),
        });
    }
    async forkPrefix(input) {
        const retained = new Set(input.retainedTurnIds);
        const records = await this.store.listBySession(input.sourceSessionId);
        await rewindDroppedTurnDiffs(input, records, retained);
        await Promise.all(records.flatMap((record) => {
            if (!retained.has(record.turnId))
                return [];
            const copied = copyForkRecord(record, input.excludedFilePaths ?? []);
            if (!copied)
                return [];
            return [
                this.store.upsert({
                    ...copied,
                    changeSetId: forkChangeSetId(input.operationId, record.changeSetId),
                    sessionId: input.targetSessionId,
                    workspaceDir: input.targetWorkspaceDir,
                }),
            ];
        }));
    }
}
async function rewindDroppedTurnDiffs(input, records, retained) {
    if (!input.rewindTargetWorkspace)
        return;
    const candidates = records
        .filter((record) => !retained.has(record.turnId) && record.status === 'active')
        .sort((left, right) => right.capturedAtMs - left.capturedAtMs || right.changeSetId.localeCompare(left.changeSetId));
    for (let index = 0; index < candidates.length; index += 1) {
        const record = candidates[index];
        if (!record ||
            samePath(path.resolve(record.workspaceDir), path.resolve(input.targetWorkspaceDir))) {
            continue;
        }
        const copied = copyForkRecord(record, input.excludedFilePaths ?? []);
        if (!copied)
            continue;
        await rewindRecordFiles(copied, input.targetWorkspaceDir);
    }
}
async function rewindRecordFiles(record, targetWorkspaceDir) {
    const entries = record.undo ?? [];
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry)
            continue;
        try {
            await applyLocalTurnDiffSnapshotMutation({ ...record, workspaceDir: targetWorkspaceDir, undo: [entry], undoable: true }, 'revert');
        }
        catch {
            // A running source can change while Fork copies it; each file is best-effort.
        }
    }
}
function copyForkRecord(record, excludedFilePaths) {
    const excluded = (file) => excludedFilePaths.some((candidate) => samePath(file, candidate));
    const fileChanges = record.fileChanges.filter((change) => !excluded(change.file));
    if (fileChanges.length === 0)
        return undefined;
    const removedFile = fileChanges.length !== record.fileChanges.length;
    const undo = record.undo?.filter((entry) => !excluded(entry.file));
    return {
        ...(removedFile ? withoutRawDiff(record) : record),
        fileChanges,
        ...(undo ? { undo } : {}),
        ...(removedFile ? { undoable: Boolean(undo?.length) } : {}),
    };
}
function withoutRawDiff(record) {
    const copy = { ...record };
    delete copy.rawDiff;
    return copy;
}
function samePath(left, right) {
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
function forkChangeSetId(operationId, sourceChangeSetId) {
    const identity = createHash('sha256')
        .update(operationId)
        .update('\0')
        .update(sourceChangeSetId)
        .digest('hex');
    return `fork-${identity}`;
}
//# sourceMappingURL=diff-capability.js.map