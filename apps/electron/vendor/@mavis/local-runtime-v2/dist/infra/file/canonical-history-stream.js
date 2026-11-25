import { decodeCanonicalHistoryEnvelope, newSequenceState, sequenceError, sequenceInspection, validateSequenceRecord, } from './canonical-history-jsonl.js';
import { createRevisionHasher } from './canonical-history-revision.js';
import { forEachJsonlRecord, publishFileCopyIfAbsent } from './jsonl.js';
/**
 * Reads a canonical history file one record at a time. Decoding, sequence checks and the
 * revision match readStrict (`settled`) or readActiveStrict (`pending-allowed`) followed by
 * canonicalHistoryRevision, but only the record being visited is held unless `visit` keeps it.
 */
export async function streamCanonicalHistoryFile(filePath, options) {
    const state = newSequenceState();
    const hasher = createRevisionHasher();
    const messageCount = await forEachJsonlRecord(filePath, decodeCanonicalHistoryEnvelope, async (envelope, index) => {
        validateSequenceRecord(envelope, index, state);
        hasher.add(envelope);
        await options.visit?.(envelope, index);
    });
    const inspection = sequenceInspection(state, messageCount);
    if (options.sequence === 'settled' && inspection.status !== 'settled') {
        sequenceError(messageCount, `history ends before tool results: ${inspection.pendingToolCallIds.join(',')}`);
    }
    return { revision: hasher.digest(), messageCount, inspection };
}
/**
 * Streams a snapshot file, visiting each record, and fails with code
 * `artifact-revision-mismatch` unless the file still has the expected revision.
 */
export async function verifyCanonicalHistorySnapshotFile(filePath, expectedRevision, visit) {
    const streamed = await streamCanonicalHistoryFile(filePath, {
        sequence: 'settled',
        ...(visit ? { visit } : {}),
    });
    if (streamed.revision !== expectedRevision) {
        throw Object.assign(new Error(`Canonical snapshot revision changed: ${filePath}`), {
            code: 'artifact-revision-mismatch',
        });
    }
    return streamed;
}
/**
 * Publishes a byte copy of a verified snapshot file. An existing target must already hold the
 * same revision; a copy is verified by streaming before it becomes visible.
 */
export async function copyCanonicalHistorySnapshotFile(sourcePath, targetPath, expectedRevision) {
    const status = await publishFileCopyIfAbsent(sourcePath, targetPath, async (temporaryPath) => {
        await verifyCanonicalHistorySnapshotFile(temporaryPath, expectedRevision);
    });
    if (status === 'already-exists') {
        await assertExistingSnapshotRevision(targetPath, expectedRevision);
    }
    return status;
}
async function assertExistingSnapshotRevision(targetPath, expectedRevision) {
    try {
        await verifyCanonicalHistorySnapshotFile(targetPath, expectedRevision);
    }
    catch (error) {
        throw new Error(`Canonical history snapshot conflict: ${targetPath}`, { cause: error });
    }
}
//# sourceMappingURL=canonical-history-stream.js.map