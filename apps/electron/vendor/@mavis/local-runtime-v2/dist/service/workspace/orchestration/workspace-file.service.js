import { DEFAULT_MAX_INLINE_FILE_BYTES, getFileSystemGitInfo, getWorkspaceFileMetadata, listFileSystemDirectories, listWorkspaceFileTree, previewWorkspaceFile, readWorkspaceFile, resolveWorkspaceFileWritePath, saveWorkspaceFile, searchWorkspaceFiles, } from '../operations/filesystem/files.js';
export class WorkspaceFileServiceImpl {
    options;
    maxInlineFileBytes;
    pendingSaves = new Map();
    constructor(options = {}) {
        this.options = options;
        const maxInlineFileBytes = options.maxInlineFileBytes;
        this.maxInlineFileBytes =
            Number.isSafeInteger(maxInlineFileBytes) && maxInlineFileBytes > 0
                ? maxInlineFileBytes
                : DEFAULT_MAX_INLINE_FILE_BYTES;
    }
    listFileTree(input) {
        return listWorkspaceFileTree(input);
    }
    getFileMetadata(workspace, filePath) {
        return getWorkspaceFileMetadata(workspace, filePath);
    }
    readFile(workspace, filePath, options) {
        return readWorkspaceFile(workspace, filePath, options, this.maxInlineFileBytes);
    }
    async saveFile(input) {
        const save = () => this.saveFileInOrder(input);
        return this.options.runFileMutation
            ? this.options.runFileMutation(input.workspace, save)
            : save();
    }
    async saveFileInOrder(input) {
        const target = await resolveWorkspaceFileWritePath(input.workspace, input.filePath);
        const previous = this.pendingSaves.get(target) ?? Promise.resolve();
        const saving = (async () => {
            try {
                await previous;
            }
            catch {
                // A rejected save must not block later writes to this file.
            }
            return saveWorkspaceFile(input);
        })();
        this.pendingSaves.set(target, saving);
        try {
            return await saving;
        }
        finally {
            if (this.pendingSaves.get(target) === saving)
                this.pendingSaves.delete(target);
        }
    }
    searchFiles(workspace, query, limit, includeDirectories) {
        return searchWorkspaceFiles(workspace, query, limit, includeDirectories);
    }
    previewFile(filePath) {
        return previewWorkspaceFile(filePath, this.maxInlineFileBytes);
    }
    listFsDirs(input) {
        return listFileSystemDirectories(input);
    }
    getFsGitInfo(path) {
        return getFileSystemGitInfo(path);
    }
    close() {
        // Pending writes release their own entries. Workspace Git owns watchers.
    }
}
//# sourceMappingURL=workspace-file.service.js.map