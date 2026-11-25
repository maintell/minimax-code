import { HistoryMutationError } from '../history-mutation-error.js';
import { linkHistoryArchives } from './archive-plan.js';
import { semanticHistoryRevision } from './canonical-record.js';
import { historyMutationErrorOf, resolveHistoryLineage, verifyHistoryLineage, } from './history-lineage.js';
/**
 * Rewind and Fork publish a staged chain as one sink commit; the stage stays as
 * the operation receipt, so a repeated publication reaches the same history.
 */
export function createSinkHistoryMutations(sink) {
    return {
        read: (sessionId) => readSinkHistory(sink, sessionId),
        stageRewind: (request) => stageRewind(sink, request),
        resumeRewind: async ({ sessionId, operationId }) => {
            const stage = await sink.loadRewindStage(sessionId, operationId);
            if (!stage)
                return undefined;
            assertStageIntegrity(stage);
            return rewindHandle(sink, sessionId, stage);
        },
        stageFork: (request) => stageFork(sink, request),
    };
}
/** The active history and its reachable chain; a corrupt chain fails classified. */
export async function readSinkHistory(sink, sessionId) {
    try {
        const head = await sink.readActive(sessionId);
        const lineage = await sinkLineage(sink, sessionId, head.records);
        return {
            activeGeneration: lineage.activeGeneration,
            active: head.records,
            snapshots: lineage.chain.map(linkSnapshot),
            revision: head.revision,
        };
    }
    catch (error) {
        throw historyMutationErrorOf(error);
    }
}
function sinkLineage(sink, sessionId, active) {
    return resolveHistoryLineage(lineageSource(sink, sessionId, active));
}
/** `sinkLineage` without archive records: the same checks, one archive in memory at a time. */
export function verifySinkLineage(sink, sessionId, active) {
    return verifyHistoryLineage(lineageSource(sink, sessionId, active));
}
function lineageSource(sink, sessionId, active) {
    return {
        active,
        codec: sink.codec,
        listArchives: () => sink.listArchives(sessionId),
        readArchive: (entry) => sink.readArchive(sessionId, entry),
    };
}
/** Stores a Rewind whose snapshots are the source chain up to `generation`. */
export async function stageRewind(sink, request) {
    const archives = await stagedChain(sink, request.sessionId, request);
    const stage = {
        operationId: request.operationId,
        sourceRevision: request.expectedRevision,
        sourceGeneration: request.sourceGeneration,
        generation: request.generation,
        active: request.active,
        archives,
        ...(request.operationData === undefined ? {} : { operationData: request.operationData }),
    };
    await sink.saveRewindStage(request.sessionId, stage);
    return rewindHandle(sink, request.sessionId, stage);
}
async function stageFork(sink, request) {
    const archives = await stagedChain(sink, request.sourceSessionId, request);
    let publication;
    return {
        publish: async () => {
            publication ??= await publishFork(sink, request, archives);
            return publication;
        },
    };
}
/**
 * Validates a staged plan against the source chain: each snapshot must be the
 * source archive of its generation, and the staged active history must reach
 * exactly those archives once they are listed, at the planned generation.
 */
