import { watch } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
const DEFAULT_QUIET_WINDOW_MS = 120;
const DEFAULT_MAX_WAIT_MS = 800;
const MAX_CLASSIFIED_PATHS = 1_000;
const REPOSITORY_ROOT_FILES = new Set([
    'HEAD',
    'ORIG_HEAD',
    'FETCH_HEAD',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'index',
    'packed-refs',
    'config',
    'config.worktree',
    'commondir',
    'gitdir',
    'info/exclude',
]);
const REPOSITORY_STATE_PREFIXES = ['refs/', 'rebase-apply/', 'rebase-merge/', 'sequencer/'];
/**
 * Watches product files and the small subset of Git administrative paths that
 * can change status/branch metadata. Raw events are coalesced before the
 * manager is told to refresh; objects and logs are never watched.
 */
export async function createWorkspaceGitWatcher(options, dependencies = {}) {
    const workspace = await realpath(options.workspace);
    const watchDirectory = dependencies.watchDirectory ??
        ((directory, recursive, listener) => watch(directory, { recursive }, (_eventType, fileName) => listener(fileName)));
    const coordinator = new WorkspaceGitWatcherCoordinator(workspace, options, watchDirectory);
    await coordinator.start();
    return coordinator;
}
class WorkspaceGitWatcherCoordinator {
    workspace;
    options;
    watchDirectory;
    workspaceWatchers = [];
    repositoryWatchers = [];
    repositoryPresent = false;
    repositoryWatcherGeneration = 0;
    repositoryRebindRequested = false;
    repositoryRebindTask;
    closed = false;
    failure;
    potentialNotified = false;
    quietTimer;
    maxTimer;
    flushing = false;
    pendingKind;
    hasUnknownWorkspacePath = false;
    pendingPaths = new Set();
    constructor(workspace, options, watchDirectory) {
        this.workspace = workspace;
        this.options = options;
        this.watchDirectory = watchDirectory;
    }
    async start() {
        try {
            this.attachWatcher({
                target: this.workspaceWatchers,
                directory: this.workspace,
                recursive: true,
                listener: this.enqueueWorkspacePath,
                onError: this.failClosed,
            });
            this.assertActive();
            await this.replaceRepositoryWatchers();
            this.assertActive();
        }
        catch (error) {
            this.close();
            throw error;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.clearTimers();
        this.pendingPaths.clear();
        closeWatchers(this.workspaceWatchers);
        closeWatchers(this.repositoryWatchers);
    }
    failClosed = (error) => {
        if (this.closed)
            return;
        this.failure = error;
        this.close();
        this.potentialNotified = false;
        this.options.callbacks.onError(error);
    };
    clearTimers() {
        if (this.quietTimer)
            clearTimeout(this.quietTimer);
        if (this.maxTimer)
            clearTimeout(this.maxTimer);
        this.quietTimer = undefined;
        this.maxTimer = undefined;
    }
    scheduleFlush() {
        if (this.closed)
            return;
        if (this.quietTimer)
            clearTimeout(this.quietTimer);
        this.quietTimer = setTimeout(() => void this.flush(), this.options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS);
        this.maxTimer ??= setTimeout(() => void this.flush(), this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    }
    markPotential() {
        if (!this.potentialNotified) {
            this.potentialNotified = true;
            this.options.callbacks.onPotentialChange();
        }
        this.scheduleFlush();
    }
    enqueueWorkspacePath = (fileName) => {
        if (this.closed)
            return;
        const normalized = normalizeWatchFileName(fileName);
        if (normalized === '.git' || normalized.startsWith('.git/')) {
            this.handleWorkspaceGitPath(normalized);
            return;
        }
        // Before a repository exists, the workspace watcher is deliberately only
        // an observer for `.git` appearing. Ordinary files cannot affect Git state
        // yet and must not trigger classification or status work.
        if (!this.repositoryPresent)
            return;
        if (!normalized || this.pendingPaths.size >= MAX_CLASSIFIED_PATHS) {
            this.hasUnknownWorkspacePath = true;
        }
        else {
            this.pendingPaths.add(normalized);
        }
        this.markPotential();
    };
    handleWorkspaceGitPath(normalized) {
        if (normalized !== '.git' && this.repositoryWatchers.length > 0)
            return;
        this.pendingKind = 'repository';
        this.requestRepositoryRebind();
        this.markPotential();
    }
    enqueueRepositoryPath(fileName, refsOnly) {
        if (this.closed)
            return;
        const normalized = normalizeWatchFileName(fileName);
        const layoutMayHaveChanged = normalized === 'commondir' ||
            normalized === 'gitdir' ||
            normalized === 'refs' ||
            normalized === 'info';
        if (!this.isRelevantRepositoryPath(normalized, refsOnly, layoutMayHaveChanged))
            return;
        this.pendingKind = 'repository';
        if (layoutMayHaveChanged)
            this.requestRepositoryRebind();
        this.markPotential();
    }
    isRelevantRepositoryPath(normalized, refsOnly, layoutMayHaveChanged) {
        return (!normalized ||
            refsOnly ||
            layoutMayHaveChanged ||
            REPOSITORY_ROOT_FILES.has(normalized) ||
            REPOSITORY_STATE_PREFIXES.some((prefix) => normalized.startsWith(prefix)));
    }
    attachWatcher(options) {
        this.assertActive();
        const watcher = this.watchDirectory(options.directory, options.recursive, options.listener);
        watcher.on('error', options.onError);
        if (this.closed) {
            watcher.close();
            this.assertActive();
        }
        options.target.push(watcher);
    }
    async replaceRepositoryWatchers() {
        const layout = await resolveGitDirectoryLayout(this.workspace);
        const nextGeneration = this.repositoryWatcherGeneration + 1;
        const candidate = { active: true };
        let nextWatchers = [];
        try {
            nextWatchers = await this.createRepositoryWatchers(layout, nextGeneration, candidate);
            this.assertActive();
            const previousWatchers = this.repositoryWatchers;
            this.repositoryWatcherGeneration = nextGeneration;
            this.repositoryWatchers = nextWatchers;
            this.repositoryPresent = layout !== undefined;
            closeWatchers(previousWatchers);
        }
        catch (error) {
            closeWatchers(nextWatchers);
            throw error;
        }
        finally {
            candidate.active = false;
        }
    }
    async createRepositoryWatchers(layout, generation, candidate) {
        const watchers = [];
        if (!layout)
            return watchers;
        const onError = (error) => {
            if (!this.closed && (candidate.active || this.repositoryWatcherGeneration === generation)) {
                this.failClosed(error);
            }
        };
        try {
            this.attachRepositoryRootWatchers(watchers, layout, onError);
            await this.attachRepositoryRefWatchers(watchers, layout, onError);
            await this.attachRepositoryInfoWatchers(watchers, layout, onError);
            return watchers;
        }
        catch (error) {
            closeWatchers(watchers);
            throw error;
        }
    }
    attachRepositoryRootWatchers(watchers, layout, onError) {
        this.attachWatcher({
            target: watchers,
            directory: layout.gitDir,
            recursive: false,
            listener: (fileName) => this.enqueueRepositoryPath(fileName, false),
            onError,
        });
        if (layout.commonDir === layout.gitDir)
            return;
        this.attachWatcher({
            target: watchers,
            directory: layout.commonDir,
            recursive: false,
            listener: (fileName) => this.enqueueRepositoryPath(fileName, false),
            onError,
        });
    }
    async attachRepositoryRefWatchers(watchers, layout, onError) {
        const refsDirectories = new Set([join(layout.gitDir, 'refs'), join(layout.commonDir, 'refs')]);
        for (const directory of refsDirectories) {
            if (!(await isDirectory(directory)))
                continue;
            this.attachWatcher({
                target: watchers,
                directory,
                recursive: true,
                listener: (fileName) => this.enqueueRepositoryPath(fileName, true),
                onError,
            });
        }
    }
    async attachRepositoryInfoWatchers(watchers, layout, onError) {
        const infoDirectories = new Set([join(layout.gitDir, 'info'), join(layout.commonDir, 'info')]);
        for (const directory of infoDirectories) {
            if (!(await isDirectory(directory)))
                continue;
            this.attachWatcher({
                target: watchers,
                directory,
                recursive: false,
                listener: (fileName) => {
                    const normalized = normalizeWatchFileName(fileName);
                    if (!normalized || normalized === 'exclude') {
                        this.enqueueRepositoryPath(normalized ? `info/${normalized}` : normalized, false);
                    }
                },
                onError,
            });
        }
    }
    requestRepositoryRebind() {
        if (this.closed)
            return;
        this.repositoryRebindRequested = true;
        if (this.repositoryRebindTask)
            return;
        this.repositoryRebindTask = this.runRepositoryRebind();
    }
    assertActive() {
        if (!this.closed)
            return;
        if (this.failure instanceof Error)
            throw this.failure;
        throw new Error('Workspace Git watcher closed during setup', { cause: this.failure });
    }
    async runRepositoryRebind() {
        try {
            while (!this.closed && this.repositoryRebindRequested) {
                this.repositoryRebindRequested = false;
                await this.replaceRepositoryWatchers();
            }
        }
        catch (error) {
            this.failClosed(error);
        }
        finally {
            this.repositoryRebindTask = undefined;
            if (!this.closed && this.repositoryRebindRequested)
                this.requestRepositoryRebind();
        }
    }
    async waitForRepositoryRebind() {
        while (this.repositoryRebindTask)
            await this.repositoryRebindTask;
    }
    async flush() {
        if (this.closed || this.flushing || !this.potentialNotified)
            return;
        this.flushing = true;
        this.clearTimers();
        try {
            await this.waitForRepositoryRebind();
            if (this.closed)
                return;
            const changeKind = await this.drainPendingChanges();
            if (this.closed)
                return;
            this.potentialNotified = false;
            if (changeKind)
                this.options.callbacks.onChange(changeKind);
            else
                this.options.callbacks.onIgnoredOnly();
        }
        catch (error) {
            this.potentialNotified = false;
            this.failClosed(error);
        }
        finally {
            this.flushing = false;
            if (!this.closed && this.potentialNotified)
                this.scheduleFlush();
        }
    }
    async drainPendingChanges() {
        let changeKind;
        do {
            changeKind = await this.classifyBatch(changeKind, this.takePendingBatch());
        } while (!this.closed && this.hasPendingBatch());
        return changeKind;
    }
    takePendingBatch() {
        const batch = {
            ...(this.pendingKind ? { kind: this.pendingKind } : {}),
            unknown: this.hasUnknownWorkspacePath,
            paths: Array.from(this.pendingPaths),
        };
        this.pendingKind = undefined;
        this.hasUnknownWorkspacePath = false;
        this.pendingPaths.clear();
        return batch;
    }
    async classifyBatch(current, batch) {
        if (batch.kind === 'repository')
            return 'repository';
        if (current)
            return current;
        if (batch.unknown || batch.paths.length === 0)
            return 'workspace';
        return (await this.options.classifyIgnored(batch.paths)) ? undefined : 'workspace';
    }
    hasPendingBatch() {
        return (this.pendingKind !== undefined || this.hasUnknownWorkspacePath || this.pendingPaths.size > 0);
    }
}
function closeWatchers(watchers) {
    for (const watcher of watchers)
        watcher.close();
    watchers.length = 0;
}
async function resolveGitDirectoryLayout(workspace) {
    const dotGit = join(workspace, '.git');
    const dotGitStat = await readGitDirectoryEntry(dotGit);
    if (!dotGitStat)
        return undefined;
    const gitDir = await resolveGitDirectory(workspace, dotGit, dotGitStat);
    const commonDir = await resolveGitCommonDirectory(gitDir);
    return { gitDir, commonDir };
}
async function readGitDirectoryEntry(dotGit) {
    try {
        return await lstat(dotGit);
    }
    catch (error) {
        if (isMissingPathError(error))
            return undefined;
        throw error;
    }
}
async function resolveGitDirectory(workspace, dotGit, dotGitStat) {
    if (dotGitStat.isDirectory()) {
        return realpath(dotGit);
    }
    if (dotGitStat.isFile()) {
        const match = /^gitdir:\s*(.+)$/mu.exec(await readFile(dotGit, 'utf8'));
        const linkedPath = match?.[1]?.trim();
        if (!linkedPath)
            throw new Error(`Invalid Git directory pointer: ${dotGit}`);
        return realpath(isAbsolute(linkedPath) ? linkedPath : resolve(workspace, linkedPath));
    }
    throw new Error(`Unsupported Git directory entry: ${dotGit}`);
}
async function resolveGitCommonDirectory(gitDir) {
    let commonPath;
    try {
        commonPath = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
    }
    catch (error) {
        // Main worktrees have no commondir file; their gitDir is also commonDir.
        if (isMissingPathError(error))
            return gitDir;
        throw error;
    }
    if (!commonPath)
        throw new Error(`Invalid Git common directory pointer: ${gitDir}`);
    return realpath(isAbsolute(commonPath) ? commonPath : resolve(gitDir, commonPath));
}
function isMissingPathError(error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function normalizeWatchFileName(fileName) {
    if (fileName === null)
        return '';
    const value = Buffer.isBuffer(fileName) ? fileName.toString('utf8') : fileName;
    return value.split(sep).filter(Boolean).join('/');
}
async function isDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=watcher.js.map