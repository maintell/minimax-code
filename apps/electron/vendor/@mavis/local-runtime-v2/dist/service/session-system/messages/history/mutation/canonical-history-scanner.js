import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalActiveHistoryRevision, canonicalHistoryRevision, } from '../../../sessions/representation/canonical-history-contract.js';
import { createCanonicalHistoryFileAdapter } from '../../../sessions/representation/canonical-history.js';
const SNAPSHOT_NAME = /^g(\d{12})--([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/u;
const EXTERNAL_USER_ID = /^msg-user-v1-.+$/u;
export class HistoryScannerError extends Error {
    code;
    constructor(code, cause) {
        super(`Canonical history scan failed: ${code}`, { cause });
        this.code = code;
        this.name = 'HistoryScannerError';
    }
}
export async function scanCanonicalHistoryArtifacts(paths, files = createCanonicalHistoryFileAdapter()) {
    const lineage = createExternalUserLineage();
    const { active, activeMarker } = await readActiveArtifact(files, paths.activePath, lineage);
    const names = await listSnapshotNames(paths.snapshotsPath);
    const chain = await scanReachableSnapshots({
        files,
        activeGeneration: active.generation,
        activeMarker,
        names,
        lineage,
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
    };
}
/**
 * Compaction only builds on the active generation, so it verifies the one snapshot the
 * active marker points to. Walking the whole lineage here would hold every generation
 * ever compacted in memory, which grows without bound in long sessions.
 */
export async function verifyCompactionParent(input, files = createCanonicalHistoryFileAdapter()) {
    const generation = inferActiveGeneration(input.activeRecords);
    const marker = readV2Marker(input.activeRecords, generation);
    if (generation === 0)
        return;
    await readReachableParent({
        files,
        generation,
        marker,
        byGeneration: groupSnapshotsByGeneration(await listSnapshotNames(input.snapshotsPath)),
        reachedNames: new Set(),
    });
}
async function scanReachableSnapshots(input) {
    const { files, activeGeneration, activeMarker, names, lineage } = input;
    const byGeneration = groupSnapshotsByGeneration(names);
    // Newest first; each generation's records are released once its user lineage is recorded,
    // so memory stays bounded by one snapshot however many times the session compacted.
    const artifacts = [];
    const reachedNames = new Set();
    let generation = activeGeneration;
    let marker = activeMarker;
    while (generation > 0) {
        const parent = await readReachableParent({
            files,
            generation,
            marker,
            byGeneration,
            reachedNames,
        });
        lineage.observe(parent.artifact.records, parent.artifact.generation);
        artifacts.unshift(catalogArtifact(parent.artifact));
        generation = parent.artifact.generation;
        marker = parent.marker;
    }
    return { artifacts, reachedNames };
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
    const { files, generation, marker, byGeneration, reachedNames } = input;
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
    const scanned = await readArtifact(files.readStrict(snapshot.path), snapshot.path, 'snapshot');
    if (scanned.revision !== parent.revision) {
        throw new HistoryScannerError('artifact-revision-mismatch');
    }
    return {
        artifact: { ...scanned, generation: snapshot.generation, fileName: snapshot.fileName },
        marker: readV2Marker(scanned.records, snapshot.generation),
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
    return {
        observe(records, generation) {
            for (const record of records) {
                if (!isExternalUserId(record.message_id))
                    continue;
                if (record.message.role !== 'user') {
                    conflict = true;
                    continue;
                }
                const fingerprint = externalUserFingerprint(record);
                const newer = oldestSeen.get(record.message_id);
                if (newer && (newer.fingerprint !== fingerprint || newer.generation !== generation + 1)) {
                    conflict = true;
                }
                oldestSeen.set(record.message_id, { fingerprint, generation });
            }
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
        throw new HistoryScannerError(error instanceof Error && /sequence|tool|history ends/iu.test(error.message)
            ? 'sequence-corruption'
            : 'malformed-jsonl', error);
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
async function listSnapshotNames(path) {
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