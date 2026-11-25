import { setTimeout as delay } from 'node:timers/promises';
import { activeHistoryGeneration, assertAppendIdentityBoundary, assertCanonicalRecordChange, assertCompactionCommitted, canonicalHistoryMessage, canonicalRecord, historyArchive, markHistoryArtifact, messageIdFromSeed, placeCompaction, planAppend, planCompaction, planReplacement, safeCompactionId, semanticHistoryRevision, storedHistoryGeneration, withoutHistoryArtifact, } from '@mavis/harness';
import { canonicalActiveHistoryRevision, canonicalHistoryRevision, JsonlAppendCommitUncertainError, } from '../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../sessions/representation/canonical-history.js';
import { repairCanonicalHistory } from './canonical-history-recovery.js';
import { deleteSessionHistory } from './session-history-paths.js';
import { createSessionHistoryLocationResolver, } from './session-history-location.js';
import { ensureCanonicalHistoryMaterialized, } from './canonical-history-materializer.js';
import { canonicalSnapshotCodec, canonicalSnapshotEntry, HistoryScannerError, verifyCompactionParent, } from './mutation/canonical-history-scanner.js';
import { readSegmentId } from './segment/segment-prefix.js';
import { segmentReplacementEnvelopes } from './segment/segment-replacement.js';
import { createSessionHistoryIoLane, } from './mutation/session-history-coordination.js';
import { repairCorruptedCanonicalHistory, } from './mutation/canonical-history-repair.js';
import { resetCanonicalHistory, restoreCanonicalHistoryResetBackup, } from './mutation/canonical-history-reset.js';
const MAX_CANONICAL_WRITE_ATTEMPTS = 3;
const CANONICAL_RETRY_DELAYS_MS = [25, 50];
export { SegmentCheckpointConflictError, } from './segment/segment-checkpoint.js';
export { CanonicalHistoryRepairError, } from './mutation/canonical-history-repair.js';
function historySnapshot(records, useActiveRevision) {
    return {
        revision: useActiveRevision
            ? canonicalActiveHistoryRevision(records)
            : canonicalHistoryRevision(records),
        // The reader's records are deeply frozen and owned by it; share them instead of copying.
        messages: Object.freeze(records.map(({ message }) => message)),
        identityVector: records.map(({ message_id }) => message_id),
        turnIdVector: records.map(({ turn_id }) => turn_id),
    };
}
function isMissingParentScannerError(error) {
    return error instanceof HistoryScannerError && error.code === 'parent-snapshot-missing';
}
async function verifyCompactionParentAllowingMissing(paths, activeRecords) {
    try {
        await verifyCompactionParent({ activeRecords, snapshotsPath: paths.snapshots });
    }
    catch (error) {
        if (!isMissingParentScannerError(error))
            throw error;
    }
}
/**
 * Session-owned canonical Pi history provider. First access materializes the
 * selected readonly v1 source before this provider becomes the sole writer.
 */
