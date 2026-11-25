import { withoutHistoryArtifact, } from './canonical-record.js';
import { HistoryLineageError, } from './history-lineage.js';
const REVISION = /^sha256:[a-f0-9]{64}$/u;
/**
 * Lenient generation of the active history: its marker, the in-message
 * `archonCompaction.generation` on a leading user message, otherwise 0.
 */
export function activeHistoryGeneration(records) {
    const artifactGeneration = records[0]?.history_artifact?.generation;
    if (artifactGeneration !== undefined)
        return artifactGeneration;
    const first = records[0]?.message;
    if (!first || first.role !== 'user')
        return 0;
    const marker = Reflect.get(first, 'archonCompaction');
    if (!marker || typeof marker !== 'object' || Array.isArray(marker))
        return 0;
    const generation = Reflect.get(marker, 'generation');
    return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
        ? generation
        : 0;
}
/** A replacement within one generation keeps the existing marker on its first record. */
export function preserveHistoryArtifact(existing, replacement) {
    const artifact = existing[0]?.history_artifact;
    if (!artifact)
        return [...replacement];
    return replacement.map((record, index) => {
        const semanticEnvelope = withoutHistoryArtifact(record);
        return index === 0 ? { ...semanticEnvelope, history_artifact: artifact } : semanticEnvelope;
    });
}
export function markHistoryArtifact(replacement, marker) {
    if (replacement.length === 0) {
        throw new TypeError('Canonical compaction replacement cannot be empty.');
    }
    return replacement.map((record, index) => {
        const semanticEnvelope = withoutHistoryArtifact(record);
        return index === 0 ? { ...semanticEnvelope, history_artifact: marker } : semanticEnvelope;
    });
}
/** Archive id safe for every Host key scheme: `[A-Za-z0-9._-]`, alphanumeric first, ≤120. */
export function safeCompactionId(value) {
    const sanitized = value.trim().replaceAll(/[^A-Za-z0-9._-]/gu, '-');
    if (!sanitized)
        throw new TypeError('Compaction id is required.');
    const normalized = /^[A-Za-z0-9]/u.test(sanitized) ? sanitized : `c${sanitized}`;
    return normalized.slice(0, 120);
}
/** The `replacementId` that asks a replacement to archive the history it replaces. */
export function replacementArchiveId(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        return undefined;
    const value = Reflect.get(metadata, 'replacementId');
    return typeof value === 'string' && value.trim() ? value : undefined;
}
/**
 * Lineage stored on the first record of each artifact: `history_artifact`, or an
 * in-message `archonCompaction` marker (schema 2; a legacy schema 1 summary is a
 * root). Each parent pointer must name the previous generation, so every
 * compaction advances the generation and archives its pre-image.
 */
export const historyArtifactCodec = {
    storedGeneration: storedHistoryGeneration,
    parentOf(records, claimed) {
        const generation = claimed ?? storedHistoryGeneration(records);
        const marker = readGenerationMarker(records, generation);
        if (generation === 0)
            return undefined;
        if (!marker)
            throw new HistoryLineageError('invalid-generation-marker');
        const parent = marker.parentSnapshot;
        if (parent.generation !== generation - 1)
            throw new HistoryLineageError('parent-mismatch');
        const pointer = {
            compactionId: parent.compactionId,
            generation: parent.generation,
            revision: parent.revision,
        };
        return pointer;
    },
    archiveEntry: ({ compactionId, generation }) => ({ compactionId, generation }),
};
/** Strict generation of an artifact; a malformed marker fails closed. */
export function storedHistoryGeneration(records) {
    const artifact = records[0]?.history_artifact;
    if (artifact !== undefined)
        return artifact.generation;
    const value = inMessageMarker(records);
    if (value === undefined)
        return 0;
    if (isLegacyCompactionMarker(value))
        return 0;
    if (!isRecord(value) ||
        value['schemaVersion'] !== 2 ||
        typeof value['generation'] !== 'number' ||
        !Number.isInteger(value['generation']) ||
        value['generation'] < 1)
        throw new HistoryLineageError('invalid-generation-marker');
    return value['generation'];
}
function readGenerationMarker(records, generation) {
    const artifact = records[0]?.history_artifact;
    if (artifact !== undefined) {
        if (artifact.generation !== generation) {
            throw new HistoryLineageError('invalid-generation-marker');
        }
        return artifact;
    }
    const value = inMessageMarker(records);
    if (value === undefined) {
        if (generation > 0)
            throw new HistoryLineageError('invalid-generation-marker');
        return undefined;
    }
    if (isLegacyCompactionMarker(value)) {
        if (generation > 0 || records[0]?.message.role !== 'user') {
            throw new HistoryLineageError('invalid-generation-marker');
        }
        return undefined;
    }
    if (!isMarker(value, generation) || records[0]?.message.role !== 'user') {
        throw new HistoryLineageError('invalid-generation-marker');
    }
    return value;
}
function inMessageMarker(records) {
    const message = records[0]?.message;
    return message ? Reflect.get(message, 'archonCompaction') : undefined;
}
function isMarker(value, generation) {
    if (!isRecord(value) || value['schemaVersion'] !== 2 || value['generation'] !== generation) {
        return false;
    }
    const parent = value['parentSnapshot'];
    return (isRecord(parent) &&
        isNonNegativeInteger(parent['generation']) &&
        typeof parent['compactionId'] === 'string' &&
        parent['compactionId'].length > 0 &&
        typeof parent['revision'] === 'string' &&
        REVISION.test(parent['revision']));
}
function isLegacyCompactionMarker(value) {
    return isRecord(value) && value['schemaVersion'] === 1 && typeof value['summary'] === 'string';
}
function isNonNegativeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=generation-marker.js.map