import { randomUUID } from 'node:crypto';
import { chmod, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION } from './workspace-indexing-types.js';
export const WORKSPACE_SEMANTIC_INDEX_METADATA_FILE_NAME = 'metadata.json';
export const MAX_WORKSPACE_SEMANTIC_INDEX_DIMENSIONS = 8_192;
export async function readWorkspaceSemanticIndexPointer(pointerPath) {
    try {
        const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
        if (!hasPointerIdentity(pointer) || !hasPointerMetadata(pointer)) {
            return undefined;
        }
        return pointer;
    }
    catch {
        return undefined;
    }
}
function hasPointerIdentity(pointer) {
    return (pointer.schemaVersion === WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION &&
        [
            pointer.workspaceId,
            pointer.sessionId,
            pointer.revisionId,
            pointer.rootHash,
            pointer.embeddingModel,
        ].every((value) => typeof value === 'string' && value.length > 0) &&
        [pointer.revisionSequence, pointer.capturedAtMs, pointer.updatedAtMs].every((value) => Number.isSafeInteger(value) && value >= 0));
}
function hasPointerMetadata(pointer) {
    return (Number.isSafeInteger(pointer.dimensions) &&
        pointer.dimensions > 0 &&
        pointer.dimensions <= MAX_WORKSPACE_SEMANTIC_INDEX_DIMENSIONS &&
        pointer.normalization === 'l2' &&
        typeof pointer.archiveSha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(pointer.archiveSha256) &&
        Number.isSafeInteger(pointer.archiveSizeBytes) &&
        pointer.archiveSizeBytes > 0);
}
export function compareWorkspaceSemanticIndexPointers(left, right) {
    if (left.sessionId === right.sessionId && left.revisionSequence !== right.revisionSequence) {
        return left.revisionSequence < right.revisionSequence ? -1 : 1;
    }
    if (left.capturedAtMs !== right.capturedAtMs) {
        return left.capturedAtMs < right.capturedAtMs ? -1 : 1;
    }
    const leftId = `${left.sessionId}\0${left.revisionId}`;
    const rightId = `${right.sessionId}\0${right.revisionId}`;
    if (leftId === rightId)
        return 0;
    return leftId < rightId ? -1 : 1;
}
export async function writeWorkspaceSemanticIndexPointer(pointerPath, pointer) {
    const temporaryPointerPath = path.join(path.dirname(pointerPath), `.current-tmp-${randomUUID()}.json`);
    try {
        await writeFile(temporaryPointerPath, `${JSON.stringify(pointer, null, 2)}\n`, {
            mode: 0o600,
        });
        await chmod(temporaryPointerPath, 0o600);
        await rename(temporaryPointerPath, pointerPath);
    }
    finally {
        await rm(temporaryPointerPath, { force: true });
    }
}
export async function findNewestWorkspaceSemanticIndexPointer(input) {
    let entries;
    try {
        entries = await readdir(input.indexesRoot, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    let newest;
    for (const entry of entries) {
        if (!entry.isDirectory() ||
            entry.name.startsWith('.') ||
            input.excludedRevisionIds.has(entry.name)) {
            continue;
        }
        const pointer = await readRevisionPointer(input, entry.name);
        if (!pointer)
            continue;
        if (!newest || compareWorkspaceSemanticIndexPointers(newest, pointer) < 0)
            newest = pointer;
    }
    return newest;
}
async function readRevisionPointer(input, revisionId) {
    const revisionRoot = path.join(input.indexesRoot, revisionId);
    const pointer = await readWorkspaceSemanticIndexPointer(path.join(revisionRoot, WORKSPACE_SEMANTIC_INDEX_METADATA_FILE_NAME));
    if (!pointer ||
        pointer.workspaceId !== input.workspaceId ||
        pointer.revisionId !== revisionId ||
        !(await isRegularFile(path.join(revisionRoot, 'semantic-index.zip'))))
        return undefined;
    return pointer;
}
async function isRegularFile(filePath) {
    try {
        return (await stat(filePath)).isFile();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=workspace-indexing-semantic-index-pointer.js.map