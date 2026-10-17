import { join } from 'node:path';
import { canonicalActiveHistoryRevision, } from '../../../sessions/representation/canonical-history-contract.js';
import { safeHistoryPathSegment } from '../session-history-paths.js';
export function historyMutationStagingPaths(paths, operationId) {
    const sessionDir = join(paths.sessionDir, `.history-mutation-${safeHistoryPathSegment(operationId)}`);
    return {
        ...paths,
        sessionDir,
        manifest: join(sessionDir, 'manifest.json'),
        messages: join(sessionDir, 'messages.jsonl'),
        snapshots: join(sessionDir, 'snapshots'),
        reports: join(sessionDir, 'reports'),
    };
}
export function toHistoryMutationStagingManifest(input) {
    return {
        schemaVersion: 1,
        kind: 'rewind',
        sessionId: input.sessionId,
        operationId: input.operationId,
        sourceGeneration: input.sourceGeneration ?? input.generation,
        generation: input.generation,
        sourceRevision: input.expectedRevision,
        targetRevision: canonicalActiveHistoryRevision(input.active),
        snapshots: input.snapshots.map(({ generation, fileName, revision }) => ({
            generation,
            fileName,
            revision,
        })),
        ...(input.operationData === undefined ? {} : { operationData: input.operationData }),
    };
}
export function decodeHistoryMutationStagingManifest(raw, expected) {
    const value = JSON.parse(raw);
    if (!isManifest(value, expected)) {
        throw new Error('Invalid history mutation staging manifest');
    }
    const snapshots = value.snapshots.map(decodeSnapshot);
    return {
        schemaVersion: 1,
        kind: 'rewind',
        sessionId: expected.sessionId,
        operationId: expected.operationId,
        sourceGeneration: value.sourceGeneration ?? value.generation,
        generation: value.generation,
        sourceRevision: value.sourceRevision,
        targetRevision: value.targetRevision,
        snapshots,
        ...(value.operationData === undefined ? {} : { operationData: value.operationData }),
    };
}
function isManifest(value, expected) {
    return isManifestIdentity(value, expected) && hasManifestPayload(value);
}
function isManifestIdentity(value, expected) {
    return (isRecord(value) &&
        value.schemaVersion === 1 &&
        value.kind === 'rewind' &&
        value.sessionId === expected.sessionId &&
        value.operationId === expected.operationId);
}
function hasManifestPayload(value) {
    return (typeof value.generation === 'number' &&
        Number.isSafeInteger(value.generation) &&
        (value.sourceGeneration === undefined ||
            (typeof value.sourceGeneration === 'number' &&
                Number.isSafeInteger(value.sourceGeneration) &&
                value.sourceGeneration >= 0)) &&
        typeof value.sourceRevision === 'string' &&
        typeof value.targetRevision === 'string' &&
        Array.isArray(value.snapshots));
}
function decodeSnapshot(value) {
    if (!isSnapshot(value))
        throw new Error('Invalid history mutation staging snapshot');
    return value;
}
function isSnapshot(value) {
    return (isRecord(value) &&
        typeof value.generation === 'number' &&
        Number.isSafeInteger(value.generation) &&
        typeof value.fileName === 'string' &&
        typeof value.revision === 'string');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=session-history-staging.js.map