export function createSessionSystemCanonicalHistoryProvider(options) {
    const files = options.files ?? createCanonicalHistoryFileAdapter({ reuseDecodedRecords: true });
    const inspectionFiles = options.files ?? createCanonicalHistoryFileAdapter();
    const nowMs = options.nowMs ?? Date.now;
    const retryDelay = options.retryDelay ?? ((delayMs) => delay(delayMs));
    const ioLane = options.ioLane ?? createSessionHistoryIoLane();
    const locations = options.locations ??
        createSessionHistoryLocationResolver({ dataDir: options.dataDir, sessions: options.sessions });
    const verifiedRecovery = new WeakMap();
    return {
        read: (sessionId) => inLane(sessionId, () => readSnapshot(sessionId, false)),
        readActive: (sessionId) => inLane(sessionId, () => readSnapshot(sessionId, true)),
        inspectActive: (sessionId) => inLane(sessionId, () => inspectActiveSnapshot(sessionId)),
        readSegment: (sessionId) => inLane(sessionId, async () => {
            const paths = await ensureInitialized(sessionId);
            const active = await files.readActiveStrict(paths.messages);
            return {
                segmentId: readSegmentId(active),
                generation: activeHistoryGeneration(active),
                // The reader's records are deeply frozen and owned by it; share them instead of copying.
                records: active.map(({ message_id, turn_id, message }) => ({
                    message_id,
                    turn_id,
                    message,
                })),
            };
        }),
        initialize: (sessionId) => inLane(sessionId, async () => {
            await ensureInitialized(sessionId, 'allocate');
        }),
        delete: (sessionId) => inLane(sessionId, async () => {
            const located = await locations.resolveSession(sessionId);
            if (!located)
                return;
            deleteSessionHistory(options.dataDir, located.session, located.paths);
            files.forget?.(located.paths.messages);
            options.activity?.notify(sessionId);
        }),
        append: (change) => inLane(change.sessionId, async () => {
            await persistCanonical(async () => {
                assertCanonicalRecordChange(change, 'messageDelta');
                const paths = await ensureInitialized(change.sessionId);
                const existing = await files.readActiveStrict(paths.messages);
                await appendWithInterruptedToolRoundRecovery({
                    files,
                    path: paths.messages,
                    existing,
                    appended: canonicalEnvelopes(planAppend(existing, change)),
                });
            }, retryDelay);
            const committed = await readSnapshot(change.sessionId, true);
            options.activity?.notify(change.sessionId);
            return committed;
        }),
        replace: (change) => inLane(change.sessionId, async () => {
            await persistCanonical(async () => {
                assertCanonicalRecordChange(change, 'replaceMessages');
                const paths = await ensureInitialized(change.sessionId);
                const existing = await files.readStrict(paths.messages);
                const plan = planReplacement(existing, change, activeHistoryGeneration(existing));
                if (plan.archive)
                    await publishArchive(files, paths, plan.archive);
                await files.replace(paths.messages, canonicalEnvelopes(plan.active));
            }, retryDelay);
            const committed = await readSnapshot(change.sessionId, true);
            options.activity?.notify(change.sessionId);
            return committed;
        }),
        repairCorrupted: (sessionId, repairOptions) => inLane(sessionId, () => repairCorruptedCanonicalHistory({
            files,
            paths: () => ensureInitialized(sessionId),
            read: () => readSnapshot(sessionId, false),
            notify: () => options.activity?.notify(sessionId),
        }, repairOptions)),
        resetActive: (sessionId, input) => inLane(sessionId, () => resetCanonicalHistory(resetDependencies(sessionId), resetEnvelope(input))),
        restoreResetBackup: (sessionId, backupFile) => inLane(sessionId, () => restoreCanonicalHistoryResetBackup(resetDependencies(sessionId), backupFile)),
        compact: (change) => inLane(change.sessionId, async () => {
            const paths = await ensureInitialized(change.sessionId);
            // The snapshot and the replacement rewrite the whole file, so start from a full disk read.
            files.forget?.(paths.messages);
            const active = await files.readActiveStrict(paths.messages);
            await verifyCompactionParentAllowingMissing(paths, active);
            const plan = planCanonicalCompaction(active, change);
            // The record marker names the pre-image itself, so placement reads no other archive.
            const placement = placeCompaction(canonicalSnapshotCodec(paths.snapshots), { entries: [] }, plan);
            for (const archive of placement.archives)
                await publishArchive(files, paths, archive);
            await files.replaceActive(paths.messages, canonicalEnvelopes(plan.active));
            const committed = await files.readActiveStrict(paths.messages);
            const committedGeneration = assertCompactionCommitted(storedHistoryGeneration(committed), placement, change.sessionId);
            const result = {
                revision: canonicalActiveHistoryRevision(committed),
                generation: committedGeneration,
                messages: Object.freeze(committed.map(({ message }) => message)),
                identityVector: committed.map(({ message_id }) => message_id),
            };
            options.activity?.notify(change.sessionId);
            return result;
        }),
    };
    async function readSnapshot(sessionId, allowPendingToolCallTail) {
        const paths = await ensureInitialized(sessionId);
        const decoded = await files.readEnvelopesStrict(paths.messages);
        const records = await recoverReadHistory(files, paths.messages, decoded, {
            allowPendingToolCallTail,
            reusable: options.files === undefined,
            verifiedRecovery,
            notify: () => options.activity?.notify(sessionId),
        });
        return historySnapshot(records, allowPendingToolCallTail);
    }
    async function inspectActiveSnapshot(sessionId) {
        const located = await locations.inspectSession(sessionId);
        if (!located)
            throw new Error(`Session not found: ${sessionId}`);
        const records = (await inspectionFiles.readTargetStrict(located.paths.messages)) ?? [];
        return historySnapshot(records, true);
    }
    async function ensureInitialized(sessionId, locationMode = 'resolve') {
        const session = await options.sessions.get(sessionId);
        if (!session)
            throw new Error(`Session not found: ${sessionId}`);
        const paths = locationMode === 'allocate'
            ? await locations.allocate(session)
            : await locations.ensure(session);
        await ensureCanonicalHistoryMaterialized({
            sessionId,
            paths,
            files,
            ...(options.legacyHistory ? { legacyHistory: options.legacyHistory } : {}),
            nowMs,
        });
        return paths;
    }
    async function inLane(sessionId, operation) {
        return ioLane.run(sessionId, operation);
    }
    function resetDependencies(sessionId) {
        const notify = () => options.activity?.notify(sessionId);
        return { files, paths: () => ensureInitialized(sessionId), notify };
    }
}
/** The handoff header a context reset leaves as the whole active history (context reset spec 4.1). */
function resetEnvelope(input) {
    const resetId = safeCompactionId(input.resetId);
    const header = canonicalHistoryMessage(input.header);
    return {
        resetId,
        header: canonicalEnvelope({
            message_id: messageIdFromSeed(`${resetId}:0:${JSON.stringify(header)}`),
            turn_id: `${input.turnId}:compaction`,
            message: header,
        }),
    };
}
async function persistCanonical(operation, retryDelay, attempt = 1) {
    try {
        await operation();
    }
    catch (error) {
        if (error instanceof JsonlAppendCommitUncertainError ||
            attempt >= MAX_CANONICAL_WRITE_ATTEMPTS) {
            throw error;
        }
        await retryDelay(CANONICAL_RETRY_DELAYS_MS[attempt - 1] ?? 0);
        await persistCanonical(operation, retryDelay, attempt + 1);
    }
}
async function appendWithInterruptedToolRoundRecovery(input) {
    if (!repairedCommittedTail(input.existing, input.appended)) {
        await input.files.append(input.path, input.appended, input.existing);
        return;
    }
    // The repair rewrites the whole file, so decide it again from a full disk read.
    input.files.forget?.(input.path);
    const existing = await input.files.readActiveStrict(input.path);
    assertAppendIdentityBoundary(existing, input.appended);
    const repaired = repairedCommittedTail(existing, input.appended);
    if (repaired)
        await input.files.replaceActive(input.path, repaired);
    else
        await input.files.append(input.path, input.appended, existing);
}
/** The repaired records when the only issue is an interrupted tool round already on disk. */
function repairedCommittedTail(existing, appended) {
    const recovery = repairCanonicalHistory([...existing, ...appended], {
        allowPendingToolCallTail: true,
    });
    const [issue] = recovery.issues;
    const repairsCommittedTail = recovery.issues.length === 1 &&
        issue?.kind === 'interrupted-tool-round' &&
        issue.recordIndex < existing.length;
    return repairsCommittedTail ? recovery.records : undefined;
}
async function publishArchive(files, paths, archive) {
    const { path } = canonicalSnapshotEntry(paths.snapshots, archive);
    await files.publishSnapshot(path, canonicalEnvelopes(archive.records));
}
/**
 * A summary checkpoint is planned by the shared rules. A segment checkpoint keeps its
 * planned source records verbatim and is stored as a summary checkpoint: on disk it is a
 * summary at index 0, and readers find segments by that record, never by the producer.
 * Writing the summary producer keeps the file readable by releases that predate segments.
 */
