import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalActiveHistoryRevision, canonicalHistoryRevision, inspectCanonicalHistorySequence, } from '../../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../../sessions/representation/canonical-history.js';
import { CanonicalHistoryIndexWriteError, createCanonicalHistoryIndexAdapter, } from './canonical-history-index.js';
import { scanCanonicalHistoryArtifacts } from './canonical-history-scanner.js';
import { createSessionHistoryLocationResolver, } from '../session-history-location.js';
import { decodeHistoryMutationStagingManifest, historyMutationStagingPaths, toHistoryMutationStagingManifest, } from './session-history-staging.js';
import { createSessionHistoryIoLane, } from './session-history-coordination.js';
import { planRetractTurn, planSettleTurnTail, toTurnHistoryMutationCommit, validateRetractTurnInput, } from './session-turn-history-mutation.js';
const SNAPSHOT_NAME = /^g(\d{12})--[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u;
/** SessionSystem owns validated publication of the physical canonical-history bundle. */
export function createSessionHistoryMutationAdapter(options) {
    const files = createCanonicalHistoryFileAdapter();
    const ioLane = options.ioLane ?? createSessionHistoryIoLane();
    const locations = options.locations ??
        createSessionHistoryLocationResolver({ dataDir: options.dataDir, sessions: options.sessions });
    const context = { files, ioLane, locations, options };
    return {
        read: (sessionId) => ioLane.run(sessionId, () => read(sessionId)),
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
    async function read(sessionId) {
        const session = await requireSession(options, sessionId);
        const paths = await locations.ensure(session);
        const scanned = await scan(paths, sessionId);
        await cleanupOrphansBestEffort(paths, scanned.orphans);
        const active = await files.readActiveStrict(paths.messages);
        const snapshots = await Promise.all(scanned.catalog.artifacts
            .filter((artifact) => artifact.kind === 'snapshot')
            .sort((left, right) => left.generation - right.generation)
            .map(async (artifact) => ({
            generation: artifact.generation,
            fileName: artifact.fileName,
            revision: artifact.revision,
            records: await files.readStrict(join(paths.snapshots, artifact.fileName)),
        })));
        return {
            activeGeneration: scanned.catalog.activeGeneration,
            active,
            snapshots,
            revision: canonicalActiveHistoryRevision(active),
            activeSettled: inspectCanonicalHistorySequence(active).status === 'settled',
        };
    }
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
        const plan = planRetractTurn(history, input);
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
    async function stage(input) {
        validatePlan(input.generation, input.active, input.snapshots);
        const target = await requireSession(options, input.sessionId);
        const targetPaths = await locations.ensure(target);
        const staging = await createStaging(targetPaths, input.operationId);
        try {
            await writeBundle(staging, input.active, input.snapshots);
            const stagedScan = await scan(staging, input.sessionId);
            if (stagedScan.orphans.length > 0 ||
                stagedScan.catalog.activeGeneration !== input.generation) {
                throw new Error('Staged canonical history generation is not reachable');
            }
            if (input.kind === 'rewind') {
                await writeFile(staging.manifest, JSON.stringify(toHistoryMutationStagingManifest(input)), {
                    encoding: 'utf8',
                    mode: 0o600,
                });
            }
        }
        catch (error) {
            await cleanup(staging);
            throw error;
        }
        let published = false;
        return {
            staging,
            publish: (publishOptions) => ioLane.run(input.sessionId, async () => {
                if (published)
                    return;
                if (input.kind === 'fork') {
                    await publishFork(context, targetPaths, input);
                    await observeForkCommittedBestEffort(options, input);
                }
                else {
                    await publishRewind(context, targetPaths, input, publishOptions);
                    await observeRewindCommittedBestEffort(options, input);
                }
                published = true;
                options.activity?.notify(input.sessionId);
                if (input.kind === 'fork')
                    await cleanup(staging);
            }),
        };
    }
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
    const snapshots = await Promise.all(manifest.snapshots.map(async (snapshot) => ({
        ...snapshot,
        records: await context.files.readStrict(join(staging.snapshots, snapshot.fileName)),
    })));
    validatePlan(manifest.generation, active, snapshots);
    if (canonicalActiveHistoryRevision(active) !== manifest.targetRevision) {
        throw new Error('Staged canonical history target revision changed');
    }
    const stagedScan = await scan(staging, input.sessionId);
    if (stagedScan.orphans.length > 0 ||
        stagedScan.catalog.activeGeneration !== manifest.generation) {
        throw new Error('Staged canonical history generation is not reachable');
    }
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
async function publishFork(context, paths, input) {
    const existing = await context.files.readTargetStrict(paths.messages);
    const expectedRevision = canonicalActiveHistoryRevision(input.active);
    const initializedEmptyTarget = existing?.length === 0;
    if (existing &&
        !initializedEmptyTarget &&
        canonicalActiveHistoryRevision(existing) !== expectedRevision) {
        throw new Error('Fork target canonical history already contains a different revision');
    }
    await mkdir(paths.snapshots, { recursive: true, mode: 0o700 });
    await Promise.all(input.snapshots.map(async (snapshot) => {
        const path = join(paths.snapshots, snapshot.fileName);
        const publication = await context.files.publishSnapshot(path, snapshot.records);
        if (publication === 'already-exists') {
            await assertSnapshotRevision(path, snapshot.revision);
        }
    }));
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
    await Promise.all(input.snapshots.map((snapshot) => assertSnapshotRevision(join(paths.snapshots, snapshot.fileName), snapshot.revision)));
    if (currentRevision !== nextRevision) {
        await context.files.replaceActive(paths.messages, input.active);
    }
    await removeSnapshotsExcept(paths, new Set(input.snapshots.map((snapshot) => snapshot.fileName)));
    await validatePublished(paths, input.sessionId, input.generation, false);
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
    try {
        await createCanonicalHistoryIndexAdapter(paths.sessionDir).rebuild(published);
    }
    catch (error) {
        if (!(error instanceof CanonicalHistoryIndexWriteError))
            throw error;
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
        snapshot.snapshots.some((entry) => entry.records.some((envelope) => envelope.message_id === messageId)));
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
function validatePlan(generation, active, snapshots) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('Invalid history generation');
    }
    if (new Set(snapshots.map((snapshot) => snapshot.generation)).size !== snapshots.length) {
        throw new Error('Duplicate snapshot generation');
    }
    snapshots.forEach((snapshot) => {
        const match = SNAPSHOT_NAME.exec(snapshot.fileName);
        if (!match || Number(match[1]) !== snapshot.generation) {
            throw new Error(`Invalid canonical snapshot identity: ${snapshot.fileName}`);
        }
        if (canonicalHistoryRevision(snapshot.records) !== snapshot.revision) {
            throw new Error(`Canonical snapshot revision mismatch: ${snapshot.fileName}`);
        }
    });
    void canonicalActiveHistoryRevision(active);
}
async function writeBundle(paths, active, snapshots) {
    await mkdir(paths.snapshots, { recursive: true, mode: 0o700 });
    await writeFile(paths.messages, jsonl(active), { encoding: 'utf8', mode: 0o600 });
    await Promise.all(snapshots.map((snapshot) => writeFile(join(paths.snapshots, snapshot.fileName), jsonl(snapshot.records), {
        encoding: 'utf8',
        mode: 0o600,
    })));
}
async function assertSnapshotRevision(path, expectedRevision) {
    const records = await createCanonicalHistoryFileAdapter().readStrict(path);
    if (canonicalHistoryRevision(records) !== expectedRevision) {
        throw new Error(`Canonical snapshot revision changed: ${path}`);
    }
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
function scan(paths, sessionId) {
    return scanCanonicalHistoryArtifacts({
        activePath: paths.messages,
        snapshotsPath: paths.snapshots,
        sessionId,
    });
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