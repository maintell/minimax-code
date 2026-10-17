import { randomUUID } from 'node:crypto';
import { chmod, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION } from './types.js';
export const WORKSPACE_SEMANTIC_INDEX_METADATA_FILE_NAME = 'metadata.json';
export const MAX_WORKSPACE_SEMANTIC_INDEX_DIMENSIONS = 8_192;
export async function readWorkspaceSemanticIndexPointer(pointerPath) {
    try {
        const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
        if (pointer.schemaVersion !== WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION ||
            typeof pointer.workspaceId !== 'string' ||
            !pointer.workspaceId ||
            typeof pointer.sessionId !== 'string' ||
            !pointer.sessionId ||
            typeof pointer.revisionId !== 'string' ||
            !pointer.revisionId ||
            !Number.isSafeInteger(pointer.revisionSequence) ||
            pointer.revisionSequence < 0 ||
            !Number.isSafeInteger(pointer.capturedAtMs) ||
            pointer.capturedAtMs < 0 ||
            typeof pointer.rootHash !== 'string' ||
            !pointer.rootHash ||
            typeof pointer.embeddingModel !== 'string' ||
            !pointer.embeddingModel ||
            !Number.isSafeInteger(pointer.dimensions) ||
            pointer.dimensions <= 0 ||
            pointer.dimensions > MAX_WORKSPACE_SEMANTIC_INDEX_DIMENSIONS ||
            pointer.normalization !== 'l2' ||
            typeof pointer.archiveSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/u.test(pointer.archiveSha256) ||
            !Number.isSafeInteger(pointer.archiveSizeBytes) ||
            pointer.archiveSizeBytes <= 0 ||
            !Number.isSafeInteger(pointer.updatedAtMs) ||
            pointer.updatedAtMs < 0) {
            return undefined;
        }
        return pointer;
    }
    catch {
        return undefined;
    }
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
    return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
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
        const revisionRoot = path.join(input.indexesRoot, entry.name);
        const pointer = await readWorkspaceSemanticIndexPointer(path.join(revisionRoot, WORKSPACE_SEMANTIC_INDEX_METADATA_FILE_NAME));
        if (!pointer ||
            pointer.workspaceId !== input.workspaceId ||
            pointer.revisionId !== entry.name ||
            !(await isRegularFile(path.join(revisionRoot, 'semantic-index.zip')))) {
            continue;
        }
        if (!newest || compareWorkspaceSemanticIndexPointers(newest, pointer) < 0)
            newest = pointer;
    }
    return newest;
}
async function isRegularFile(filePath) {
    try {
        return (await stat(filePath)).isFile();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=semantic-index-pointer.js.map