async function stagedChain(sink, sourceSessionId, plan) {
    validateStagePlan(plan.generation, plan.snapshots);
    const source = await sink.readActive(sourceSessionId);
    const lineage = await sinkLineage(sink, sourceSessionId, source.records);
    const links = [...plan.snapshots]
        .sort((left, right) => left.generation - right.generation)
        .map((snapshot) => sourceLink(lineage, snapshot));
    const archives = linkHistoryArchives(links.map((link) => ({
        generation: link.generation,
        compactionId: link.entry.compactionId,
        records: link.records,
    })), plan.active);
    await assertStagedReachable(sink.codec, archives, plan);
    return archives;
}
function sourceLink(lineage, snapshot) {
    const link = lineage.chain.find(({ generation }) => generation === snapshot.generation);
    if (!link) {
        throw new Error(`Invalid canonical snapshot identity: g${String(snapshot.generation)}`);
    }
    if (semanticHistoryRevision(snapshot.records) !== link.revision) {
        throw new Error(`Canonical snapshot revision mismatch: g${String(snapshot.generation)}`);
    }
    return link;
}
async function assertStagedReachable(codec, archives, plan) {
    const entries = archives.map((archive) => codec.archiveEntry(archive));
    const records = new Map(entries.map((entry, index) => [entry, archives[index]?.records ?? []]));
    const staged = await resolveHistoryLineage({
        active: plan.active,
        codec,
        listArchives: async () => entries,
        readArchive: async (entry) => records.get(entry) ?? [],
    });
    if (staged.orphans.length > 0 || staged.activeGeneration !== plan.generation) {
        throw new Error('Staged canonical history generation is not reachable');
    }
}
function validateStagePlan(generation, snapshots) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('Invalid history generation');
    }
    if (new Set(snapshots.map((snapshot) => snapshot.generation)).size !== snapshots.length) {
        throw new Error('Duplicate snapshot generation');
    }
}
/** A loaded stage must still hold the chain it was validated with. */
function assertStageIntegrity(stage) {
    validateStagePlan(stage.generation, stage.archives);
    stage.archives.forEach((archive, index) => {
        if (semanticHistoryRevision(archive.records) !== archive.revision) {
            throw new Error(`Canonical snapshot revision mismatch: g${String(archive.generation)}`);
        }
        if (archive.generation !== index) {
            throw new Error('Staged canonical history generation is not reachable');
        }
    });
    if (stage.archives.length !== stage.generation) {
        throw new Error('Staged canonical history generation is not reachable');
    }
}
function rewindHandle(sink, sessionId, stage) {
    let publication;
    return {
        ...(stage.sourceGeneration === undefined ? {} : { sourceGeneration: stage.sourceGeneration }),
        generation: stage.generation,
        active: stage.active,
        snapshots: stage.archives.map(archiveSnapshot),
        sourceRevision: stage.sourceRevision,
        ...(stage.operationData === undefined ? {} : { operationData: stage.operationData }),
        publish: async (options) => {
            publication ??= await publishRewind(sink, sessionId, stage, options?.allowRevisionChange);
            return publication;
        },
    };
}
async function publishRewind(sink, sessionId, stage, allowRevisionChange) {
    const current = await sink.readActive(sessionId);
    const changed = !sameRecords(current.records, stage.active);
    if (allowRevisionChange !== true && current.revision !== stage.sourceRevision && changed) {
        throw new HistoryMutationError('revision-conflict', 'Canonical history revision changed before Rewind publication');
    }
    if (changed) {
        await sink.commit(sessionId, {
            expectedRevision: current.revision,
            active: stage.active,
            archives: stage.archives,
        });
    }
    return verifyPublished(sink, sessionId, stage);
}
async function publishFork(sink, request, archives) {
    const target = await sink.readActive(request.targetSessionId);
    const changed = !sameRecords(target.records, request.active);
    if (changed && target.records.length > 0) {
        throw new Error('Fork target canonical history already contains a different revision');
    }
    if (changed) {
        await sink.commit(request.targetSessionId, {
            expectedRevision: target.revision,
            active: request.active,
            archives,
        });
    }
    return verifyPublished(sink, request.targetSessionId, {
        generation: request.generation,
        archives,
    });
}
/**
 * The published active history must reach the expected chain. Archives it no
 * longer reaches go to the Host for best-effort removal.
 */
async function verifyPublished(sink, sessionId, expected) {
    const head = await sink.readActive(sessionId);
    const lineage = await verifySinkLineage(sink, sessionId, head.records);
    if (lineage.activeGeneration !== expected.generation ||
        lineage.chain.some((link, index) => link.revision !== expected.archives[index]?.revision)) {
        throw new Error('Published canonical history generation is not reachable');
    }
    await deleteArchivesBestEffort(sink, sessionId, lineage.orphans);
    return { revision: head.revision };
}
async function deleteArchivesBestEffort(sink, sessionId, entries) {
    if (entries.length === 0 || !sink.deleteArchives)
        return;
    try {
        await sink.deleteArchives(sessionId, entries);
    }
    catch {
        // An unreachable archive is never read; removal failure cannot affect the history.
    }
}
export function sameRecords(left, right) {
    return semanticHistoryRevision(left) === semanticHistoryRevision(right);
}
function linkSnapshot(link) {
    return {
        generation: link.generation,
        records: link.records,
        compactionId: link.entry.compactionId,
        revision: link.revision,
    };
}
function archiveSnapshot(archive) {
    return {
        generation: archive.generation,
        records: archive.records,
        compactionId: archive.compactionId,
        revision: archive.revision,
    };
}
//# sourceMappingURL=sink-mutations.js.map