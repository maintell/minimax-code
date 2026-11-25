import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { historyArtifactCodec, HistoryLineageError, pointerNames, resolveHistoryLineage, semanticHistoryRevision, storedHistoryGeneration, } from '@mavis/harness';
import { canonicalActiveHistoryRevision, streamCanonicalHistoryFile, verifyCanonicalHistorySnapshotFile, } from '../../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../../sessions/representation/canonical-history.js';
const SNAPSHOT_NAME = /^g(\d{12})--([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/u;
export function canonicalHistoryRecordEntry(envelope) {
    const message = envelope.message;
    const base = { messageId: envelope.message_id, turnId: envelope.turn_id, role: message.role };
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
        return { ...base, toolCallId: message.toolCallId };
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content))
        return base;
    const toolCallIds = message.content.flatMap((block) => isRecord(block) && block.type === 'toolCall' && typeof block.id === 'string' ? [block.id] : []);
    return toolCallIds.length > 0 ? { ...base, toolCallIds } : base;
}
export function canonicalSnapshotEntry(snapshotsPath, archive) {
    const fileName = `g${String(archive.generation).padStart(12, '0')}--${archive.compactionId}.jsonl`;
    return {
        generation: archive.generation,
        compactionId: archive.compactionId,
        fileName,
        path: join(snapshotsPath, fileName),
        regular: true,
    };
}
/** The `history_artifact` marker codec over the snapshot files of one Session. */
export function canonicalSnapshotCodec(snapshotsPath) {
    return {
        storedGeneration: storedHistoryGeneration,
        parentOf: (records, generation, archives) => historyArtifactCodec.parentOf(records, generation, archives),
        archiveEntry: (archive) => canonicalSnapshotEntry(snapshotsPath, archive),
    };
}
export class HistoryScannerError extends Error {
    code;
    constructor(code, cause) {
        super(`Canonical history scan failed: ${code}`, { cause });
        this.code = code;
        this.name = 'HistoryScannerError';
    }
}
/**
 * Lists `g<generation>--<compactionId>.jsonl` snapshots and resolves the chain the active
 * marker reaches with the shared History lineage rules. Each reachable snapshot is read in
 * one streaming pass that verifies its revision and collects its record entries, so a
 * mutation can locate a message in any generation without a second read.
 */
export async function scanCanonicalHistoryArtifacts(paths, files = createCanonicalHistoryFileAdapter(), options = {}) {
    const activeBase = await readArtifact(files.readActiveStrict(paths.activePath), paths.activePath);
    const names = await listSnapshotNames(paths.snapshotsPath);
    const collectEntries = options.collectEntries === true;
    const snapshotEntries = collectEntries
        ? new Map()
        : undefined;
    const read = new Map();
    const pointers = createParentPointerIndex(paths.snapshotsPath);
    const lineage = await resolveSnapshotLineage(activeBase.records, names, pointers.codec, async (entry) => {
        const scanned = await streamSnapshotArtifact({
            path: entry.path,
            revision: pointers.revisionOf(entry),
            collectEntries,
        });
        read.set(entry, { records: scanned.records, byteLength: scanned.byteLength });
        if (snapshotEntries && scanned.entries)
            snapshotEntries.set(entry.fileName, scanned.entries);
        return scanned.records;
    });
    const reachable = lineage.chain.map(({ entry, revision }) => {
        const artifact = read.get(entry);
        if (!artifact)
            throw new HistoryScannerError('parent-snapshot-missing');
        return scannedArtifact(artifact, {
            generation: entry.generation,
            kind: 'snapshot',
            fileName: entry.fileName,
            revision,
        });
    });
    const activeRevision = canonicalActiveHistoryRevision(activeBase.records);
    reachable.push(scannedArtifact(activeBase, {
        generation: lineage.activeGeneration,
        kind: 'active',
        fileName: 'messages.jsonl',
        revision: activeRevision,
    }));
    return {
        catalog: {
            schemaVersion: 1,
            sessionId: paths.sessionId,
            activeGeneration: lineage.activeGeneration,
            activeRevision,
            artifacts: reachable,
        },
        orphans: lineage.orphans.map((entry) => entry.fileName),
        ...(snapshotEntries ? { snapshotEntries } : {}),
    };
}
/**
 * Compaction only builds on the active generation, so it verifies the one snapshot the
 * active marker points to. Walking the whole lineage here would hold every generation
 * ever compacted in memory, which grows without bound in long sessions.
 */
export async function verifyCompactionParent(input, files = createCanonicalHistoryFileAdapter()) {
    const codec = canonicalSnapshotCodec(input.snapshotsPath);
    try {
        const names = await listSnapshotNames(input.snapshotsPath);
        const pointer = codec.parentOf(input.activeRecords, codec.storedGeneration?.(input.activeRecords), names);
        if (!pointer)
            return;
        const entry = names.find((candidate) => pointerNames(pointer, candidate));
        if (!entry)
            throw new HistoryLineageError('parent-snapshot-missing');
        if (!entry.regular)
            throw new HistoryLineageError('unsafe-artifact');
        const parent = await readArtifact(files.readStrict(entry.path), entry.path);
        if (pointer.revision !== undefined &&
            semanticHistoryRevision(parent.records) !== pointer.revision) {
            throw new HistoryLineageError('artifact-revision-mismatch');
        }
    }
    catch (error) {
        if (error instanceof HistoryLineageError)
            throw new HistoryScannerError(error.code, error);
        throw error;
    }
}
/**
 * A planned active history must name the newest kept snapshot as its parent, and the kept
 * snapshots must be generations 0..generation-1. The kept snapshots' own links were verified by
 * the scan that produced the plan; publication scans the whole lineage again.
 */
