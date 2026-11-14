import { canonicalHistoryRecordEntry, } from '../../service/session-system/index.js';
/** Tests list snapshot records; the frozen view streams them the way the adapter does. */
export function frozen(history) {
    const records = new Map(history.snapshots.map((snapshot) => [
        snapshot.fileName,
        snapshot.records,
    ]));
    return {
        active: history.active,
        historyRevision: history.historyRevision,
        snapshots: history.snapshots.map(({ records: snapshotRecords, ...snapshot }) => ({
            ...snapshot,
            entries: snapshotRecords.map(canonicalHistoryRecordEntry),
        })),
        forEachSnapshotRecord: async (snapshot, visit) => {
            for (const [index, record] of (records.get(snapshot.fileName) ?? []).entries()) {
                await visit(record, index);
            }
        },
    };
}
//# sourceMappingURL=sidechat-frozen-history.test-support.js.map