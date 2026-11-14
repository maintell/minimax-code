import { inspectCanonicalHistorySequence, } from '../sessions/representation/canonical-history-contract.js';
/**
 * Select and revalidate one complete, inclusive history prefix without waiting for live tools.
 * Snapshot records are loaded only for the generation that holds the boundary.
 */
export async function resolveSideHistoryBoundary(history, throughMessageId, readSnapshotRecords) {
    const artifacts = [
        { records: history.active },
        ...[...history.snapshots]
            .sort((left, right) => right.generation - left.generation)
            .map((snapshot) => ({ snapshot })),
    ];
    for (const artifact of artifacts) {
        if (throughMessageId !== undefined &&
            'snapshot' in artifact &&
            !artifact.snapshot.entries.some((entry) => entry.messageId === throughMessageId)) {
            continue;
        }
        const records = 'snapshot' in artifact ? await readSnapshotRecords(artifact.snapshot) : artifact.records;
        const boundary = throughMessageId === undefined
            ? latestSettledBoundary(records)
            : pinnedBoundary(records, throughMessageId);
        if (boundary !== 'absent')
            return boundary;
    }
    return undefined;
}
/** A pinned boundary is kept only when its own inclusive prefix is settled. */
function pinnedBoundary(records, throughMessageId) {
    const index = records.findIndex((row) => row.message_id === throughMessageId);
    if (index < 0)
        return 'absent';
    return inspectCanonicalHistorySequence(records.slice(0, index + 1)).status === 'settled'
        ? throughMessageId
        : undefined;
}
function latestSettledBoundary(records) {
    const inspection = inspectCanonicalHistorySequence(records);
    const length = inspection.status === 'settled' ? records.length : inspection.settledPrefixLength;
    return records[length - 1]?.message_id ?? 'absent';
}
//# sourceMappingURL=side-history-boundary.js.map