export function assertPlannedLineage(generation, active, snapshots) {
    let pointer;
    try {
        if (storedHistoryGeneration(active) !== generation)
            throw unreachablePlan();
        // The marker codec decodes the parent from the records, so no archive listing is needed.
        pointer = historyArtifactCodec.parentOf(active, generation, []);
    }
    catch (error) {
        throw unreachablePlan(error);
    }
    const generations = snapshots.map((snapshot) => snapshot.generation).sort((a, b) => a - b);
    if (generations.length !== generation || generations.some((value, index) => value !== index)) {
        throw unreachablePlan();
    }
    if (generation === 0)
        return;
    const parent = snapshots.find((snapshot) => snapshot.generation === generation - 1);
    if (!parent ||
        pointer?.generation !== parent.generation ||
        pointer.compactionId !== SNAPSHOT_NAME.exec(parent.fileName)?.[2] ||
        pointer.revision !== parent.revision) {
        throw unreachablePlan();
    }
}
function unreachablePlan(cause) {
    return new Error('Staged canonical history generation is not reachable', cause === undefined ? undefined : { cause });
}
/**
 * `resolveHistoryLineage` hands `readArchive` only the listing entry, while a snapshot reader
 * must check the file against the revision its parent pointer stores. The codec records every
 * pointer it decodes against the entry that pointer names, so the reader can look it up.
 */
function createParentPointerIndex(snapshotsPath) {
    const pointers = new Map();
    const base = canonicalSnapshotCodec(snapshotsPath);
    return {
        codec: {
            ...base,
            parentOf: (records, generation, archives) => {
                const pointer = base.parentOf(records, generation, archives);
                if (!pointer)
                    return undefined;
                const entry = archives.find((candidate) => pointerNames(pointer, candidate));
                if (entry)
                    pointers.set(entry, pointer);
                return pointer;
            },
        },
        revisionOf: (entry) => pointers.get(entry)?.revision,
    };
}
async function resolveSnapshotLineage(active, names, codec, readArchive) {
    try {
        return await resolveHistoryLineage({
            active,
            codec,
            listArchives: () => Promise.resolve(names),
            readArchive,
        });
    }
    catch (error) {
        if (error instanceof HistoryLineageError)
            throw new HistoryScannerError(error.code, error);
        throw error;
    }
}
/** One streaming pass over a snapshot file: its records and, if asked, their entries. */
async function streamSnapshotArtifact(input) {
    const info = await lstat(input.path);
    if (!info.isFile() || info.isSymbolicLink())
        throw new HistoryScannerError('unsafe-artifact');
    const records = [];
    const entries = input.collectEntries ? [] : undefined;
    const visit = (envelope) => {
        records.push(envelope);
        entries?.push(canonicalHistoryRecordEntry(envelope));
    };
    try {
        if (input.revision === undefined) {
            await streamCanonicalHistoryFile(input.path, { sequence: 'settled', visit });
        }
        else {
            await verifyCanonicalHistorySnapshotFile(input.path, input.revision, visit);
        }
    }
    catch (error) {
        throw isRecord(error) && error.code === 'artifact-revision-mismatch'
            ? new HistoryScannerError('artifact-revision-mismatch', error)
            : classifyReadError(error);
    }
    return { records, byteLength: info.size, ...(entries ? { entries } : {}) };
}
function scannedArtifact(artifact, identity) {
    return {
        generation: identity.generation,
        kind: identity.kind,
        fileName: identity.fileName,
        revision: identity.revision,
        byteLength: artifact.byteLength,
        messageCount: artifact.records.length,
    };
}
async function readArtifact(promise, path) {
    let records;
    try {
        records = await promise;
    }
    catch (error) {
        throw classifyReadError(error);
    }
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
        throw new HistoryScannerError('unsafe-artifact');
    return { records, byteLength: info.size };
}
function classifyReadError(error) {
    return new HistoryScannerError(error instanceof Error && /sequence|tool|history ends/iu.test(error.message)
        ? 'sequence-corruption'
        : 'malformed-jsonl', error);
}
/** Snapshot files named `g<generation>--<compactionId>.jsonl`, in file name order. */
export async function listSnapshotNames(path) {
    let entries;
    try {
        entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' });
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
    const result = [];
    for (const entry of entries) {
        const fileName = entry.name;
        const match = SNAPSHOT_NAME.exec(fileName);
        if (!match)
            continue;
        const generationText = match[1];
        const compactionId = match[2];
        if (generationText === undefined || compactionId === undefined)
            continue;
        result.push({
            generation: Number(generationText),
            compactionId,
            fileName,
            path: join(path, fileName),
            regular: entry.isFile() && !entry.isSymbolicLink(),
        });
    }
    return result.sort((left, right) => left.fileName.localeCompare(right.fileName));
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isMissing(error) {
    return isRecord(error) && error.code === 'ENOENT';
}
//# sourceMappingURL=canonical-history-scanner.js.map