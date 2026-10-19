import { randomUUID } from 'node:crypto';
import { readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
export class WorkspaceSemanticIndexDirectoryRollbackError extends AggregateError {
    constructor(errors) {
        super(errors, 'workspace_semantic_index_directory_publish_rollback_failed');
        this.name = 'WorkspaceSemanticIndexDirectoryRollbackError';
    }
}
export async function beginWorkspaceSemanticIndexDirectorySwap(input) {
    const movePath = input.movePath ?? moveSemanticIndexPathWithRetry;
    const removeDirectory = input.removeDirectory ?? ((directory) => rm(directory, { recursive: true, force: true }));
    await removeStaleRevisionBackups(input.indexesRoot, input.liveDirectory, removeDirectory);
    const backupPrefix = workspaceSemanticIndexBackupPrefix(input.liveDirectory);
    const backupDirectory = path.join(input.indexesRoot, `${backupPrefix}${randomUUID()}`);
    let hasBackup = false;
    try {
        await movePath(input.liveDirectory, backupDirectory);
        hasBackup = true;
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    try {
        await movePath(input.stagedDirectory, input.liveDirectory);
    }
    catch (publishError) {
        if (!hasBackup)
            throw publishError;
        try {
            await movePath(backupDirectory, input.liveDirectory);
        }
        catch (rollbackError) {
            throw new WorkspaceSemanticIndexDirectoryRollbackError([publishError, rollbackError]);
        }
        throw publishError;
    }
    return {
        async commit() {
            if (hasBackup) {
                await removeDirectory(backupDirectory);
                hasBackup = false;
            }
        },
        async rollback() {
            await removeDirectory(input.liveDirectory);
            if (hasBackup) {
                await movePath(backupDirectory, input.liveDirectory);
                hasBackup = false;
            }
        },
    };
}
async function removeStaleRevisionBackups(indexesRoot, liveDirectory, removeDirectory) {
    const prefix = workspaceSemanticIndexBackupPrefix(liveDirectory);
    let entries;
    try {
        entries = await readdir(indexesRoot, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    for (const entry of entries) {
        if (entry.name.startsWith(prefix)) {
            await removeDirectory(path.join(indexesRoot, entry.name));
        }
    }
}
function workspaceSemanticIndexBackupPrefix(liveDirectory) {
    const revisionId = path.basename(liveDirectory);
    return `.index-backup-${revisionId.length}-${revisionId}-`;
}
export async function moveSemanticIndexPathWithRetry(sourcePath, targetPath, maxRetries = 3) {
    for (let attempt = 0;; attempt += 1) {
        try {
            await rename(sourcePath, targetPath);
            return;
        }
        catch (error) {
            const code = error.code;
            if ((code === 'EPERM' || code === 'EACCES') && attempt < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
}
//# sourceMappingURL=semantic-index-directory.js.map