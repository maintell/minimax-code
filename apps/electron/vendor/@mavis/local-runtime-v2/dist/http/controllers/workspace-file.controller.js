// Scaffolded by @mavis/thrift-gen — this file is yours after generation; edit freely.
// Regeneration never overwrites an existing controller file.
import { HTTPException } from 'hono/http-exception';
import { WorkspaceFileControllerBase } from '../generated/workspace-file-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
import { WorkspaceGitGraphError, WorkspaceGitCommandError, WorkspaceReviewSearchTooLargeError, WorkspaceGitSnapshotChangedError, } from '../../service/workspace/index.js';
class WorkspaceFileController extends WorkspaceFileControllerBase {
    services;
    constructor(services = {}) {
        super();
        this.services = services;
    }
    async listWorkspaceFileTree(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listWorkspaceFileTree');
    }
    async readWorkspaceFile(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('readWorkspaceFile');
    }
    async saveWorkspaceFile(ctx, req) {
        void ctx;
        try {
            await this.requireWorkspaceGit().saveFile(req.workspace, req.path, req.content);
            return { ok: true };
        }
        catch (error) {
            throw new AppError(422, 'FILE_SAVE_FAILED', describeError(error));
        }
    }
    async searchWorkspaceFiles(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('searchWorkspaceFiles');
    }
    async previewWorkspaceFile(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('previewWorkspaceFile');
    }
    async getWorkspaceFileDiff(ctx, req) {
        void ctx;
        return this.mapSnapshotError(() => this.requireWorkspaceGit().getFileDiff(req.workspace, req.path, {
            ...(req.scope ? { scope: readScope(req.scope) } : {}),
            ...(req.snapshotId ? { snapshotId: req.snapshotId } : {}),
            ...(req.lean !== undefined ? { lean: req.lean } : {}),
        }));
    }
    async listWorkspaceFileDiffs(ctx, req) {
        void ctx;
        const snapshot = await this.mapSnapshotError(() => this.requireWorkspaceGit().listFileDiffs(req.workspace, {
            ...(req.scope ? { scope: readScope(req.scope) } : {}),
            ...(req.snapshotId ? { snapshotId: req.snapshotId } : {}),
        }));
        return { snapshotId: snapshot.snapshotId, diffs: snapshot.diffs };
    }
    async getWorkspaceDiffContext(ctx, req) {
        void ctx;
        const context = await this.mapSnapshotError(() => this.requireWorkspaceGit().getDiffContext(req.workspace, req.path, {
            ...(req.scope ? { scope: readScope(req.scope) } : {}),
            ...(req.snapshotId ? { snapshotId: req.snapshotId } : {}),
        }));
        if (!context) {
            throw new AppError(422, 'DIFF_CONTEXT_UNAVAILABLE', 'Diff context is not available');
        }
        return context;
    }
    async getWorkspaceFileStatus(ctx, req) {
        void ctx;
        return { files: await this.requireWorkspaceGit().getFileStatus(req.workspace) };
    }
    async getWorkspaceGitGraph(_ctx, req) {
        try {
            return await this.requireWorkspaceGit().getGraph(req.workspace, req.cursor, req.limit);
        }
        catch (error) {
            if (error instanceof WorkspaceGitGraphError) {
                const status = {
                    GRAPH_EXPIRED: 409,
                    INVALID_GRAPH_REQUEST: 400,
                    GRAPH_UNAVAILABLE: 422,
                };
                throw new AppError(status[error.code], error.code, error.message);
            }
            throw error;
        }
    }
    async listWorkspaceReviewCommits(ctx, req) {
        void ctx;
        const limit = readReviewCommitLimit(req.limit);
        return this.mapReviewError(() => this.requireWorkspaceGit().listReviewCommits(req.workspace, req.baseRef, req.query, limit));
    }
    async getWorkspaceReviewSummary(ctx, req) {
        void ctx;
        return this.mapReviewError(() => this.requireWorkspaceGit().getReviewSummary(req.workspace, readReviewSource(req.source)));
    }
    async listWorkspaceReviewFileDiffs(ctx, req) {
        void ctx;
        if (req.fileIds && req.fileIds.length > 10) {
            throw new AppError(400, 'REVIEW_BATCH_TOO_LARGE', 'Review batches are limited to 10 files');
        }
        return this.mapReviewError(() => this.requireWorkspaceGit().listReviewFileDiffs(req.workspace, readReviewSource(req.source), {
            reviewSnapshotId: req.reviewSnapshotId,
            ...(req.fileIds ? { fileIds: req.fileIds } : {}),
        }));
    }
    async getWorkspaceReviewFileContent(ctx, req) {
        void ctx;
        return this.mapReviewError(() => this.requireWorkspaceGit().getReviewFileContent(req.workspace, readReviewSource(req.source), {
            reviewSnapshotId: req.reviewSnapshotId,
            fileId: req.fileId,
            side: readReviewSide(req.side),
        }));
    }
    async searchWorkspaceReviewDiffs(ctx, req) {
        const query = req.query.trim();
        if (!query) {
            throw new AppError(400, 'REVIEW_SEARCH_QUERY_REQUIRED', 'Review search query is required');
        }
        if (query.length > 500) {
            throw new AppError(400, 'REVIEW_SEARCH_QUERY_TOO_LONG', 'Review search query is too long');
        }
        const pageIndex = req.pageIndex ?? 0;
        const pageSize = req.pageSize ?? 10;
        if (!Number.isInteger(pageIndex) || pageIndex < 0) {
            throw new AppError(400, 'REVIEW_SEARCH_PAGE_INVALID', 'Review search page is invalid');
        }
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10) {
            throw new AppError(400, 'REVIEW_SEARCH_PAGE_SIZE_INVALID', 'Review search page size is invalid');
        }
        return this.mapReviewError(() => this.requireWorkspaceGit().searchReviewDiffs(req.workspace, readReviewSource(req.source), {
            reviewSnapshotId: req.reviewSnapshotId,
            query,
            includeUntrackedFiles: req.includeUntrackedFiles !== false,
            pageIndex,
            pageSize,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
        }));
    }
    async openWorkspaceApp(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('openWorkspaceApp');
    }
    async listIdeApps(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listIdeApps');
    }
    async openWorkspaceFile(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('openWorkspaceFile');
    }
    async revealWorkspaceFile(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('revealWorkspaceFile');
    }
    async openWorkspaceFileInIde(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('openWorkspaceFileInIde');
    }
    async suggestCommitMessage(ctx, req) {
        void ctx;
        try {
            return { message: await this.requireWorkspaceGit().suggestCommitMessage(req.workspace) };
        }
        catch (error) {
            return { error: describeError(error) };
        }
    }
    async probeWorkspaceGit(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().probe(req.workspace);
    }
    async getWorkspaceGitChanges(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().getChanges(req.workspace, readMode(req.mode));
    }
    async getWorkspaceGitMetadata(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().getMetadata(req.workspace);
    }
    async getWorkspaceGitBranches(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().getBranches(req.workspace, req.includeRemote === true);
    }
    async listWorkspaceRecentBranches(ctx, req) {
        return this.requireWorkspaceGit().listRecentBranches(req.workspace, readBranchLimit(req.limit, 100, 'RECENT_BRANCH_LIMIT_INVALID'), ctx.signal);
    }
    async searchWorkspaceGitBranches(ctx, req) {
        const query = req.query.trim();
        if (!query) {
            throw new AppError(400, 'BRANCH_SEARCH_QUERY_REQUIRED', 'Branch search query is required');
        }
        if (query.length > 200) {
            throw new AppError(400, 'BRANCH_SEARCH_QUERY_TOO_LONG', 'Branch search query is too long');
        }
        return this.requireWorkspaceGit().searchBranches(req.workspace, query, {
            limit: readBranchLimit(req.limit, 20, 'BRANCH_SEARCH_LIMIT_INVALID'),
            includeRemote: req.includeRemote !== false,
            signal: ctx.signal,
        });
    }
    async getWorkspaceGitBranchPicker(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().getBranchPicker(req.workspace);
    }
    async getWorkspaceGitDefaultBranch(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().getDefaultBranch(req.workspace);
    }
    async checkoutWorkspaceGitBranch(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().checkout(req.workspace, req.branch);
    }
    async createWorkspaceGitBranch(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().createBranch(req.workspace, req.branch);
    }
    async commitWorkspaceGit(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().commit(req.workspace, req.message, req.includeUnstaged);
    }
    async commitAndPushWorkspaceGit(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().commitAndPush(req.workspace, req.message, req.includeUnstaged);
    }
    async pushWorkspaceGit(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().push(req.workspace);
    }
    async applyWorkspaceGitChangeAction(ctx, req) {
        void ctx;
        const paths = resolveChangeActionPaths(req);
        if (paths.length === 0) {
            throw new AppError(400, 'GIT_PATHS_REQUIRED', 'At least one Git path is required');
        }
        return this.requireWorkspaceGit().applyFileChangeAction(req.workspace, readAction(req.action), paths, req.scope ? readScope(req.scope) : undefined);
    }
    async invalidateWorkspaceGitSnapshot(ctx, req) {
        void ctx;
        return {
            success: true,
            snapshotId: await this.requireWorkspaceGit().invalidate(req.workspace, req.kind === 'workspace' ? 'workspace' : 'repository'),
        };
    }
    async invalidateAllWorkspaceGitSnapshots(ctx, _req) {
        void ctx;
        this.requireWorkspaceGit().invalidateAll();
        return { success: true };
    }
    async listWorkspaceGitWorktrees(ctx, req) {
        void ctx;
        return this.requireWorkspaceGit().listWorktrees(req.workspace);
    }
    async createWorkspaceGitWorktree(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('createWorkspaceGitWorktree');
    }
    async removeWorkspaceGitWorktree(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('removeWorkspaceGitWorktree');
    }
    async listManagedWorkspaceGitWorktrees(_ctx, req) {
        return this.requireManagedWorktrees().list(req.workspace);
    }
    async removeManagedWorkspaceGitWorktree(_ctx, req) {
        const workspaceIdentity = this.services.workspaceGit
            ? await this.services.workspaceGit.resolveWorkspaceIdentity(req.worktreeDir)
            : req.worktreeDir;
        const result = await this.requireManagedWorktrees().remove(req.workspace, req.worktreeDir, req.activeWorktreeDir);
        if (result.status >= 400)
            throw managedWorktreeRemovalError(result);
        await this.services.workspaceGit?.releaseWorkspace(workspaceIdentity);
        return result.body;
    }
    async removeManagedWorkspaceGitWorktreesBatch(_ctx, req) {
        if (req.items.length === 0) {
            throw new AppError(400, 'WORKTREE_ITEMS_REQUIRED', 'At least one worktree item is required');
        }
        const identities = new Map(await Promise.all(req.items.map(async (item) => [
            item.worktreeDir,
            this.services.workspaceGit
                ? await this.services.workspaceGit.resolveWorkspaceIdentity(item.worktreeDir)
                : item.worktreeDir,
        ])));
        const result = await this.requireManagedWorktrees().removeBatch(req.items, req.activeWorktreeDir);
        for (const workspace of result.removedPaths) {
            await this.services.workspaceGit?.releaseWorkspace(identities.get(workspace) ?? workspace);
        }
        return result;
    }
    requireManagedWorktrees() {
        if (this.services.managedWorktrees)
            return this.services.managedWorktrees;
        throw new AppError(503, 'WORKTREE_UNAVAILABLE', 'Managed worktree service is not available');
    }
    requireWorkspaceGit() {
        if (this.services.workspaceGit)
            return this.services.workspaceGit;
        throw new AppError(503, 'WORKSPACE_GIT_UNAVAILABLE', 'Workspace Git service is not available');
    }
    async mapSnapshotError(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof WorkspaceGitSnapshotChangedError) {
                throw workspaceGitSnapshotChangedError(error.snapshotId);
            }
            if (error instanceof WorkspaceGitCommandError) {
                throw new AppError(422, 'WORKSPACE_GIT_COMMAND_FAILED', error.message);
            }
            throw error;
        }
    }
    async mapReviewError(operation) {
        try {
            return await this.mapSnapshotError(operation);
        }
        catch (error) {
            if (error instanceof WorkspaceReviewSearchTooLargeError) {
                throw new AppError(422, 'REVIEW_SEARCH_TOO_LARGE', 'Review search exceeded its safe in-memory index budget');
            }
            if (error instanceof AppError || (error instanceof Error && error.name === 'AbortError')) {
                throw error;
            }
            throw new AppError(422, 'WORKSPACE_REVIEW_RESOLUTION_FAILED', describeError(error));
        }
    }
    async listFsDirs(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('listFsDirs');
    }
    async getFsGitInfo(ctx, req) {
        void ctx;
        void req;
        throw new NotImplementedError('getFsGitInfo');
    }
}
export const workspaceFileController = new WorkspaceFileController();
export function createWorkspaceFileController(services) {
    return new WorkspaceFileController(services);
}
function managedWorktreeRemovalError(result) {
    const body = result.body.reason ? { ...result.body, code: result.body.reason } : result.body;
    return new HTTPException(result.status, {
        res: new Response(JSON.stringify(body), {
            status: result.status,
            headers: { 'Content-Type': 'application/json' },
        }),
    });
}
function workspaceGitSnapshotChangedError(snapshotId) {
    return new HTTPException(409, {
        res: new Response(JSON.stringify({
            error: 'Workspace Git snapshot changed while content was being generated',
            code: 'GIT_SNAPSHOT_CHANGED',
            ...(snapshotId ? { snapshotId } : {}),
        }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    });
}
function readMode(value) {
    if (value === undefined || value === 'full')
        return 'full';
    if (value === 'fast')
        return 'fast';
    throw new AppError(400, 'GIT_CHANGES_MODE_INVALID', `Unsupported Git changes mode: ${value}`);
}
function readScope(value) {
    if (value === 'staged' || value === 'unstaged' || value === 'all')
        return value;
    throw new AppError(400, 'GIT_SCOPE_INVALID', `Unsupported Git scope: ${value}`);
}
function readAction(value) {
    if (value === 'stage' || value === 'unstage' || value === 'discard')
        return value;
    throw new AppError(400, 'GIT_ACTION_INVALID', `Unsupported Git action: ${value}`);
}
function readReviewSource(value) {
    if (value.type === 'workspace')
        return { type: 'workspace' };
    if (value.type === 'branch' && value.baseRef?.trim()) {
        return { type: 'branch', baseRef: value.baseRef.trim() };
    }
    if (value.type === 'commit' && value.baseRef?.trim() && value.commitSha?.trim()) {
        return {
            type: 'commit',
            baseRef: value.baseRef.trim(),
            commitSha: value.commitSha.trim(),
        };
    }
    throw new AppError(400, 'REVIEW_SOURCE_INVALID', 'Review source is incomplete or unsupported');
}
function readReviewSide(value) {
    if (value === 'old' || value === 'new')
        return value;
    throw new AppError(400, 'REVIEW_SIDE_INVALID', `Unsupported review side: ${value}`);
}
function readReviewCommitLimit(value) {
    if (value === undefined)
        return 10;
    if (Number.isInteger(value) && value >= 1 && value <= 50)
        return value;
    throw new AppError(400, 'REVIEW_COMMIT_LIMIT_INVALID', 'Review commit limit must be 1..50');
}
function readBranchLimit(value, maximum, code) {
    if (value === undefined)
        return maximum;
    if (Number.isInteger(value) && value >= 1 && value <= maximum)
        return value;
    throw new AppError(400, code, `Branch limit must be 1..${maximum}`);
}
function resolveChangeActionPaths(req) {
    if (req.paths && req.paths.length > 0)
        return req.paths;
    if (req.path && req.originalPath && req.path !== req.originalPath) {
        if (req.scope === 'staged')
            return [req.originalPath];
        if (req.scope === 'unstaged')
            return [req.path];
        return [req.originalPath, req.path];
    }
    return [req.path, req.originalPath].filter((value) => Boolean(value));
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=workspace-file.controller.js.map