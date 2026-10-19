import { Buffer } from 'node:buffer';
import { HTTPException } from 'hono/http-exception';
import { DesktopModelProviderServiceBase } from './desktop-model-provider-service-base.js';
const LOCAL_RUNTIME_ORIGIN = 'http://local-runtime.test';
/** Thin DesktopService adapter over the existing /mavis/api/file and /fs facades. */
export class DesktopWorkspaceFileServiceBase extends DesktopModelProviderServiceBase {
    async listWorkspaceFileTree(_ctx, req) {
        const entries = await this.localApiJson(query('/mavis/api/file/tree', { workspace: req.workspace, path: req.path }));
        return { entries };
    }
    readWorkspaceFile(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/content', { workspace: req.workspace, path: req.path }));
    }
    saveWorkspaceFile(_ctx, req) {
        return this.localApiJson('/mavis/api/file/save', {
            method: 'POST',
            body: { workspace: req.workspace, path: req.path, content: req.content },
        });
    }
    async searchWorkspaceFiles(_ctx, req) {
        const paths = await this.localApiJson(query('/mavis/api/file/search', {
            workspace: req.workspace,
            query: req.query,
            limit: req.limit,
        }));
        return { paths };
    }
    async previewWorkspaceFile(_ctx, req) {
        const response = await this.localApiResponse(query('/mavis/api/file/preview', { path: req.path }));
        if (!response.ok) {
            throw new HTTPException(response.status, { res: response });
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        return {
            contentBase64: bytes.toString('base64'),
            mimeType: response.headers.get('content-type') ?? undefined,
            sizeBytes: bytes.byteLength,
        };
    }
    getWorkspaceFileDiff(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/diff', {
            workspace: req.workspace,
            path: req.path,
            scope: req.scope,
        }));
    }
    async listWorkspaceFileDiffs(_ctx, req) {
        const diffs = await this.localApiJson(query('/mavis/api/file/diffs', { workspace: req.workspace, scope: req.scope }));
        return { diffs };
    }
    getWorkspaceDiffContext(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/diff-context', {
            workspace: req.workspace,
            path: req.path,
            scope: req.scope,
        }));
    }
    async getWorkspaceFileStatus(_ctx, req) {
        const files = await this.localApiJson(query('/mavis/api/file/status', { workspace: req.workspace }));
        return { files };
    }
    getWorkspaceGitGraph(_ctx, _req) {
        return workspaceReviewV2Only('GetWorkspaceGitGraph');
    }
    listWorkspaceReviewCommits(_ctx, _req) {
        return workspaceReviewV2Only('ListWorkspaceReviewCommits');
    }
    getWorkspaceReviewSummary(_ctx, _req) {
        return workspaceReviewV2Only('GetWorkspaceReviewSummary');
    }
    listWorkspaceReviewFileDiffs(_ctx, _req) {
        return workspaceReviewV2Only('ListWorkspaceReviewFileDiffs');
    }
    getWorkspaceReviewFileContent(_ctx, _req) {
        return workspaceReviewV2Only('GetWorkspaceReviewFileContent');
    }
    searchWorkspaceReviewDiffs(_ctx, _req) {
        return workspaceReviewV2Only('SearchWorkspaceReviewDiffs');
    }
    listWorkspaceRecentBranches(_ctx, _req) {
        return workspaceReviewV2Only('ListWorkspaceRecentBranches');
    }
    searchWorkspaceGitBranches(_ctx, _req) {
        return workspaceReviewV2Only('SearchWorkspaceGitBranches');
    }
    async openWorkspaceApp(_ctx, req) {
        await this.localApiJson(query('/mavis/api/file/open-app', { workspace: req.workspace, path: req.path }));
        return {};
    }
    async listIdeApps(_ctx, _req) {
        const body = await this.localApiJson('/mavis/api/file/ide-apps');
        return { apps: body.apps ?? [] };
    }
    openWorkspaceFile(_ctx, req) {
        return this.post('/mavis/api/file/open', {
            workspace: req.workspace,
            path: req.path,
        });
    }
    revealWorkspaceFile(_ctx, req) {
        return this.post('/mavis/api/file/reveal', {
            workspace: req.workspace,
            path: req.path,
        });
    }
    openWorkspaceFileInIde(_ctx, req) {
        return this.post('/mavis/api/file/open-in-ide', {
            ideId: req.ideId,
            workspace: req.workspace,
            path: req.path,
        });
    }
    suggestCommitMessage(_ctx, req) {
        return this.post('/mavis/api/file/commit-message', { workspace: req.workspace });
    }
    probeWorkspaceGit(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/git/probe', { workspace: req.workspace }));
    }
    getWorkspaceGitChanges(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/git/changes', { workspace: req.workspace }));
    }
    getWorkspaceGitMetadata(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/git/metadata', { workspace: req.workspace }));
    }
    getWorkspaceGitBranches(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/git/branches', {
            workspace: req.workspace,
            includeRemote: req.includeRemote,
        }));
    }
    getWorkspaceGitBranchPicker(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/git/branch-picker', { workspace: req.workspace }));
    }
    getWorkspaceGitDefaultBranch(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/git/default-branch', { workspace: req.workspace }));
    }
    checkoutWorkspaceGitBranch(_ctx, req) {
        return this.post('/mavis/api/file/git/checkout', {
            workspace: req.workspace,
            branch: req.branch,
        });
    }
    createWorkspaceGitBranch(_ctx, req) {
        return this.post('/mavis/api/file/git/create-branch', {
            workspace: req.workspace,
            branch: req.branch,
        });
    }
    commitWorkspaceGit(_ctx, req) {
        return this.post('/mavis/api/file/git/commit', {
            workspace: req.workspace,
            message: req.message,
            includeUnstaged: req.includeUnstaged,
        });
    }
    pushWorkspaceGit(_ctx, req) {
        return this.post('/mavis/api/file/git/push', { workspace: req.workspace });
    }
    applyWorkspaceGitChangeAction(_ctx, req) {
        return this.post('/mavis/api/file/git/change-action', {
            workspace: req.workspace,
            action: req.action,
            scope: req.scope,
            path: req.path,
            paths: req.paths,
            originalPath: req.originalPath,
        });
    }
    listWorkspaceGitWorktrees(_ctx, req) {
        return this.localApiJson(query('/mavis/api/file/git/worktrees', { workspace: req.workspace }));
    }
    createWorkspaceGitWorktree(_ctx, req) {
        return this.post('/mavis/api/file/git/worktrees', {
            workspace: req.workspace,
            options: req.options,
        });
    }
    removeWorkspaceGitWorktree(_ctx, req) {
        return this.post('/mavis/api/file/git/worktrees/remove', {
            workspace: req.workspace,
            worktreeDir: req.worktreeDir,
        });
    }
    listFsDirs(_ctx, req) {
        return this.localApiJson(query('/mavis/api/fs/dirs', {
            directory: req.directory,
            query: req.query,
            maxdepth: req.maxdepth,
            offset: req.offset,
            limit: req.limit,
            hideDotFiles: req.hideDotFiles,
        }));
    }
    getFsGitInfo(_ctx, req) {
        return this.localApiJson(query('/mavis/api/fs/git-info', { path: req.path }));
    }
    post(path, body) {
        return this.localApiJson(path, { method: 'POST', body: stripUndefined(body) });
    }
}
function query(path, values) {
    const url = new URL(path, LOCAL_RUNTIME_ORIGIN);
    for (const [key, value] of Object.entries(values)) {
        if (value !== undefined)
            url.searchParams.set(key, String(value));
    }
    return url;
}
function stripUndefined(values) {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}
function workspaceReviewV2Only(method) {
    return Promise.reject(new HTTPException(501, {
        message: `DesktopService.${method} is owned by Local Runtime v2.`,
    }));
}
//# sourceMappingURL=desktop-workspace-file-service.js.map