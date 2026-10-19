import { basename } from 'node:path';
import { captureGitChangesBase, classifyWorkspacePathsIgnored, enrichGitChanges, getDefaultBranch, getGitBranches, listRecentGitBranches, searchGitBranches, getGitMetadata, isGitRepo, } from './operations/changes.js';
import { getWorkspaceDiffContext, getWorkspaceFileDiff, listWorkspaceFileDiffs, } from './operations/diffs.js';
import { applyFileChangeAction, checkoutBranch, commit, commitAndPush, createBranch, push, saveWorkspaceFile, } from './operations/mutations.js';
import { listWorkspaceGitWorktrees } from './operations/worktrees.js';
import { getWorkspaceReviewFileContent, getWorkspaceReviewSummary, listWorkspaceReviewCommits, listWorkspaceReviewFileDiffs, searchWorkspaceReviewDiffs, } from './operations/review.js';
import { WorkspaceReviewSearchIndexCache } from './operations/review-search.js';
import { WorkspaceGitGraphReader } from './operations/graph.js';
import { normalizeWorkspacePath } from './operations/workspace-identity.js';
import { WorkspaceGitSnapshotManager } from './snapshot/snapshot-manager.js';
import { createWorkspaceGitWatcher } from './snapshot/watcher.js';
export class WorkspaceGitService {
    manager;
    reviewSearchCache = new WorkspaceReviewSearchIndexCache();
    graphReader = new WorkspaceGitGraphReader();
    projectedChanges = new WeakMap();
    projectedMetadata = new WeakMap();
    constructor(options = {}) {
        this.manager = new WorkspaceGitSnapshotManager({
            loadBase: captureGitChangesBase,
            loadFull: enrichGitChanges,
            loadMetadata: getGitMetadata,
            ...(options.watchWorkspace !== false
                ? {
                    changeNotificationWindowMs: 250,
                    startWatcher: (workspace, callbacks) => createWorkspaceGitWatcher({
                        workspace,
                        callbacks,
                        classifyIgnored: (paths) => classifyWorkspacePathsIgnored(workspace, paths),
                    }),
                }
                : {}),
            ...(options.publishChanged ? { onChanged: options.publishChanged } : {}),
            ...(options.instanceId ? { instanceId: options.instanceId } : {}),
            ...(options.maxWorkspaces ? { maxWorkspaces: options.maxWorkspaces } : {}),
        });
    }
    async getChanges(workspace, mode) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        if (mode === 'fast') {
            const snapshot = await this.manager.getChanges(identity, 'fast');
            return this.projectChanges(snapshot.snapshotId, snapshot.value.changes);
        }
        const snapshot = await this.manager.getChanges(identity, 'full');
        return this.projectChanges(snapshot.snapshotId, snapshot.value);
    }
    async getMetadata(workspace) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        const snapshot = await this.manager.getMetadata(identity);
        const cached = this.projectedMetadata.get(snapshot.value);
        if (cached?.snapshotId === snapshot.snapshotId)
            return cached;
        const result = { snapshotId: snapshot.snapshotId, ...snapshot.value };
        this.projectedMetadata.set(snapshot.value, result);
        return result;
    }
    async probe(workspace) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        await this.manager.observeWorkspace(identity);
        return { isGitRepo: await isGitRepo(identity) };
    }
    async suggestCommitMessage(workspace) {
        const changes = await this.getChanges(workspace, 'full');
        if (!changes.isGitRepo)
            throw new Error('Not a git repository');
        const first = changes.files[0];
        if (!first)
            throw new Error('No changes to summarize');
        let action = 'update';
        if (first.status === 'added')
            action = 'add';
        else if (first.status === 'deleted')
            action = 'remove';
        return `chore: ${action} ${basename(first.path)}`;
    }
    async getBranches(workspace, includeRemote = false) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        return getGitBranches(identity, includeRemote);
    }
    async listRecentBranches(workspace, limit, signal) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        return listRecentGitBranches(identity, limit, signal);
    }
    async searchBranches(workspace, query, options = {}) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        return searchGitBranches(identity, query, options);
    }
    async getDefaultBranch(workspace) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        return getDefaultBranch(identity);
    }
    async getBranchPicker(workspace) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        const [branches, worktrees] = await Promise.all([
            getGitBranches(identity, false),
            listWorkspaceGitWorktrees(identity),
        ]);
        return { ...branches, worktrees: worktrees.worktrees };
    }
    async listWorktrees(workspace) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        return listWorkspaceGitWorktrees(identity);
    }
    async getFileDiff(workspace, filePath, options) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return getWorkspaceFileDiff(this.manager, identity, filePath, options);
    }
    async listFileDiffs(workspace, options) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return listWorkspaceFileDiffs(this.manager, identity, options);
    }
    async getDiffContext(workspace, filePath, options) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return getWorkspaceDiffContext(this.manager, identity, filePath, options);
    }
    async getFileStatus(workspace) {
        const changes = await this.getChanges(workspace, 'full');
        return changes.files.map((file) => ({
            path: file.path,
            ...(file.originalPath ? { originalPath: file.originalPath } : {}),
            added: file.additions,
            removed: file.deletions,
            status: file.status,
            ...(file.changeScope ? { changeScope: file.changeScope } : {}),
        }));
    }
    async getGraph(workspace, cursor, limit) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return this.graphReader.read(identity, cursor, limit);
    }
    async listReviewCommits(workspace, baseRef, query, limit) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return listWorkspaceReviewCommits(identity, baseRef, query, limit);
    }
    async getReviewSummary(workspace, source) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return getWorkspaceReviewSummary(this.manager, identity, source);
    }
    async listReviewFileDiffs(workspace, source, request) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return listWorkspaceReviewFileDiffs({
            manager: this.manager,
            workspace: identity,
            source,
            expectedSnapshotId: request.reviewSnapshotId,
            ...(request.fileIds ? { fileIds: request.fileIds } : {}),
        });
    }
    async getReviewFileContent(workspace, source, request) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return getWorkspaceReviewFileContent({
            manager: this.manager,
            workspace: identity,
            source,
            expectedSnapshotId: request.reviewSnapshotId,
            targetFileId: request.fileId,
            side: request.side,
        });
    }
    async searchReviewDiffs(workspace, source, request) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return searchWorkspaceReviewDiffs({
            manager: this.manager,
            workspace: identity,
            source,
            expectedSnapshotId: request.reviewSnapshotId,
            query: request.query,
            includeUntrackedFiles: request.includeUntrackedFiles,
            pageIndex: request.pageIndex ?? 0,
            pageSize: request.pageSize ?? 10,
            cache: this.reviewSearchCache,
            ...(request.signal ? { signal: request.signal } : {}),
        });
    }
    async saveFile(workspace, filePath, content) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return saveWorkspaceFile(this.manager, identity, filePath, content);
    }
    async checkout(workspace, branch) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return checkoutBranch(this.manager, identity, branch);
    }
    async createBranch(workspace, branch) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return createBranch(this.manager, identity, branch);
    }
    async commit(workspace, message, includeUnstaged) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return commit(this.manager, identity, message, includeUnstaged);
    }
    async commitAndPush(workspace, message, includeUnstaged) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return commitAndPush(this.manager, identity, message, includeUnstaged);
    }
    async push(workspace) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return push(this.manager, identity);
    }
    async applyFileChangeAction(workspace, action, paths, scope) {
        const identity = await this.resolveSnapshotIdentity(workspace);
        return applyFileChangeAction(this.manager, identity, { action, paths, scope });
    }
    async invalidate(workspace, kind = 'repository') {
        const identity = await this.resolveSnapshotIdentity(workspace);
        this.reviewSearchCache.clear();
        return this.manager.invalidate(identity, { kind, reason: 'manual' });
    }
    invalidateAll() {
        this.reviewSearchCache.clear();
        this.manager.invalidateAll('manual');
    }
    async releaseWorkspace(workspace) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        this.graphReader.release(identity);
        this.reviewSearchCache.clear();
        return this.manager.releaseWorkspace(identity);
    }
    resolveWorkspaceIdentity(workspace) {
        return normalizeWorkspacePath(workspace);
    }
    close() {
        this.graphReader.clear();
        this.reviewSearchCache.clear();
        this.manager.close();
    }
    async resolveSnapshotIdentity(workspace) {
        const identity = await this.resolveWorkspaceIdentity(workspace);
        this.manager.registerWorkspaceAlias(identity, workspace);
        return identity;
    }
    projectChanges(snapshotId, value) {
        const cached = this.projectedChanges.get(value);
        if (cached?.snapshotId === snapshotId)
            return cached;
        const result = { snapshotId, ...value };
        this.projectedChanges.set(value, result);
        return result;
    }
}
//# sourceMappingURL=workspace-git.service.js.map