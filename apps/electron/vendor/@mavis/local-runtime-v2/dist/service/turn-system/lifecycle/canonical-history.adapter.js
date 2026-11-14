import { SegmentCheckpointConflictError, } from '../../session-system/index.js';
import { readCompactionCommitMetadata } from '../agent-host/compaction/compaction-commit-metadata.js';
import { validateCanonicalHistoryMessages } from '../agent-host/history/canonical-history-validation.js';
import { SegmentPlanRefusedError } from '../agent-host/history/committed-history-writer.js';
/**
 * Serves the Session System's canonical history to the AgentHost as its durable
 * history provider: every read and commit is validated, and typed compactions,
 * Turn-tail settlement and retraction map onto Session System operations.
 */
export function adaptCanonicalHistory(provider, mutation) {
    return {
        read: async (sessionId) => {
            const snapshot = await provider.read(sessionId);
            validateCanonicalHistoryMessages(snapshot.messages);
            return {
                revision: snapshot.revision,
                messages: snapshot.messages,
                identityVector: snapshot.identityVector,
            };
        },
        readActive: async (sessionId) => {
            const snapshot = await provider.readActive(sessionId);
            validateCanonicalHistoryMessages(snapshot.messages);
            return {
                revision: snapshot.revision,
                messages: snapshot.messages,
                identityVector: snapshot.identityVector,
            };
        },
        append: async (change) => {
            const committed = await provider.append(requireHistoryOperation(change));
            validateCanonicalHistoryMessages(committed.messages);
            return { ...committed, messages: committed.messages };
        },
        replace: async (change) => {
            const committed = await provider.replace(requireHistoryOperation(change));
            validateCanonicalHistoryMessages(committed.messages);
            return { ...committed, messages: committed.messages };
        },
        compact: async (change) => {
            const operation = requireHistoryOperation(change);
            if (operation.reason !== 'replaceMessages' || operation.operation.kind !== 'compaction') {
                throw new TypeError('Typed canonical compaction requires a compaction operation.');
            }
            const metadata = readCompactionCommitMetadata(operation.metadata);
            if (!metadata)
                throw new TypeError('Canonical compaction metadata is invalid.');
            const baseChange = {
                ...operation,
                reason: 'replaceMessages',
                operation: { id: operation.operation.id, kind: 'compaction' },
                compactionId: metadata.compactionId,
                summary: metadata.summary,
                ...(metadata.currentUserSourceIndex === undefined
                    ? {}
                    : {
                        currentUserSourceIndex: metadata.currentUserSourceIndex,
                        ...(metadata.placedMarkerCount === undefined
                            ? {}
                            : { placedMarkerCount: metadata.placedMarkerCount }),
                    }),
            };
            if (metadata.method === 'llm_segment_checkpoint') {
                const committed = await compactSegment(provider, {
                    ...baseChange,
                    method: metadata.method,
                    segmentSourceIndexes: metadata.segment.sourceIndexes,
                    segmentCoveredCount: metadata.segment.coveredCount,
                    segmentPrefixDigest: metadata.segment.prefixDigest,
                    segmentExpectedId: metadata.segment.expectedSegmentId,
                });
                validateCanonicalHistoryMessages(committed.messages);
                return { ...committed, messages: committed.messages };
            }
            const committed = await provider.compact({
                ...baseChange,
                method: metadata.method,
            });
            validateCanonicalHistoryMessages(committed.messages);
            return { ...committed, messages: committed.messages };
        },
        settleTurnTail: async (input) => {
            if (!mutation.settleTurnTail) {
                throw new TypeError('SessionSystem settleTurnTail capability is unavailable.');
            }
            const committed = await mutation.settleTurnTail({
                sessionId: input.sessionId,
                turnId: input.turnId,
                operationId: input.operation.id,
                mode: input.mode,
                approvedContent: input.approvedContent,
            });
            validateCanonicalHistoryMessages(committed.messages);
            return {
                revision: committed.revision,
                messages: committed.messages,
                identityVector: committed.identityVector,
                status: committed.status,
                deletedMessageIds: committed.deletedMessageIds,
            };
        },
        retractTurn: async (input) => {
            if (!mutation.retractTurn) {
                throw new TypeError('SessionSystem retractTurn capability is unavailable.');
            }
            const committed = await mutation.retractTurn({
                sessionId: input.sessionId,
                turnId: input.turnId,
                operationId: input.operation.id,
                reason: input.reason,
            });
            validateCanonicalHistoryMessages(committed.messages);
            return {
                revision: committed.revision,
                messages: committed.messages,
                identityVector: committed.identityVector,
                status: committed.status,
                deletedMessageIds: committed.deletedMessageIds,
            };
        },
    };
}
function requireHistoryOperation(change) {
    if (!change.operation)
        throw new TypeError('Canonical history operation is required.');
    return { ...change, operation: change.operation };
}
/** A plan the history refused before writing (its segment or prefix changed) says so. */
async function compactSegment(provider, change) {
    try {
        return await provider.compact(change);
    }
    catch (error) {
        throw error instanceof SegmentCheckpointConflictError
            ? new SegmentPlanRefusedError(error)
            : error;
    }
}
//# sourceMappingURL=canonical-history.adapter.js.map