function planCanonicalCompaction(active, change) {
    const generation = activeHistoryGeneration(active);
    if (change.method !== 'llm_segment_checkpoint')
        return planCompaction(active, change, generation);
    const compactionId = safeCompactionId(change.compactionId);
    const revision = semanticHistoryRevision(active);
    const replacement = segmentReplacementEnvelopes(change, active, {
        create: (message, index) => canonicalEnvelope(canonicalRecord({ change, message, turnId: `${change.turnId}:compaction`, index })),
        keep: (source) => canonicalEnvelope(withoutHistoryArtifact(source)),
        roleOf: (message) => canonicalHistoryMessage(message).role,
    });
    const marker = {
        schemaVersion: 1,
        generation: generation + 1,
        producedBy: 'llm_checkpoint',
        parentSnapshot: { generation, compactionId, revision },
    };
    const next = markHistoryArtifact(replacement, marker);
    return {
        archive: historyArchive({
            generation,
            compactionId,
            records: active,
            successor: next,
            revision,
        }),
        active: next,
    };
}
/** The shared rules validate every message they emit, so their records are canonical envelopes. */
function canonicalEnvelopes(records) {
    return records;
}
function canonicalEnvelope(record) {
    return record;
}
/** The repair rewrites the whole file, so it is computed again from a full disk read. */
async function replaceRecoveredHistory(files, path, allowPendingToolCallTail) {
    files.forget?.(path);
    const { records } = repairCanonicalHistory(await files.readEnvelopesStrict(path), {
        allowPendingToolCallTail,
    });
    if (allowPendingToolCallTail) {
        await files.replaceActive(path, records);
        return files.readActiveStrict(path);
    }
    await files.replace(path, records);
    return files.readStrict(path);
}
async function recoverReadHistory(files, path, decoded, options) {
    const { allowPendingToolCallTail, reusable, verifiedRecovery } = options;
    const recoveryMode = allowPendingToolCallTail ? 2 : 1;
    const verifiedModes = reusable ? (verifiedRecovery.get(decoded) ?? 0) : 0;
    let records = decoded;
    if ((verifiedModes & recoveryMode) === 0) {
        const recovery = repairCanonicalHistory(decoded, { allowPendingToolCallTail });
        if (recovery.issues.length > 0) {
            records = await replaceRecoveredHistory(files, path, allowPendingToolCallTail);
            options.notify();
        }
        else if (reusable) {
            // Only the private reader produces immutable arrays. The two recovery
            // modes remain independent, so a pending tail is never treated as settled.
            verifiedRecovery.set(decoded, verifiedModes | recoveryMode);
        }
        else {
            records = recovery.records;
        }
    }
    return records;
}
//# sourceMappingURL=canonical-history-provider.js.map