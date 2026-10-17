import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspaceIndexingPaths } from './paths.js';
import { KeyedOperationQueue } from './keyed-operation-queue.js';
import { beginWorkspaceSemanticIndexDirectorySwap, moveSemanticIndexPathWithRetry, WorkspaceSemanticIndexDirectoryRollbackError, } from './semantic-index-directory.js';
import { WorkspaceSemanticIndexCache } from './semantic-index-cache.js';
import { compareWorkspaceSemanticIndexPointers, findNewestWorkspaceSemanticIndexPointer, readWorkspaceSemanticIndexPointer, WORKSPACE_SEMANTIC_INDEX_METADATA_FILE_NAME, writeWorkspaceSemanticIndexPointer, } from './semantic-index-pointer.js';
import { WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION } from './types.js';
import { parseAndValidateSemanticIndex, sha256SemanticIndexArchive, validateSemanticIndexArchiveEnvelope, } from './semantic-index-validation.js';
const DEFAULT_MAX_CACHED_INDEXES = 2;
export { MAX_WORKSPACE_SEMANTIC_INDEX_ARCHIVE_BYTES } from './semantic-index-validation.js';
export class WorkspaceSemanticIndexStore {
    dataDir;
    nowMs;
    moveRevisionPath;
    removeRevisionDirectory;
    cache;
    workspaceOperations = new KeyedOperationQueue();
    constructor(options) {
        this.dataDir = options.dataDir;
        this.nowMs = options.nowMs ?? Date.now;
        this.moveRevisionPath = options.moveRevisionPath ?? moveSemanticIndexPathWithRetry;
        this.removeRevisionDirectory =
            options.removeRevisionDirectory ??
                ((directory) => rm(directory, { recursive: true, force: true }));
        this.cache = new WorkspaceSemanticIndexCache(options.maxCachedIndexes ?? DEFAULT_MAX_CACHED_INDEXES);
    }
    async createDownloadTarget(input) {
        const paths = resolveWorkspaceIndexingPaths({
            dataDir: this.dataDir,
            workspaceId: input.workspaceId,
            sessionId: 'semantic-index',
            revisionId: input.revisionId,
        });
        await mkdir(paths.indexesRoot, { recursive: true, mode: 0o700 });
        return path.join(paths.indexesRoot, `.index-download-${randomUUID()}.zip`);
    }
    async install(input) {
        if (!input.sessionId.trim() ||
            !Number.isSafeInteger(input.revisionSequence) ||
            input.revisionSequence < 0 ||
            !Number.isSafeInteger(input.capturedAtMs) ||
            input.capturedAtMs < 0) {
            throw new Error('workspace_semantic_index_pointer_metadata_invalid');
        }
        await validateSemanticIndexArchiveEnvelope(input);
        const actualSha256 = await sha256SemanticIndexArchive(input.archivePath);
        if (actualSha256 !== input.archiveSha256) {
            throw new Error('workspace_semantic_index_archive_hash_mismatch');
        }
        const index = await parseAndValidateSemanticIndex(input);
        const paths = resolveWorkspaceIndexingPaths({
            dataDir: this.dataDir,
            workspaceId: input.workspaceId,
            sessionId: 'semantic-index',
            revisionId: input.revisionId,
        });
        await mkdir(paths.indexesRoot, { recursive: true, mode: 0o700 });
        await mkdir(paths.workspaceRoot, { recursive: true, mode: 0o700 });
        const temporaryDir = path.join(paths.indexesRoot, `.index-tmp-${randomUUID()}`);
        const temporaryIndexPath = path.join(temporaryDir, 'semantic-index.zip');
        const temporaryMetadataPath = path.join(temporaryDir, WORKSPACE_SEMANTIC_INDEX_METADATA_FILE_NAME);
        const pointer = {
            schemaVersion: WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            revisionId: input.revisionId,
            revisionSequence: input.revisionSequence,
            capturedAtMs: input.capturedAtMs,
            rootHash: input.rootHash,
            embeddingModel: input.embeddingModel,
            dimensions: input.dimensions,
            normalization: input.normalization,
            archiveSha256: input.archiveSha256,
            archiveSizeBytes: input.archiveSizeBytes,
            updatedAtMs: this.nowMs(),
        };
        await mkdir(temporaryDir, { mode: 0o700 });
        let publishedAsCurrent = false;
        try {
            await moveSemanticIndexPathWithRetry(input.archivePath, temporaryIndexPath);
            await chmod(temporaryIndexPath, 0o600);
            await writeFile(temporaryMetadataPath, `${JSON.stringify(pointer, null, 2)}\n`, {
                mode: 0o600,
            });
            await chmod(temporaryMetadataPath, 0o600);
            publishedAsCurrent = await this.workspaceOperations.run(input.workspaceId, async () => {
                const previousPointer = await readWorkspaceSemanticIndexPointer(paths.currentPointerPath);
                let swap;
                try {
                    swap = await beginWorkspaceSemanticIndexDirectorySwap({
                        indexesRoot: paths.indexesRoot,
                        liveDirectory: paths.revisionIndexRoot,
                        stagedDirectory: temporaryDir,
                        movePath: this.moveRevisionPath,
                        removeDirectory: this.removeRevisionDirectory,
                    });
                }
                catch (error) {
                    if (error instanceof WorkspaceSemanticIndexDirectoryRollbackError) {
                        await this.reconcileCurrentPointer(input.workspaceId, paths, new Set());
                    }
                    throw error;
                }
                let published;
                try {
                    published = await this.publishCurrentPointer(paths.currentPointerPath, pointer);
                }
                catch (error) {
                    try {
                        await swap.rollback();
                        await this.restoreCurrentPointer(paths.currentPointerPath, previousPointer);
                    }
                    catch (rollbackError) {
                        await this.reconcileCurrentPointer(input.workspaceId, paths, new Set());
                        throw new AggregateError([error, rollbackError], 'workspace_semantic_index_publish_rollback_failed');
                    }
                    throw error;
                }
                await swap.commit();
                this.cache.deleteRevisions(input.workspaceId, new Set([input.revisionId]));
                this.cache.put(input, index);
                return published;
            });
        }
        catch (error) {
            await rm(temporaryDir, { recursive: true, force: true });
            throw error;
        }
        return {
            indexPath: paths.semanticIndexPath,
            pointerPath: paths.currentPointerPath,
            index,
            pointer,
            publishedAsCurrent,
        };
    }
    async loadCurrentCompatible(input) {
        const paths = resolveWorkspaceIndexingPaths({
            dataDir: this.dataDir,
            workspaceId: input.workspaceId,
            sessionId: 'semantic-index',
            revisionId: input.revisionId,
        });
        try {
            const pointer = await readWorkspaceSemanticIndexPointer(paths.currentPointerPath);
            if (!pointer ||
                pointer.schemaVersion !== WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION ||
                pointer.workspaceId !== input.workspaceId ||
                pointer.revisionId !== input.revisionId ||
                pointer.rootHash !== input.rootHash) {
                return undefined;
            }
            const index = await this.loadRevisionCompatible({
                workspaceId: input.workspaceId,
                revisionId: input.revisionId,
                rootHash: input.rootHash,
                archiveSha256: pointer.archiveSha256,
                archiveSizeBytes: pointer.archiveSizeBytes,
                embeddingModel: pointer.embeddingModel,
                dimensions: pointer.dimensions,
                normalization: pointer.normalization,
            });
            if (!index)
                return undefined;
            return {
                indexPath: paths.semanticIndexPath,
                pointerPath: paths.currentPointerPath,
                index,
                pointer,
                publishedAsCurrent: true,
            };
        }
        catch {
            return undefined;
        }
    }
    async loadRevisionCompatible(input) {
        const paths = resolveWorkspaceIndexingPaths({
            dataDir: this.dataDir,
            workspaceId: input.workspaceId,
            sessionId: 'semantic-index',
            revisionId: input.revisionId,
        });
        return this.workspaceOperations.run(input.workspaceId, async () => {
            try {
                return await this.cache.getOrLoad(input, async () => {
                    const validationInput = { ...input, archivePath: paths.semanticIndexPath };
                    await validateSemanticIndexArchiveEnvelope(validationInput);
                    if ((await sha256SemanticIndexArchive(paths.semanticIndexPath)) !== input.archiveSha256) {
                        throw new Error('workspace_semantic_index_archive_hash_mismatch');
                    }
                    return parseAndValidateSemanticIndex(validationInput);
                });
            }
            catch {
                return undefined;
            }
        });
    }
    async deleteRevisions(input) {
        const revisionIds = new Set(input.revisionIds);
        if (revisionIds.size === 0)
            return;
        const paths = resolveWorkspaceIndexingPaths({
            dataDir: this.dataDir,
            workspaceId: input.workspaceId,
            sessionId: 'semantic-index',
            revisionId: input.revisionIds[0] ?? 'none',
        });
        await this.workspaceOperations.run(input.workspaceId, async () => {
            this.cache.deleteRevisions(input.workspaceId, revisionIds);
            await this.reconcileCurrentPointer(input.workspaceId, paths, revisionIds);
            try {
                for (const revisionId of revisionIds) {
                    const revisionPaths = resolveWorkspaceIndexingPaths({
                        dataDir: this.dataDir,
                        workspaceId: input.workspaceId,
                        sessionId: 'semantic-index',
                        revisionId,
                    });
                    await this.removeRevisionDirectory(revisionPaths.revisionIndexRoot);
                }
            }
            catch (error) {
                await this.reconcileCurrentPointer(input.workspaceId, paths, new Set());
                throw error;
            }
        });
    }
    async publishCurrentPointer(pointerPath, pointer) {
        const current = await readWorkspaceSemanticIndexPointer(pointerPath);
        if (current &&
            current.workspaceId === pointer.workspaceId &&
            current.revisionId !== pointer.revisionId &&
            compareWorkspaceSemanticIndexPointers(current, pointer) >= 0) {
            return false;
        }
        await writeWorkspaceSemanticIndexPointer(pointerPath, pointer);
        return true;
    }
    async restoreCurrentPointer(pointerPath, pointer) {
        if (pointer) {
            await writeWorkspaceSemanticIndexPointer(pointerPath, pointer);
        }
        else {
            await rm(pointerPath, { force: true });
        }
    }
    async reconcileCurrentPointer(workspaceId, paths, excludedRevisionIds) {
        const remaining = await findNewestWorkspaceSemanticIndexPointer({
            workspaceId,
            indexesRoot: paths.indexesRoot,
            excludedRevisionIds,
        });
        if (remaining) {
            await writeWorkspaceSemanticIndexPointer(paths.currentPointerPath, {
                ...remaining,
                updatedAtMs: this.nowMs(),
            });
        }
        else {
            await rm(paths.currentPointerPath, { force: true });
        }
    }
}
//# sourceMappingURL=semantic-index-store.js.map