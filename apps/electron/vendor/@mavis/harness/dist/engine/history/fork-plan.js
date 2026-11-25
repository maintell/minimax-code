import { boundaryNotFound } from './history-mutation-error.js';
import { assistantToolCallIds, createContinuationRecord, createHiddenContextBoundaryRecord, findHistoryArtifact, historyRecords, snapshotsBefore, toolResultCallId, unique, withoutSourceBackgroundReminders, withoutUnpairedToolCalls, } from './history-records.js';
/** Inclusive boundaries win over the legacy exclusive user boundary. */
export function forkBoundary(input) {
    return input.throughMessageId ?? input.throughAssistantMessageId ?? input.beforeUserMessageId;
}
/**
 * Single source of the Fork prefix rule shared by `fork()` and its preflight. The prefix drops
 * unpaired tool calls, so it is always settled.
 */
export function selectForkPrefix(input, source) {
    const boundary = forkBoundary(input);
    const artifact = findHistoryArtifact(source, boundary, Boolean(input.throughMessageId));
    if (!artifact)
        boundaryNotFound(boundary);
    const index = boundary
        ? artifact.records.findIndex((record) => record.message_id === boundary)
        : artifact.records.length;
    if (index < 0)
        boundaryNotFound(boundary);
    const prefix = withoutUnpairedToolCalls(withoutSourceBackgroundReminders(artifact.records.slice(0, forkPrefixEnd(artifact.records, index, input))));
    return { source, artifact, boundary, prefix };
}
function forkPrefixEnd(records, index, input) {
    if (input.throughMessageId)
        return index + 1;
    if (input.throughAssistantMessageId)
        return assistantBoundaryEnd(records, index);
    return index;
}
/**
 * An Assistant boundary owns the results of its own tool calls. Pi commits each result as a
 * separate record right after the call, so cutting between them would leave an unsettled prefix
 * (e.g. Fork from a `task_output` or ask_user card). Only contiguous results for this Assistant's
 * calls are included; any other record ends the boundary.
 */
function assistantBoundaryEnd(records, index) {
    const pendingCallIds = new Set(assistantToolCallIds(records[index]?.message));
    let end = index + 1;
    while (pendingCallIds.size > 0) {
        const callId = toolResultCallId(records[end]?.message);
        if (!callId || !pendingCallIds.delete(callId))
            break;
        end += 1;
    }
    return end;
}
export function planFork(input, selected) {
    // Filter only the selected active prefix, including forks into an archive.
    const snapshots = snapshotsBefore(selected.source, selected.artifact.generation);
    return {
        generation: selected.artifact.generation,
        active: [
            ...selected.prefix,
            ...(input.continuation
                ? [createContinuationRecord(input.operationId, input.continuation)]
                : []),
            ...(input.hiddenContextBoundary
                ? [createHiddenContextBoundaryRecord(input.operationId, input.hiddenContextBoundary)]
                : []),
        ],
        snapshots,
        retainedTurnIds: unique(historyRecords(snapshots, selected.prefix).map((record) => record.turn_id)),
    };
}
//# sourceMappingURL=fork-plan.js.map