import { readCompactionCommitMetadata } from '../../../agent-host/compaction/compaction-commit-metadata.js';
import { validateCanonicalHistoryMessages } from '../../../agent-host/history/canonical-history-validation.js';
import { HistoryMutationError } from '../history-mutation-error.js';
import { assertCompactionCommitted, placeCompaction, planAppend, planCompaction, planReplacement, } from './archive-plan.js';
import { withoutHistoryArtifact } from './canonical-record.js';
import { replacementArchiveId } from './generation-marker.js';
import { HistoryLineageError } from './history-lineage.js';
import { assertCanonicalRecordChange } from './record-identity.js';
import { createSinkHistoryMutations, readSinkHistory, sameRecords, stageRewind, verifySinkLineage, } from './sink-mutations.js';
import { planRetractTurn, planSettleTurnTail, validateRetractTurnInput, } from './turn-tail-mutation.js';
/**
 * Every write reads the active history, plans with the shared rules and
 * publishes one sink operation under the read revision. Only compaction,
 * identified replacements and Turn retraction read the chain.
 */
export function createSinkCanonicalHistory(options) {
    const { sink, rules = {} } = options;
    const read = async (sessionId) => historySnapshot(await sink.readActive(sessionId));
    return {
        provider: {
            read,
            readActive: read,
            append: (change) => appendChange(sink, change),
            replace: (change) => replaceChange(sink, change),
            compact: (change) => compactChange(sink, change),
            settleTurnTail: (mutation) => settleTurnTail(sink, mutation, rules),
            retractTurn: (mutation) => retractTurn(sink, mutation, rules),
        },
        mutations: createSinkHistoryMutations(sink),
    };
}
async function appendChange(sink, change) {
    const recordChange = withOperation(change);
    assertCanonicalRecordChange(recordChange, 'messageDelta');
    const head = await sink.readActive(change.sessionId);
    const records = planAppend(head.records, recordChange);
    await sink.append(change.sessionId, { expectedRevision: head.revision, records });
    return historySnapshot(await sink.readActive(change.sessionId));
}
async function replaceChange(sink, change) {
    const recordChange = withOperation(change);
    assertCanonicalRecordChange(recordChange, 'replaceMessages');
    const head = await sink.readActive(change.sessionId);
    // The generation names the archive, so only an identified replacement reads the chain.
    const generation = replacementArchiveId(recordChange.metadata) === undefined
        ? 0
        : await currentGeneration(sink, change.sessionId, head.records);
    const plan = planReplacement(head.records, recordChange, generation);
    await sink.commit(change.sessionId, {
        expectedRevision: head.revision,
        active: plan.active,
        archives: [],
        ...(plan.archive ? { detached: plan.archive } : {}),
    });
    return historySnapshot(await sink.readActive(change.sessionId));
}
async function compactChange(sink, change) {
    // Only the placement leaves the commit, so the pre-image is not held while the chain is read again.
    const placement = await commitPlannedCompaction(sink, change);
    const committed = await sink.readActive(change.sessionId);
    assertCompactionCommitted((await currentLineage(sink, change.sessionId, committed.records)).generation, placement, change.sessionId);
    return historySnapshot(committed);
}
/** Plans the compaction on the current head and commits it; returns where the replacement sits. */
async function commitPlannedCompaction(sink, change) {
    const compaction = compactionChange(change);
    const head = await sink.readActive(change.sessionId);
    const current = await currentLineage(sink, change.sessionId, head.records);
    const plan = planCompaction(head.records, compaction, current.generation);
    const placement = placeCompaction(sink.codec, current, plan);
    await commitCompaction(sink, change.sessionId, {
        expectedRevision: head.revision,
        active: plan.active,
        archives: placement.archives,
    });
    return { generation: placement.generation };
}
/**
 * Rewriting the pre-image under its key is a no-op, but the active switch of a
 * compaction planned on a revision that has since moved fails its revision
 * check. A conflict whose head already holds this replacement is the same
 * compaction taking effect first; any other conflict surfaces so the caller
 * rereads and plans again.
 */
async function commitCompaction(sink, sessionId, commit) {
    try {
        await sink.commit(sessionId, commit);
    }
    catch (error) {
        if (!(error instanceof HistoryMutationError) || error.code !== 'revision-conflict')
            throw error;
        const head = await sink.readActive(sessionId);
        if (!sameRecords(head.records.map(withoutHistoryArtifact), commit.active.map(withoutHistoryArtifact))) {
            throw error;
        }
    }
}
/**
 * Generation and stored archives of the active history, verified without
 * keeping archive records. A missing parent falls back to the generation the
 * codec stores, so a compaction can still advance past it.
 */
