import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalActiveHistoryRevision, copyCanonicalHistorySnapshotFile, inspectCanonicalHistorySequence, rewriteCanonicalHistorySnapshotFile, verifyCanonicalHistorySnapshotFile, } from '../../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../../sessions/representation/canonical-history.js';
import { ensureCanonicalHistoryMaterialized, } from '../canonical-history-materializer.js';
import { assertPlannedLineage, scanCanonicalHistoryArtifacts, } from './canonical-history-scanner.js';
import { createSessionHistoryLocationResolver, } from '../session-history-location.js';
import { ensureResolvedSessionHistoryPaths, resolveSessionHistoryPaths, utcSessionHistoryRelativeDir, } from '../session-history-paths.js';
import { decodeHistoryMutationStagingManifest, historyMutationStagingPaths, toHistoryMutationStagingManifest, } from './session-history-staging.js';
import { createSessionHistoryIoLane, createSessionHistoryCompactionBarrier, } from './session-history-coordination.js';
import { planRetractTurn, planSettleTurnTail, retractTurnArtifactIndex, toTurnHistoryMutationCommit, validateRetractTurnInput, } from './session-turn-history-mutation.js';
export { canonicalHistoryRecordEntry, } from './canonical-history-scanner.js';
const SNAPSHOT_NAME = /^g(\d{12})--[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u;
/** SessionSystem owns validated publication of the physical canonical-history bundle. */
export function createSessionHistoryMutationAdapter(options) {
    const files = createCanonicalHistoryFileAdapter();
    const ioLane = options.ioLane ?? createSessionHistoryIoLane();
    const compactionBarrier = createSessionHistoryCompactionBarrier();
    const locations = options.locations ??
        createSessionHistoryLocationResolver({ dataDir: options.dataDir, sessions: options.sessions });
    const context = { files, ioLane, locations, options };
    const read = (sessionId, cleanupOrphans = true) => readHistory(context, sessionId, cleanupOrphans);
    return {
        compactionBarrier,
        read: (sessionId) => ioLane.run(sessionId, () => read(sessionId)),
        readSnapshotRecords: (sessionId, snapshot) => ioLane.run(sessionId, async () => (await snapshotReader(context, sessionId)).read(snapshot)),
        readFrozen: (sessionId, capture, signal) => compactionBarrier.run(sessionId, () => ioLane.run(sessionId, async () => {
            signal?.throwIfAborted();
            const frozen = await read(sessionId, false);
            signal?.throwIfAborted();
            return capture(frozen, await snapshotReader(context, sessionId));
        }), signal),
        stageUnpersisted: (input) => ioLane.run(input.target.sessionId, () => stageUnpersisted(context, input)),
        settleTurnTail: (input) => ioLane.run(input.sessionId, () => settleTurnTail(input)),
        retractTurn: (input) => ioLane.run(input.sessionId, () => retractTurn(input)),
        readForUserMessage: (input) => readForUserMessageBoundary(context, read, input),
        stageFork: (input) => ioLane.run(input.targetSessionId, () => stage({
            kind: 'fork',
            sourceSessionId: input.sourceSessionId,
            sessionId: input.targetSessionId,
            operationId: input.operationId,
            generation: input.generation,
            active: input.active,
            snapshots: input.snapshots,
        })),
        stageRewind: (input) => ioLane.run(input.sessionId, async () => {
            const stageInput = {
                kind: 'rewind',
                sessionId: input.sessionId,
                operationId: input.operationId,
                expectedRevision: input.expectedRevision,
                ...(input.sourceGeneration === undefined
                    ? {}
                    : { sourceGeneration: input.sourceGeneration }),
                generation: input.generation,
                active: input.active,
                snapshots: input.snapshots,
                ...(input.operationData === undefined ? {} : { operationData: input.operationData }),
            };
            const staged = await stage(stageInput);
            return rewindHandle(staged, stageInput);
        }),
        resumeRewind: (input) => ioLane.run(input.sessionId, () => resumeStagedRewind(context, input)),
    };
    async function settleTurnTail(input) {
        const history = await read(input.sessionId);
        const plan = planSettleTurnTail(history.active, input);
        if (plan.status === 'unchanged') {
            return toTurnHistoryMutationCommit({
                status: plan.status,
                generation: history.activeGeneration,
                active: plan.active,
                deletedMessageIds: plan.deletedMessageIds,
            });
        }
        const session = await requireSession(options, input.sessionId);
        const paths = await locations.ensure(session);
        await files.replaceActive(paths.messages, plan.active);
        await validatePublished(paths, input.sessionId, history.activeGeneration, false);
        const committed = await files.readStrict(paths.messages);
        options.activity?.notify(input.sessionId);
        return toTurnHistoryMutationCommit({
            status: 'committed',
            generation: history.activeGeneration,
            active: committed,
            deletedMessageIds: plan.deletedMessageIds,
        });
    }
    async function retractTurn(input) {
        validateRetractTurnInput(input);
        const resumed = await resumeTurnRetraction(context, input);
        if (resumed)
            return resumed;
        const history = await read(input.sessionId);
        const targetIndex = retractTurnArtifactIndex(history, input.turnId);
        const targetSnapshot = history.snapshots[targetIndex];
        const plan = planRetractTurn(history, input, targetSnapshot
            ? await (await snapshotReader(context, input.sessionId)).read(targetSnapshot)
            : undefined);
        if (plan.status === 'already-retracted') {
            return toTurnHistoryMutationCommit({
                status: plan.status,
                generation: plan.generation,
                active: plan.active,
                deletedMessageIds: plan.deletedMessageIds,
            });
        }
        const stageInput = {
            kind: 'rewind',
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
        };
        await stage(stageInput);
        const session = await requireSession(options, input.sessionId);
        const paths = await locations.ensure(session);
        await publishRewind(context, paths, stageInput);
        await observeRewindCommittedBestEffort(options, stageInput);
        const committed = await files.readStrict(paths.messages);
        options.activity?.notify(input.sessionId);
        return toTurnHistoryMutationCommit({
            status: 'committed',
            generation: plan.generation,
            active: committed,
            deletedMessageIds: plan.deletedMessageIds,
        });
    }
    /**
     * A Rewind receipt holds only the new active history and a manifest naming the snapshots it
     * keeps; snapshots never change after publication, so they stay where they are. A Fork stages
     * nothing: publication copies the source snapshot files into the target.
     */
    async function stage(input) {
        validatePlan(input.generation, input.active, input.snapshots);
        assertPlannedLineage(input.generation, input.active, input.snapshots);
        const target = await requireSession(options, input.sessionId);
        const targetPaths = await locations.ensure(target);
        const sourcePaths = input.kind === 'fork'
            ? await locations.ensure(await requireSession(options, input.sourceSessionId))
            : undefined;
        if (input.kind === 'rewind') {
            const staging = await createStaging(targetPaths, input.operationId);
            try {
                await writeStagedActive(files, staging.messages, input.active);
                await writeFile(staging.manifest, JSON.stringify(toHistoryMutationStagingManifest(input)), {
                    encoding: 'utf8',
                    mode: 0o600,
                });
            }
            catch (error) {
                await cleanup(staging);
                throw error;
            }
        }
        let published = false;
        return {
            publish: (publishOptions) => ioLane.run(input.sessionId, async () => {
                if (published)
                    return;
                if (input.kind === 'fork') {
                    if (!sourcePaths)
                        throw new Error('Fork source history location is missing');
                    await publishFork(context, sourcePaths, targetPaths, input);
                    await observeForkCommittedBestEffort(options, input);
                }
                else {
                    await publishRewind(context, targetPaths, input, publishOptions);
                    await observeRewindCommittedBestEffort(options, input);
                }
                published = true;
                options.activity?.notify(input.sessionId);
            }),
        };
    }
}
async function readHistory({ files, locations, options }, sessionId, cleanupOrphans = true) {
    const session = await requireSession(options, sessionId);
    const paths = await locations.ensure(session);
    let active = await files.readTargetStrict(paths.messages);
    if (active === undefined) {
        if ((await readDirectoryIfPresent(paths.snapshots)).length > 0) {
            throw new Error('Canonical history active file is missing while snapshots exist');
        }
        if (options.legacyHistory) {
            await ensureCanonicalHistoryMaterialized({
                sessionId,
                paths,
                files,
                legacyHistory: options.legacyHistory,
                nowMs: Date.now,
            });
            active = await files.readActiveStrict(paths.messages);
        }
        else {
            return {
                activeGeneration: 0,
                active: [],
                snapshots: [],
                revision: canonicalActiveHistoryRevision([]),
                activeSettled: true,
            };
        }
    }
    const scanned = await scan(paths, sessionId, { collectEntries: true });
    if (cleanupOrphans)
        await cleanupOrphansBestEffort(paths, scanned.orphans);
    const snapshots = scanned.catalog.artifacts
        .filter((artifact) => artifact.kind === 'snapshot')
        .sort((left, right) => left.generation - right.generation)
        .map((artifact) => ({
        generation: artifact.generation,
        fileName: artifact.fileName,
        revision: artifact.revision,
        entries: scanned.snapshotEntries?.get(artifact.fileName) ?? [],
    }));
    return {
        activeGeneration: scanned.catalog.activeGeneration,
        active,
        snapshots,
        revision: canonicalActiveHistoryRevision(active),
        activeSettled: inspectCanonicalHistorySequence(active).status === 'settled',
    };
}
async function stageUnpersisted(context, input) {
    const { ioLane, options } = context;
    validatePlan(input.generation, input.active, input.snapshots);
    if (await options.sessions.get(input.target.sessionId)) {
        throw new Error('Unpersisted history target Session already exists');
    }
    // Only archived generations are copied from the source; an empty lineage needs no source.
    const sourcePaths = input.snapshots.length > 0
        ? await context.locations.ensure(await requireSession(options, input.source.sessionId))
        : undefined;
    const historyRelativeDir = input.target.historyRelativeDir ??
        utcSessionHistoryRelativeDir(input.target.sessionId, input.target.createdAtMs);
    const target = {
        ...input.target,
        historyRelativeDir,
        updatedAtMs: input.target.createdAtMs,
    };
    const paths = resolveSessionHistoryPaths(options.dataDir, target);
    await mkdir(dirname(paths.sessionDir), { recursive: true, mode: 0o700 });
    // Exclusive creation establishes ownership; never overwrite or clean up an existing directory.
    await mkdir(paths.sessionDir, { mode: 0o700 });
    let targetRevision;
    try {
        ensureResolvedSessionHistoryPaths(paths, target);
        const revisions = sourcePaths
            ? await publishUnpersistedSnapshots(sourcePaths, paths, input)
            : new Map();
        const active = remapFirstRecordParent(input.active, revisions);
        assertPlannedLineage(input.generation, active, input.snapshots.map((snapshot) => ({
            ...snapshot,
            revision: revisions.get(snapshot.revision) ?? snapshot.revision,
        })));
        await writeFile(paths.messages, jsonl(active), { encoding: 'utf8', mode: 0o600 });
        await validatePublished(paths, target.sessionId, input.generation, true);
        targetRevision = canonicalActiveHistoryRevision(active);
    }
    catch (error) {
        await cleanup(paths);
        throw error;
    }
    return {
        historyRelativeDir,
        targetRevision,
        rollback: () => ioLane.run(target.sessionId, async () => {
            if (await options.sessions.get(target.sessionId))
                return;
            await cleanup(paths);
        }),
    };
}
async function readForUserMessageBoundary(context, read, input) {
    const activity = context.options.activity;
    const deadline = Date.now() + Math.max(0, Math.floor(input.timeoutMs));
    let observedVersion = activity?.version(input.sessionId) ?? 0;
    let polling = true;
    while (polling) {
        const snapshot = await context.ioLane.run(input.sessionId, () => read(input.sessionId));
        if (containsMessage(snapshot, input.userMessageId) || !activity)
            return snapshot;
        const currentVersion = activity.version(input.sessionId);
        if (currentVersion > observedVersion) {
            observedVersion = currentVersion;
            continue;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
            return snapshot;
        polling = await activity.waitForChange(input.sessionId, currentVersion, remainingMs);
        if (!polling)
            return snapshot;
        observedVersion = activity.version(input.sessionId);
    }
    throw new Error('Canonical history boundary polling stopped unexpectedly');
}
function rewindHandle(staged, input) {
    return {
        ...(input.sourceGeneration === undefined ? {} : { sourceGeneration: input.sourceGeneration }),
        generation: input.generation,
        active: input.active,
        snapshots: input.snapshots,
        sourceRevision: input.expectedRevision,
        targetRevision: canonicalActiveHistoryRevision(input.active),
        ...(input.operationData === undefined ? {} : { operationData: input.operationData }),
        publish: staged.publish,
    };
}
async function resumeStagedRewind(context, input, resumeOptions = {}) {
    const target = await requireSession(context.options, input.sessionId);
    const targetPaths = await context.locations.ensure(target);
    const staging = historyMutationStagingPaths(targetPaths, input.operationId);
    const raw = await readOptionalFile(staging.manifest);
    if (raw === undefined)
        return undefined;
    const manifest = decodeHistoryMutationStagingManifest(raw, input);
    const active = await context.files.readActiveStrict(staging.messages);
    // Receipts from earlier versions also hold snapshot copies; publication verifies the
    // Session's own snapshot files instead, so the copies are never read.
    const snapshots = manifest.snapshots;
    validatePlan(manifest.generation, active, snapshots);
    if (canonicalActiveHistoryRevision(active) !== manifest.targetRevision) {
        throw new Error('Staged canonical history target revision changed');
    }
    assertPlannedLineage(manifest.generation, active, snapshots);
    const stageInput = {
        kind: 'rewind',
        sessionId: input.sessionId,
        operationId: input.operationId,
        expectedRevision: manifest.sourceRevision,
        sourceGeneration: manifest.sourceGeneration,
        generation: manifest.generation,
        active,
        snapshots,
        ...(manifest.operationData === undefined ? {} : { operationData: manifest.operationData }),
    };
    let published = false;
    const publish = async (publishOptions) => {
        if (published)
            return;
        await publishRewind(context, targetPaths, stageInput, publishOptions);
        await observeRewindCommittedBestEffort(context.options, stageInput);
        published = true;
        context.options.activity?.notify(input.sessionId);
        // Keep the immutable staged bundle as the operation-scoped rewind
        // receipt. Retry/restart may safely publish it again and finish
        // owner-local projections without exposing a prepared handle.
    };
    const staged = {
        publish: (publishOptions) => resumeOptions.alreadyInIoLane
            ? publish(publishOptions)
            : context.ioLane.run(input.sessionId, () => publish(publishOptions)),
    };
    return rewindHandle(staged, stageInput);
}
async function resumeTurnRetraction(context, input) {
    const staged = await resumeStagedRewind(context, { sessionId: input.sessionId, operationId: input.operationId }, { alreadyInIoLane: true });
    if (!staged)
        return undefined;
    const deletedMessageIds = decodeTurnRetractionReceipt(staged.operationData, input);
    const session = await requireSession(context.options, input.sessionId);
    const paths = await context.locations.ensure(session);
    const current = await context.files.readActiveStrict(paths.messages);
    const status = canonicalActiveHistoryRevision(current) === staged.targetRevision
        ? 'already-retracted'
        : 'committed';
    await staged.publish();
    const committed = await context.files.readStrict(paths.messages);
    return toTurnHistoryMutationCommit({
        status,
        generation: staged.generation,
        active: committed,
        deletedMessageIds,
    });
}
function decodeTurnRetractionReceipt(data, input) {
    const reason = isRecord(data) ? data.reason : undefined;
    const deletedMessageIds = isRecord(data) ? data.deletedMessageIds : undefined;
    if (!isRecord(data) ||
        data.semanticMutation !== 'retract-turn' ||
        data.turnId !== input.turnId ||
        JSON.stringify(reason) !== JSON.stringify(input.reason) ||
        !Array.isArray(deletedMessageIds) ||
        deletedMessageIds.some((messageId) => typeof messageId !== 'string' || !messageId.trim())) {
        throw new Error('Turn history mutation staging receipt does not match the request');
    }
    return deletedMessageIds.flatMap((messageId) => typeof messageId === 'string' ? [messageId] : []);
}
async function publishFork(context, sourcePaths, paths, input) {
    const existing = await context.files.readTargetStrict(paths.messages);
    const expectedRevision = canonicalActiveHistoryRevision(input.active);
    const initializedEmptyTarget = existing?.length === 0;
    if (existing &&
        !initializedEmptyTarget &&
        canonicalActiveHistoryRevision(existing) !== expectedRevision) {
        throw new Error('Fork target canonical history already contains a different revision');
    }
    await mkdir(paths.snapshots, { recursive: true, mode: 0o700 });
    for (const snapshot of input.snapshots) {
        await copyCanonicalHistorySnapshotFile(join(sourcePaths.snapshots, snapshot.fileName), join(paths.snapshots, snapshot.fileName), snapshot.revision);
    }
    if (initializedEmptyTarget && input.active.length > 0) {
        await context.files.replaceActive(paths.messages, input.active);
    }
    else if (!existing) {
        await publishMissingForkTarget(context, paths, input.active, expectedRevision);
    }
    await validatePublished(paths, input.sessionId, input.generation, true);
}
async function publishMissingForkTarget(context, paths, active, expectedRevision) {
    const publication = await context.files.publishInitial(paths.messages, active);
    if (publication.status !== 'already-exists')
        return;
    const raced = await context.files.readActiveStrict(paths.messages);
    if (canonicalActiveHistoryRevision(raced) !== expectedRevision) {
        throw new Error('Fork target canonical history publication raced');
    }
}
async function publishRewind(context, paths, input, publishOptions) {
    const current = await context.files.readActiveStrict(paths.messages);
    const currentRevision = canonicalActiveHistoryRevision(current);
    const nextRevision = canonicalActiveHistoryRevision(input.active);
    if (publishOptions?.allowRevisionChange !== true &&
        currentRevision !== input.expectedRevision &&
        currentRevision !== nextRevision) {
        throw new Error('Canonical history revision changed before Rewind publication');
    }
    await assertStagedRewindReachable(paths, input);
    if (currentRevision !== nextRevision) {
        await context.files.replaceActive(paths.messages, input.active);
    }
    await removeSnapshotsExcept(paths, new Set(input.snapshots.map((snapshot) => snapshot.fileName)));
    await validatePublished(paths, input.sessionId, input.generation, false);
}
/**
 * Scans the staged active history against the Session's own snapshots before anything is
 * replaced or removed. The scan streams one record at a time, so the retained lineage never
 * sits in memory, and it must reach exactly the snapshots the plan keeps.
 */
async function assertStagedRewindReachable(paths, input) {
    const { catalog } = await scan({ ...paths, messages: historyMutationStagingPaths(paths, input.operationId).messages }, input.sessionId);
    const reached = catalog.artifacts.filter((artifact) => artifact.kind === 'snapshot');
    if (catalog.activeGeneration !== input.generation ||
        reached.length !== input.snapshots.length ||
        input.snapshots.some((snapshot) => !reached.some((artifact) => artifact.fileName === snapshot.fileName && artifact.revision === snapshot.revision))) {
        throw new Error('Staged canonical history generation is not reachable');
    }
}
async function validatePublished(paths, sessionId, generation, cleanupUnexpected) {
    let published = await scan(paths, sessionId);
    if (cleanupUnexpected && published.orphans.length > 0) {
        await removeOrphans(paths, published.orphans);
        published = await scan(paths, sessionId);
    }
    if (published.catalog.activeGeneration !== generation || published.orphans.length > 0) {
        throw new Error('Published canonical history generation is not reachable');
    }
}
async function createStaging(paths, operationId) {
    const staging = historyMutationStagingPaths(paths, operationId);
    await rm(staging.sessionDir, { recursive: true, force: true });
    await mkdir(staging.sessionDir, { recursive: true, mode: 0o700 });
    return staging;
}
async function requireSession(options, sessionId) {
    const session = await options.sessions.get(sessionId);
    if (!session)
        throw new Error(`Session not found: ${sessionId}`);
    return session;
}
async function readOptionalFile(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
function containsMessage(snapshot, messageId) {
    return (snapshot.active.some((envelope) => envelope.message_id === messageId) ||
        snapshot.snapshots.some((entry) => entry.entries.some((record) => record.messageId === messageId)));
}
async function observeRewindCommittedBestEffort(options, input) {
    try {
        await options.onRewindCommitted?.({
            sessionId: input.sessionId,
            operationId: input.operationId,
            fromGeneration: input.sourceGeneration ?? input.generation,
            toGeneration: input.generation,
        });
    }
    catch {
        // Evidence projection must never replace a committed canonical Rewind.
    }
}
async function observeForkCommittedBestEffort(options, input) {
    try {
        await options.onForkCommitted?.({
            sourceSessionId: input.sourceSessionId,
            targetSessionId: input.sessionId,
            snapshotFiles: input.snapshots.map((snapshot) => snapshot.fileName),
        });
    }
    catch {
        // Report projection must never replace a committed canonical Fork.
    }
}
/** Snapshot revisions are verified against the files when they are published or copied. */
function validatePlan(generation, active, snapshots) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('Invalid history generation');
    }
    if (new Set(snapshots.map((snapshot) => snapshot.generation)).size !== snapshots.length) {
        throw new Error('Duplicate snapshot generation');
    }
    snapshots.forEach(assertSnapshotIdentity);
    void canonicalActiveHistoryRevision(active);
}
/** A snapshot's file name must carry its generation before the name is joined to a path. */
function assertSnapshotIdentity(snapshot) {
    const match = SNAPSHOT_NAME.exec(snapshot.fileName);
    if (!match || Number(match[1]) !== snapshot.generation) {
        throw new Error(`Invalid canonical snapshot identity: ${snapshot.fileName}`);
    }
}
/** Writes the staged active history and reads it back strictly before it becomes a receipt. */
async function writeStagedActive(files, path, active) {
    await writeFile(path, jsonl(active), { encoding: 'utf8', mode: 0o600 });
    const staged = await files.readActiveStrict(path);
    if (canonicalActiveHistoryRevision(staged) !== canonicalActiveHistoryRevision(active)) {
        throw new Error('Staged canonical history does not match its plan');
    }
}
/**
 * Copies each snapshot into a new Session in generation order, or rewrites its records when the
 * caller rewrites messages. Returns the old-to-new revision of every rewritten snapshot.
 */
async function publishUnpersistedSnapshots(sourcePaths, paths, input) {
    const revisions = new Map();
    const rewriteMessage = input.source.rewriteMessage;
    await mkdir(paths.snapshots, { recursive: true, mode: 0o700 });
    const ordered = [...input.snapshots].sort((left, right) => left.generation - right.generation);
    for (const snapshot of ordered) {
        const sourcePath = join(sourcePaths.snapshots, snapshot.fileName);
        const targetPath = join(paths.snapshots, snapshot.fileName);
        if (!rewriteMessage) {
            await copyCanonicalHistorySnapshotFile(sourcePath, targetPath, snapshot.revision);
            continue;
        }
        const revision = await rewriteCanonicalHistorySnapshotFile({ path: sourcePath, revision: snapshot.revision }, targetPath, (record, index) => {
            const rewritten = { ...record, message: rewriteMessage(record.message) };
            return index === 0 ? remapParentRevision(rewritten, revisions) : rewritten;
        });
        revisions.set(snapshot.revision, revision);
    }
    return revisions;
}
function remapFirstRecordParent(records, revisions) {
    const [first, ...rest] = records;
    return first && revisions.size > 0 ? [remapParentRevision(first, revisions), ...rest] : records;
}
/** Points a generation marker at the rewritten revision of its parent snapshot. */
function remapParentRevision(record, revisions) {
    let copied = record;
    const artifact = record.history_artifact;
    if (artifact) {
        const parent = artifact.parentSnapshot;
        copied = {
            ...copied,
            history_artifact: {
                ...artifact,
                parentSnapshot: { ...parent, revision: revisions.get(parent.revision) ?? parent.revision },
            },
        };
    }
    const marker = record.message.archonCompaction;
    if (isRecord(marker) && isRecord(marker.parentSnapshot)) {
        const parent = marker.parentSnapshot;
        if (typeof parent.revision === 'string') {
            copied = {
                ...copied,
                message: {
                    ...copied.message,
                    archonCompaction: {
                        ...marker,
                        parentSnapshot: {
                            ...parent,
                            revision: revisions.get(parent.revision) ?? parent.revision,
                        },
                    },
                },
            };
        }
    }
    return copied;
}
async function snapshotReader(context, sessionId) {
    const session = await requireSession(context.options, sessionId);
    const paths = await context.locations.ensure(session);
    const forEach = async (snapshot, visit) => {
        assertSnapshotIdentity(snapshot);
        await verifyCanonicalHistorySnapshotFile(join(paths.snapshots, snapshot.fileName), snapshot.revision, visit);
    };
    return {
        forEach,
        read: async (snapshot) => {
            const records = [];
            await forEach(snapshot, (record) => {
                records.push(record);
            });
            return records;
        },
    };
}
async function removeSnapshotsExcept(paths, retained) {
    const names = await readDirectoryIfPresent(paths.snapshots);
    await removeOrphans(paths, names.filter((name) => SNAPSHOT_NAME.test(name) && !retained.has(name)));
}
async function readDirectoryIfPresent(path) {
    try {
        return await readdir(path);
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
}
async function removeOrphans(paths, names) {
    await Promise.all(names.map((name) => rm(join(paths.snapshots, name), { recursive: true, force: true })));
}
async function cleanupOrphansBestEffort(paths, names) {
    await Promise.allSettled(names.map((name) => rm(join(paths.snapshots, name), { recursive: true, force: true })));
}
function scan(paths, sessionId, options) {
    return scanCanonicalHistoryArtifacts({
        activePath: paths.messages,
        snapshotsPath: paths.snapshots,
        sessionId,
    }, undefined, options);
}
async function cleanup(paths) {
    await rm(paths.sessionDir, { recursive: true, force: true });
}
function jsonl(records) {
    return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}
//# sourceMappingURL=session-history-mutation-adapter.js.map