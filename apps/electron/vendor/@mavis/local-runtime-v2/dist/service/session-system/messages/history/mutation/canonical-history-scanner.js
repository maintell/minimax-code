import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalActiveHistoryRevision, canonicalHistoryRevision, verifyCanonicalHistorySnapshotFile, } from '../../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../../sessions/representation/canonical-history.js';
const SNAPSHOT_NAME = /^g(\d{12})--([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/u;
const EXTERNAL_USER_ID = /^msg-user-v1-.+$/u;
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
export class HistoryScannerError extends Error {
    code;
    constructor(code, cause) {
        super(`Canonical history scan failed: ${code}`, { cause });
        this.code = code;
        this.name = 'HistoryScannerError';
    }
}
/**
 * Walks the reachable lineage newest first. Snapshots are streamed one record at a time, so
 * memory stays bounded by the active history and one record however long the lineage grows.
 */
export async function scanCanonicalHistoryArtifacts(paths, files = createCanonicalHistoryFileAdapter(), options = {}) {
    const lineage = createExternalUserLineage();
    const { active, activeMarker } = await readActiveArtifact(files, paths.activePath, lineage);
    const names = await listSnapshotNames(paths.snapshotsPath);
    const chain = await scanReachableSnapshots({
        activeGeneration: active.generation,
        activeMarker,
        names,
        lineage,
        collectEntries: options.collectEntries === true,
    });
    lineage.assertConsistent();
    return {
        catalog: {
            schemaVersion: 1,
            sessionId: paths.sessionId,
            activeGeneration: active.generation,
            activeRevision: active.revision,
            artifacts: [...chain.artifacts, active],
        },
        orphans: names
            .filter((entry) => !chain.reachedNames.has(entry.fileName))
            .map((entry) => entry.fileName),
        ...(chain.entries ? { snapshotEntries: chain.entries } : {}),
    };
}
/**
 * Compaction only builds on the active generation, so it verifies the one snapshot the
 * active marker points to. Walking the whole lineage here would hold every generation
 * ever compacted in memory, which grows without bound in long sessions.
 */
export async function verifyCompactionParent(input) {
    const generation = inferActiveGeneration(input.activeRecords);
    const marker = readV2Marker(input.activeRecords, generation);
    if (generation === 0)
        return;
    await readReachableParent({
        generation,
        marker,
        byGeneration: groupSnapshotsByGeneration(await listSnapshotNames(input.snapshotsPath)),
        reachedNames: new Set(),
    });
}
/**
 * A planned active history must name the newest kept snapshot as its parent, and the kept
 * snapshots must be generations 0..generation-1. The kept snapshots' own links were verified by
 * the scan that produced the plan; publication scans the whole lineage again.
 */
export function assertPlannedLineage(generation, active, snapshots) {
    let marker;
    try {
        if (inferActiveGeneration(active) !== generation)
            throw unreachablePlan();
        marker = readV2Marker(active, generation);
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
        marker?.parentSnapshot.generation !== parent.generation ||
        marker.parentSnapshot.compactionId !== SNAPSHOT_NAME.exec(parent.fileName)?.[2] ||
        marker.parentSnapshot.revision !== parent.revision) {
        throw unreachablePlan();
    }
}
function unreachablePlan(cause) {
    return new Error('Staged canonical history generation is not reachable', cause === undefined ? undefined : { cause });
}
async function scanReachableSnapshots(input) {
    const { activeGeneration, activeMarker, names, lineage, collectEntries } = input;
    const byGeneration = groupSnapshotsByGeneration(names);
    const artifacts = [];
    const entries = collectEntries
        ? new Map()
        : undefined;
    const reachedNames = new Set();
    let generation = activeGeneration;
    let marker = activeMarker;
    while (generation > 0) {
        const parent = await readReachableParent({
            generation,
            marker,
            byGeneration,
            reachedNames,
            lineage,
            collectEntries,
        });
        artifacts.unshift(parent.artifact);
        if (entries && parent.entries)
            entries.set(parent.artifact.fileName, parent.entries);
        generation = parent.artifact.generation;
        marker = parent.marker;
    }
    return { artifacts, reachedNames, ...(entries ? { entries } : {}) };
}
function groupSnapshotsByGeneration(names) {
    const grouped = new Map();
    for (const entry of names) {
        const entries = grouped.get(entry.generation) ?? [];
        entries.push(entry);
        grouped.set(entry.generation, entries);
    }
    return grouped;
}
async function readReachableParent(input) {
    const { generation, marker, byGeneration, reachedNames } = input;
    if (!marker)
        throw new HistoryScannerError('invalid-generation-marker');
    const parent = marker.parentSnapshot;
    if (parent.generation !== generation - 1)
        throw new HistoryScannerError('parent-mismatch');
    const snapshot = byGeneration
        .get(parent.generation)
        ?.find((entry) => entry.compactionId === parent.compactionId);
    if (!snapshot)
        throw new HistoryScannerError('parent-snapshot-missing');
    if (!snapshot.regular)
        throw new HistoryScannerError('unsafe-artifact');
    if (reachedNames.has(snapshot.fileName)) {
        throw new HistoryScannerError('invalid-generation-marker');
    }
    reachedNames.add(snapshot.fileName);
    const scanned = await streamSnapshotArtifact({
        path: snapshot.path,
        generation: snapshot.generation,
        revision: parent.revision,
        ...(input.lineage ? { lineage: input.lineage } : {}),
        collectEntries: input.collectEntries === true,
    });
    return {
        artifact: {
            generation: snapshot.generation,
            kind: 'snapshot',
            fileName: snapshot.fileName,
            revision: scanned.revision,
            byteLength: scanned.byteLength,
            messageCount: scanned.messageCount,
        },
        marker: readV2Marker(scanned.first ? [scanned.first] : [], snapshot.generation),
        ...(scanned.entries ? { entries: scanned.entries } : {}),
    };
}
/** One pass over a snapshot file that keeps only its first record and, if asked, entries. */
async function streamSnapshotArtifact(input) {
    const info = await lstat(input.path);
    if (!info.isFile() || info.isSymbolicLink())
        throw new HistoryScannerError('unsafe-artifact');
    let first;
    const entries = input.collectEntries ? [] : undefined;
    let streamed;
    try {
        streamed = await verifyCanonicalHistorySnapshotFile(input.path, input.revision, (envelope, index) => {
            if (index === 0)
                first = envelope;
            input.lineage?.observeRecord(envelope, input.generation);
            entries?.push(canonicalHistoryRecordEntry(envelope));
        });
    }
    catch (error) {
        throw isRecord(error) && error.code === 'artifact-revision-mismatch'
            ? new HistoryScannerError('artifact-revision-mismatch', error)
            : classifyReadError(error);
    }
    return {
        revision: streamed.revision,
        messageCount: streamed.messageCount,
        byteLength: info.size,
        first,
        ...(entries ? { entries } : {}),
    };
}
async function readActiveArtifact(files, activePath, lineage) {
    const scanned = await readArtifact(files.readActiveStrict(activePath), activePath, 'active');
    const generation = inferActiveGeneration(scanned.records);
    const activeMarker = readV2Marker(scanned.records, generation);
    lineage.observe(scanned.records, generation);
    return {
        active: catalogArtifact({ ...scanned, generation, fileName: 'messages.jsonl' }),
        activeMarker,
    };
}
function catalogArtifact({ path: _path, records: _records, ...artifact }) {
    return artifact;
}
/**
 * A user message keeps its `msg-user-v1-` identity across compaction generations.
 * Every occurrence must be a user message, and a repeated occurrence must carry the
 * same payload in the adjacent generation; otherwise the reachable chain is corrupt.
 * Generations are observed newest first and only one fingerprint per identity is kept.
 * The conflict is raised after the walk so other chain errors keep their precedence.
 */
function createExternalUserLineage() {
    const oldestSeen = new Map();
    let conflict = false;
    const observeRecord = (record, generation) => {
        if (!isExternalUserId(record.message_id))
            return;
        if (record.message.role !== 'user') {
            conflict = true;
            return;
        }
        const fingerprint = externalUserFingerprint(record);
        const newer = oldestSeen.get(record.message_id);
        if (newer && (newer.fingerprint !== fingerprint || newer.generation !== generation + 1)) {
            conflict = true;
        }
        oldestSeen.set(record.message_id, { fingerprint, generation });
    };
    return {
        observeRecord,
        observe(records, generation) {
            for (const record of records)
                observeRecord(record, generation);
        },
        assertConsistent() {
            if (conflict)
                throw new HistoryScannerError('external-user-lineage-conflict');
        },
    };
}
function externalUserFingerprint(envelope) {
    const semanticEnvelope = {
        message_id: envelope.message_id,
        turn_id: envelope.turn_id,
        message: envelope.message,
        ...(envelope.turn_config ? { turn_config: envelope.turn_config } : {}),
    };
    return canonicalHistoryRevision([semanticEnvelope]);
}
async function readArtifact(promise, path, kind) {
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
    const byteLength = info.size;
    return {
        path,
        records,
        revision: kind === 'active'
            ? canonicalActiveHistoryRevision(records)
            : canonicalHistoryRevision(records),
        generation: 0,
        kind,
        fileName: '',
        byteLength,
        messageCount: records.length,
    };
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
function readV2Marker(records, generation) {
    const artifact = records[0]?.history_artifact;
    if (artifact !== undefined) {
        if (artifact.generation !== generation) {
            throw new HistoryScannerError('invalid-generation-marker');
        }
        return artifact;
    }
    const value = records[0]?.message.archonCompaction;
    if (value === undefined) {
        if (generation > 0)
            throw new HistoryScannerError('invalid-generation-marker');
        return undefined;
    }
    if (isLegacyCompactionMarker(value)) {
        if (generation > 0 || records[0]?.message.role !== 'user') {
            throw new HistoryScannerError('invalid-generation-marker');
        }
        return undefined;
    }
    if (!isMarker(value, generation) || records[0]?.message.role !== 'user') {
        throw new HistoryScannerError('invalid-generation-marker');
    }
    return value;
}
function isMarker(value, generation) {
    if (!isRecord(value) || value.schemaVersion !== 2 || value.generation !== generation) {
        return false;
    }
    const parent = value.parentSnapshot;
    return (isRecord(parent) &&
        isNonNegativeInteger(parent.generation) &&
        typeof parent.compactionId === 'string' &&
        parent.compactionId.length > 0 &&
        typeof parent.revision === 'string' &&
        /^sha256:[a-f0-9]{64}$/u.test(parent.revision));
}
function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function inferActiveGeneration(records) {
    const artifact = records[0]?.history_artifact;
    if (artifact !== undefined)
        return artifact.generation;
    const value = records[0]?.message.archonCompaction;
    if (value === undefined)
        return 0;
    if (isLegacyCompactionMarker(value))
        return 0;
    if (!isRecord(value) ||
        value.schemaVersion !== 2 ||
        typeof value.generation !== 'number' ||
        !Number.isInteger(value.generation) ||
        value.generation < 1)
        throw new HistoryScannerError('invalid-generation-marker');
    return value.generation;
}
function isLegacyCompactionMarker(value) {
    return isRecord(value) && value.schemaVersion === 1 && typeof value.summary === 'string';
}
function isExternalUserId(value) {
    return EXTERNAL_USER_ID.test(value);
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isMissing(error) {
    return isRecord(error) && error.code === 'ENOENT';
}
//# sourceMappingURL=canonical-history-scanner.js.map