async function currentLineage(sink, sessionId, active) {
    try {
        const lineage = await verifySinkLineage(sink, sessionId, active);
        return {
            generation: lineage.activeGeneration,
            entries: [...lineage.chain.map(({ entry }) => entry), ...lineage.orphans],
        };
    }
    catch (error) {
        const stored = sink.codec.storedGeneration;
        if (stored &&
            error instanceof HistoryLineageError &&
            error.code === 'parent-snapshot-missing') {
            return { generation: stored(active), entries: await sink.listArchives(sessionId) };
        }
        throw error;
    }
}
/** Chain length of the active history, with the same missing-parent fallback. */
async function currentGeneration(sink, sessionId, active) {
    return (await currentLineage(sink, sessionId, active)).generation;
}
async function settleTurnTail(sink, mutation, rules) {
    const head = await sink.readActive(mutation.sessionId);
    const plan = planSettleTurnTail(head.records, {
        sessionId: mutation.sessionId,
        turnId: mutation.turnId,
        operationId: mutation.operation.id,
        mode: mutation.mode,
        approvedContent: mutation.approvedContent,
    }, rules);
    if (plan.status === 'unchanged')
        return turnCommit('unchanged', head, []);
    await sink.commit(mutation.sessionId, {
        expectedRevision: head.revision,
        active: plan.active,
        archives: [],
    });
    return turnCommit('committed', await sink.readActive(mutation.sessionId), plan.deletedMessageIds);
}
/** A retraction is a staged Rewind; its stage is the receipt a retry resumes from. */
async function retractTurn(sink, mutation, rules) {
    const input = {
        sessionId: mutation.sessionId,
        turnId: mutation.turnId,
        operationId: mutation.operation.id,
        reason: mutation.reason,
    };
    validateRetractTurnInput(input);
    const resumed = await createSinkHistoryMutations(sink).resumeRewind(input);
    if (resumed)
        return resumeRetraction(sink, resumed, input);
    const history = await readSinkHistory(sink, input.sessionId);
    const plan = planRetractTurn(history, input, rules);
    if (plan.status === 'already-retracted') {
        return turnCommit('already-retracted', { revision: history.revision, records: plan.active }, plan.deletedMessageIds);
    }
    const staged = await stageRewind(sink, {
        sessionId: input.sessionId,
        operationId: input.operationId,
        expectedRevision: history.revision,
        sourceGeneration: history.activeGeneration,
        generation: plan.generation,
        active: plan.active,
        snapshots: plan.snapshots,
        operationData: {
            semanticMutation: 'retract-turn',
            turnId: input.turnId,
            reason: input.reason,
            deletedMessageIds: plan.deletedMessageIds,
        },
    });
    await staged.publish();
    return turnCommit('committed', await sink.readActive(input.sessionId), plan.deletedMessageIds);
}
async function resumeRetraction(sink, staged, input) {
    const deletedMessageIds = decodeTurnRetractionReceipt(staged.operationData, input);
    const current = await sink.readActive(input.sessionId);
    const status = sameRecords(current.records, staged.active) ? 'already-retracted' : 'committed';
    await staged.publish();
    return turnCommit(status, await sink.readActive(input.sessionId), deletedMessageIds);
}
function decodeTurnRetractionReceipt(data, input) {
    const reason = isRecord(data) ? data['reason'] : undefined;
    const deletedMessageIds = isRecord(data) ? data['deletedMessageIds'] : undefined;
    if (!isRecord(data) ||
        data['semanticMutation'] !== 'retract-turn' ||
        data['turnId'] !== input.turnId ||
        JSON.stringify(reason) !== JSON.stringify(input.reason) ||
        !Array.isArray(deletedMessageIds) ||
        deletedMessageIds.some((messageId) => typeof messageId !== 'string' || !messageId.trim())) {
        throw new Error('Turn history mutation staging receipt does not match the request');
    }
    return deletedMessageIds.flatMap((messageId) => typeof messageId === 'string' ? [messageId] : []);
}
function compactionChange(change) {
    if (change.reason !== 'replaceMessages' || change.operation.kind !== 'compaction') {
        throw new TypeError('Typed canonical compaction requires a compaction operation.');
    }
    const metadata = readCompactionCommitMetadata(change.metadata);
    // Only a summary checkpoint reaches this history; segment checkpoints belong to the Desktop provider.
    if (metadata?.method !== 'llm_checkpoint') {
        throw new TypeError('Canonical compaction metadata is invalid.');
    }
    const base = {
        ...change,
        reason: 'replaceMessages',
        operation: { id: change.operation.id, kind: 'compaction' },
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
    return { ...base, method: metadata.method };
}
function withOperation(change) {
    const { operation } = change;
    if (!operation)
        throw new TypeError('Canonical history operation is required.');
    return { ...change, operation };
}
function historySnapshot(head) {
    const messages = head.records.map(({ message }) => message);
    validateCanonicalHistoryMessages(messages);
    // Frozen arrays let the store share messages the sink already froze instead of cloning them.
    return {
        revision: head.revision,
        messages: Object.freeze(messages),
        identityVector: Object.freeze(head.records.map(({ message_id }) => message_id)),
    };
}
function turnCommit(status, head, deletedMessageIds) {
    return { ...historySnapshot(head), status, deletedMessageIds };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=sink-history.js.map