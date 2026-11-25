import { semanticHistoryRevision, } from './canonical-record.js';
import { planCompactionRecords } from './compaction-records.js';
import { markHistoryArtifact, replacementArchiveId, safeCompactionId, } from './generation-marker.js';
import { HistoryLineageError, pointerNames, } from './history-lineage.js';
import { assertAppendIdentityBoundary, planAppendRecords, planReplacementRecords, } from './record-identity.js';
/** Message id of a compaction summary on the first record, if any. */
export function leadingSummaryId(records) {
    const first = records[0];
    return first?.message.role === 'compactionSummary' ? first.message_id : undefined;
}
export function historyArchive(input) {
    const summaryId = leadingSummaryId(input.records);
    const successorSummaryId = input.successor ? leadingSummaryId(input.successor) : undefined;
    return {
        generation: input.generation,
        compactionId: input.compactionId,
        records: input.records,
        revision: input.revision ?? semanticHistoryRevision(input.records),
        ...(summaryId === undefined ? {} : { summaryId }),
        ...(successorSummaryId === undefined ? {} : { successorSummaryId }),
    };
}
/** Links each archive of a chain, oldest first, to the history that replaced it. */
export function linkHistoryArchives(chain, active) {
    return chain.map((archive, index) => historyArchive({ ...archive, successor: chain[index + 1]?.records ?? active }));
}
/** Records to append after `existing`; identities must be new to the history. */
export function planAppend(existing, change) {
    const appended = planAppendRecords(change);
    assertAppendIdentityBoundary(existing, appended);
    return appended;
}
/**
 * Archives the active history of `generation` under the compaction id and marks
 * the replacement with generation+1 whose parent names that archive and revision.
 * A codec that does not read the marker may drop it when storing.
 */
export function planCompaction(active, change, generation) {
    const compactionId = safeCompactionId(change.compactionId);
    const preRevision = semanticHistoryRevision(active);
    const replacement = planCompactionRecords(change, active);
    const marker = {
        schemaVersion: 1,
        generation: generation + 1,
        producedBy: change.method,
        parentSnapshot: { generation, compactionId, revision: preRevision },
    };
    const next = markHistoryArtifact(replacement, marker);
    return {
        archive: historyArchive({
            generation,
            compactionId,
            records: active,
            successor: next,
            revision: preRevision,
        }),
        active: next,
        generation: generation + 1,
        producedBy: change.method,
    };
}
/**
 * Every compaction advances the generation and archives its pre-image. Once the
 * pre-image is listed, the codec must decode it as the parent of the
 * replacement; no parent or any other parent fails as `parent-mismatch`.
 */
export function placeCompaction(codec, current, plan) {
    // The pre-image is listed first, so a retry finds it ahead of its earlier write.
    const candidate = codec.archiveEntry(plan.archive);
    const listing = [candidate, ...current.entries];
    const pointer = codec.parentOf(plan.active, codec.storedGeneration?.(plan.active), listing);
    if (!pointer || !pointerNames(pointer, candidate)) {
        throw new HistoryLineageError('parent-mismatch');
    }
    if (pointer.revision !== undefined && pointer.revision !== plan.archive.revision) {
        throw new HistoryLineageError('artifact-revision-mismatch');
    }
    return { generation: plan.archive.generation + 1, archives: [plan.archive] };
}
/** The committed active history must sit where the codec placed the replacement. */
export function assertCompactionCommitted(committedGeneration, placement, sessionId) {
    if (committedGeneration !== placement.generation) {
        throw new Error(`Canonical compaction generation verification failed: ${sessionId}`);
    }
    return committedGeneration;
}
/**
 * A replacement keeps the generation and its marker. With `metadata.replacementId`
 * the replaced history of `generation` is archived under that id first.
 */
export function planReplacement(existing, change, generation) {
    const archiveId = replacementArchiveId(change.metadata);
    const active = planReplacementRecords(change, existing);
    if (!archiveId)
        return { active };
    return {
        archive: historyArchive({
            generation,
            compactionId: safeCompactionId(archiveId),
            records: existing,
        }),
        active,
    };
}
//# sourceMappingURL=archive-plan.js.map