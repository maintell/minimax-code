import { encodeWorkspaceGitObservation, WORKSPACE_GIT_OBSERVATION_HEADER, } from '@mavis/shared/runtime-transport';
// Scaffolded by @mavis/thrift-gen — this file is yours after generation; edit freely.
// Regeneration never overwrites an existing controller file.
import { HTTPException } from 'hono/http-exception';
import { WorkspaceFileControllerBase } from '../generated/workspace-file-controller-base.gen.js';
import { AppError, NotImplementedError } from '../errors.js';
import { WorkspaceGitGraphError, WorkspaceGitCommandError, WorkspaceReviewSearchTooLargeError, WorkspaceGitSnapshotChangedError, WorkspaceLocalActionError, WorkspaceLocalActionsUnavailableError, WorkspaceFileError, } from '../../service/workspace/index.js';
class WorkspaceFileController extends WorkspaceFileControllerBase {
    services;
    constructor(services = {}) {
        super();
        this.services = services;
    }
    async listWorkspaceFileTree(ctx, req) {
        void ctx;
        // Per-entry metadata probed user files (including `.asar` archives that
        // Electron then keeps locked) and has no caller; reject it explicitly.
        if (req.includeMetadata)
            throw new NotImplementedError('listWorkspaceFileTree.includeMetadata');
        const service = this.requireWorkspaceFile();
        try {
            return await service.listFileTree(req);
        }
        catch (error) {
            throw mapWorkspaceFileError(error);
        }
    }
    async readWorkspaceFile(ctx, req) {
        void ctx;
        try {
            const options = {
                ...(req.offset !== undefined ? { offset: Number(req.offset) } : {}),
                ...(req.length !== undefined ? { length: Number(req.length) } : {}),
                ...(req.maxBytes !== undefined ? { maxBytes: Number(req.maxBytes) } : {}),
                ...(req.raw !== undefined ? { raw: req.raw } : {}),
            };
            const service = this.requireWorkspaceFile();
            return await (Object.keys(options).length > 0
                ? service.readFile(req.workspace, req.path, options)
                : service.readFile(req.workspace, req.path));
        }
        catch (error) {
            throw mapWorkspaceFileError(error);
        }
    }
    async saveWorkspaceFile(ctx, req) {
        void ctx;
        try {
            return await this.requireWorkspaceFile().saveFile({
                workspace: req.workspace,
                filePath: req.path,
                ...(req.content !== undefined ? { content: req.content } : {}),
                ...(req.contentBase64 !== undefined ? { contentBase64: req.contentBase64 } : {}),
                ...(req.encoding !== undefined ? { encoding: req.encoding } : {}),
                ...(req.expectedRevision !== undefined ? { expectedRevision: req.expectedRevision } : {}),
            });
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            if (error instanceof WorkspaceFileError)
                throw mapWorkspaceFileError(error);
            throw new AppError(422, 'FILE_SAVE_FAILED', describeError(error));
        }
    }
    async searchWorkspaceFiles(ctx, req) {
        void ctx;
        try {
            return {
                paths: await this.requireWorkspaceFile().searchFiles(req.workspace, req.query, req.limit, req.includeDirectories),
            };
        }
        catch (error) {
            throw mapWorkspaceFileError(error);
        }
    }
    async previewWorkspaceFile(ctx, req) {
        void ctx;
        try {
            return await this.requireWorkspaceFile().previewFile(req.path);
        }
        catch (error) {
            throw mapWorkspaceFileError(error);
        }
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
        try {
            await this.requireWorkspaceLocalActions('openWorkspaceApp').openApp({
                ...(req.workspace !== undefined ? { workspace: req.workspace } : {}),
                ...(req.path !== undefined ? { path: req.path } : {}),
            });
            return {};
        }
        catch (error) {
            throw mapWorkspaceLocalActionError(error, 'openWorkspaceApp');
        }
    }
    async listIdeApps(ctx, req) {
        void ctx;
        void req;
        try {
            return { apps: [...(await this.requireWorkspaceLocalActions('listIdeApps').listIdeApps())] };
        }
        catch (error) {
            throw mapWorkspaceLocalActionError(error, 'listIdeApps');
        }
    }
    async openWorkspaceFile(ctx, req) {
        void ctx;
        try {
            return await this.requireWorkspaceLocalActions('openWorkspaceFile').openFile({
                workspace: req.workspace,
                path: req.path,
            });
        }
        catch (error) {
            throw mapWorkspaceLocalActionError(error, 'openWorkspaceFile');
        }
    }
    async revealWorkspaceFile(ctx, req) {
        void ctx;
        try {
            return await this.requireWorkspaceLocalActions('revealWorkspaceFile').revealFile({
                workspace: req.workspace,
                path: req.path,
            });
        }
        catch (error) {
            throw mapWorkspaceLocalActionError(error, 'revealWorkspaceFile');
        }
    }
    async openWorkspaceFileInIde(ctx, req) {
        void ctx;
        try {
            return await this.requireWorkspaceLocalActions('openWorkspaceFileInIde').openFileInIde({
                ideId: req.ideId,
                ...(req.workspace !== undefined ? { workspace: req.workspace } : {}),
                ...(req.path !== undefined ? { path: req.path } : {}),
            });
        }
        catch (error) {
            throw mapWorkspaceLocalActionError(error, 'openWorkspaceFileInIde');
        }
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
        return this.requireWorkspaceGit().getChanges(req.workspace, readMode(req.mode), (observation) => {
            try {
                const encoded = encodeWorkspaceGitObservation(observation);
                if (encoded)
                    ctx.observationHeaders?.set(WORKSPACE_GIT_OBSERVATION_HEADER, encoded);
            }
            catch {
                /* A failed observation must not affect the Git response. */
            }
        });
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
        try {
            const { status, ...result } = await this.requireWorkspaceGit().createWorktree(req.workspace, req.options);
            if (status !== undefined && status >= 400) {
                throw new AppError(status, 'WORKTREE_CREATE_FAILED', result.error ?? 'Failed to create worktree');
            }
            return result;
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            throw new AppError(422, 'WORKTREE_CREATE_FAILED', describeError(error));
        }
    }
    async removeWorkspaceGitWorktree(ctx, req) {
        void ctx;
        const result = await this.requireWorkspaceGit().removeWorktree(req.workspace, req.worktreeDir);
        const body = toRemoveWorktreeResponse(result);
        if (result.status >= 400)
            throw managedWorktreeRemovalError({ status: result.status, body });
        await releaseWorkspaceQuietly(this.services.workspaceGit, req.worktreeDir);
        return body;
    }
    async listManagedWorkspaceGitWorktrees(_ctx, req) {
        if (this.services.managedWorktrees)
            return this.services.managedWorktrees.list(req.workspace);
        if (!this.services.workspaceGit)
            return this.requireManagedWorktrees().list(req.workspace);
        return this.requireWorkspaceGit().listWorktrees(req.workspace);
    }
    async removeManagedWorkspaceGitWorktree(_ctx, req) {
        if (!this.services.managedWorktrees && !this.services.workspaceGit) {
            throw this.requireManagedWorktreesUnavailable();
        }
        if (!this.services.managedWorktrees && this.services.workspaceGit) {
            const result = await this.services.workspaceGit.removeManagedWorktree(req.workspace, req.worktreeDir, req.activeWorktreeDir);
            if (result.status >= 400)
                throw managedWorktreeRemovalError({
                    status: result.status,
                    body: toRemoveWorktreeResponse(result),
                });
            await releaseWorkspaceQuietly(this.services.workspaceGit, req.worktreeDir);
            return toRemoveWorktreeResponse(result);
        }
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
        if (!this.services.managedWorktrees && this.services.workspaceGit) {
            const result = await this.services.workspaceGit.removeManagedWorktreesBatch(req.items.map((item) => ({ workspace: item.workspace, worktreeDir: item.worktreeDir })), req.activeWorktreeDir);
            for (const workspace of result.removedPaths) {
                await releaseWorkspaceQuietly(this.services.workspaceGit, workspace);
            }
            return result;
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
    requireManagedWorktreesUnavailable() {
        return new AppError(503, 'WORKTREE_UNAVAILABLE', 'Managed worktree service is not available');
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
        try {
            return await this.requireWorkspaceFile().listFsDirs(req);
        }
        catch (error) {
            throw mapWorkspaceFileError(error);
        }
    }
    async getFsGitInfo(ctx, req) {
        void ctx;
        try {
            return await this.requireWorkspaceFile().getFsGitInfo(req.path);
        }
        catch (error) {
            throw mapWorkspaceFileError(error);
        }
    }
    requireWorkspaceFile() {
        if (this.services.workspaceFile)
            return this.services.workspaceFile;
        throw new AppError(503, 'WORKSPACE_FILE_UNAVAILABLE', 'Workspace file service is not available');
    }
    requireWorkspaceLocalActions(operation = 'workspaceLocalActions') {
        if (this.services.workspaceLocalActions)
            return this.services.workspaceLocalActions;
        throw new NotImplementedError(operation);
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
function toRemoveWorktreeResponse(result) {
    return {
        success: result.success,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.output ? { output: result.output } : {}),
    };
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
function mapWorkspaceFileError(error) {
    if (error instanceof AppError)
        return error;
    if (error instanceof WorkspaceFileError) {
        const status = workspaceFileErrorStatus(error.code);
        return new AppError(status, error.code, error.message);
    }
    return new AppError(500, 'WORKSPACE_FILE_FAILED', describeError(error));
}
function mapWorkspaceLocalActionError(error, operation) {
    if (error instanceof NotImplementedError)
        return error;
    if (error instanceof WorkspaceLocalActionsUnavailableError) {
        return new NotImplementedError(operation);
    }
    if (error instanceof WorkspaceLocalActionError) {
        return new AppError(error.status, error.code ?? 'WORKSPACE_LOCAL_ACTION_FAILED', error.message);
    }
    if (error instanceof AppError)
        return error;
    return new AppError(500, 'WORKSPACE_LOCAL_ACTION_FAILED', describeError(error));
}
function workspaceFileErrorStatus(code) {
    switch (code) {
        case 'PATH_TRAVERSAL':
        case 'FILE_ACCESS_DENIED':
            return 403;
        case 'FILE_NOT_FOUND':
        case 'WORKSPACE_NOT_FOUND':
            return 404;
        case 'REVISION_CONFLICT':
            return 409;
        case 'FILE_TOO_LARGE':
        case 'OFFICE_PREVIEW_TOO_LARGE':
            return 413;
        case 'NOT_A_FILE':
        case 'NOT_A_DIRECTORY':
            return 422;
        default:
            return 400;
    }
}
async function releaseWorkspaceQuietly(workspaceGit, workspace) {
    if (!workspaceGit)
        return;
    try {
        await workspaceGit.releaseWorkspace(workspace);
    }
    catch {
        // Releasing a stale workspace must not turn a successful removal into an
        // HTTP failure. The next request can rebuild the Git snapshot if needed.
    }
}
//# sourceMappingURL=workspace-file.controller.js.map