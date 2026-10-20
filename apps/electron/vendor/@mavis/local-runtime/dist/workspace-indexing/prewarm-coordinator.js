import { watch as watchFs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDefaultScanNoisePath } from '@mavis/agent-tools/desktop';
import { resolveWorkspaceCollectionPolicy } from './collection-policy.js';
import { runInitialPreparationWithDeadline } from './initial-preparation-deadline.js';
import { beginWorkspaceIndexingLocalCost, WorkspaceIndexingMetrics } from './metrics.js';
import { KeyedOperationQueue } from './keyed-operation-queue.js';
import { createWorkspacePreparedSnapshot, } from './prepared-snapshot.js';
import { isWorkspaceScanCurrent as isWorkspaceScanCurrentDefault, } from './scanner.js';
const DEFAULT_PREWARM_REFRESH_DEBOUNCE_MS = 500;
export class WorkspacePrewarmCoordinator {
    dataDir;
    isEnabled;
    scan;
    isWorkspaceScanCurrent;
    scanOptions;
    createPreparedSnapshot;
    watchWorkspace;
    prewarmRefreshDebounceMs;
    maxInitialScanAttempts;
    initialPreparationTimeoutMs;
    nowMs;
    metrics;
    operations = new KeyedOperationQueue();
    states = new Map();
    activeWorkspace;
    abortController = new AbortController();
    constructor(options) {
        this.dataDir = options.dataDir;
        this.isEnabled = options.isEnabled;
        this.scan = options.scanWorkspace;
        this.isWorkspaceScanCurrent = options.isWorkspaceScanCurrent ?? isWorkspaceScanCurrentDefault;
        this.scanOptions = options.scanOptions;
        this.createPreparedSnapshot = options.createPreparedSnapshot ?? createWorkspacePreparedSnapshot;
        this.watchWorkspace = options.watchWorkspace ?? watchWorkspaceDefault;
        this.prewarmRefreshDebounceMs = normalizeNonNegativeInteger(options.prewarmRefreshDebounceMs, DEFAULT_PREWARM_REFRESH_DEBOUNCE_MS);
        this.maxInitialScanAttempts = options.maxInitialScanAttempts;
        this.initialPreparationTimeoutMs = options.initialPreparationTimeoutMs;
        this.nowMs = options.nowMs;
        this.metrics = options.metrics ?? new WorkspaceIndexingMetrics();
    }
    async prewarmWorkspace(workspaceDir) {
        const cancellationSignal = this.abortController.signal;
        if (!(await this.isEnabled()))
            return { status: 'disabled' };
        cancellationSignal.throwIfAborted();
        const workspaceRealPath = await realpath(workspaceDir);
        cancellationSignal.throwIfAborted();
        const state = this.getOrCreateState(workspaceRealPath);
        this.activateWatcher(state);
        const outcome = await runInitialPreparationWithDeadline(this.initialPreparationTimeoutMs, (deadlineSignal) => {
            const signal = AbortSignal.any([deadlineSignal, cancellationSignal]);
            return this.operations.run(workspaceRealPath, () => this.ensurePrepared(state, signal));
        });
        if (outcome.status === 'timed_out') {
            return { status: 'skipped_timeout', timeoutMs: this.initialPreparationTimeoutMs };
        }
        return toWorkspacePrewarmResult(outcome.value);
    }
    async withCleanWorkspace(workspaceDir, signal, usePrepared) {
        signal = AbortSignal.any([signal, this.abortController.signal]);
        const workspaceRealPath = await realpath(workspaceDir);
        signal.throwIfAborted();
        const state = this.getOrCreateState(workspaceRealPath);
        try {
            return await this.operations.run(workspaceRealPath, async () => {
                for (;;) {
                    const outcome = await this.ensurePrepared(state, signal, true);
                    const changeVersion = state.changeVersion;
                    const policyWorkspaceVersion = state.policyWorkspaceVersion;
                    const confirmCurrent = async () => {
                        // A policy swap between preparation and commit would bind an
                        // artifact filtered by rules that no longer apply, so it counts as
                        // "not current" exactly like a file mutation would.
                        if (resolveWorkspaceCollectionPolicy(this.scanOptions.getCollectionPolicy)
                            .workspaceVersion !== policyWorkspaceVersion) {
                            return false;
                        }
                        if (outcome.status !== 'prepared') {
                            return !state.dirty && state.changeVersion === changeVersion;
                        }
                        const current = await this.isWorkspaceScanCurrent(state.workspaceRealPath, outcome.snapshot.scan, { ...this.scanOptions, signal });
                        return current && !state.dirty && state.changeVersion === changeVersion;
                    };
                    try {
                        return await usePrepared(outcome, confirmCurrent);
                    }
                    catch (error) {
                        signal.throwIfAborted();
                        if (outcome.status !== 'prepared' || !isWorkspaceCaptureMutationError(error)) {
                            throw error;
                        }
                        state.dirty = true;
                    }
                }
            });
        }
        finally {
            if (this.activeWorkspace !== workspaceRealPath && !state.watcher) {
                this.states.delete(workspaceRealPath);
            }
        }
    }
    close() {
        this.abortController.abort();
        this.abortController = new AbortController();
        for (const state of this.states.values()) {
            state.watcher?.close();
            if (state.refreshTimer)
                clearTimeout(state.refreshTimer);
            state.watcher = undefined;
            state.refreshTimer = undefined;
        }
        this.states.clear();
        this.activeWorkspace = undefined;
    }
    getOrCreateState(workspaceRealPath) {
        const key = path.resolve(workspaceRealPath);
        const existing = this.states.get(key);
        if (existing)
            return existing;
        const state = {
            workspaceRealPath: key,
            dirty: true,
            changeVersion: 0,
        };
        this.states.set(key, state);
        return state;
    }
    activateWatcher(state) {
        const key = state.workspaceRealPath;
        if (this.activeWorkspace === key && state.watcher)
            return;
        if (this.activeWorkspace && this.activeWorkspace !== key) {
            const previous = this.states.get(this.activeWorkspace);
            previous?.watcher?.close();
            if (previous?.refreshTimer)
                clearTimeout(previous.refreshTimer);
            if (previous) {
                previous.watcher = undefined;
                previous.refreshTimer = undefined;
                this.states.delete(previous.workspaceRealPath);
            }
        }
        this.activeWorkspace = key;
        try {
            state.watcher = this.watchWorkspace(key, (relativePath) => {
                if (relativePath && this.isIgnoredChange(relativePath))
                    return;
                this.markDirty(state);
            }, () => {
                state.watcher?.close();
                state.watcher = undefined;
            });
            state.watcher.unref?.();
        }
        catch {
            state.watcher = undefined;
        }
    }
    markDirty(state) {
        state.dirty = true;
        state.changeVersion += 1;
        this.scheduleRefresh(state);
    }
    isIgnoredChange(relativePath) {
        const normalized = relativePath.replaceAll('\\', '/');
        return (isDefaultScanNoisePath(normalized) ||
            normalized
                .split('/')
                .some((segment) => this.scanOptions.excludedDirectoryNames?.some((name) => name.toLowerCase() === segment.toLowerCase())) ||
            resolveWorkspaceCollectionPolicy(this.scanOptions.getCollectionPolicy).excludesWorkspacePath(normalized));
    }
    scheduleRefresh(state) {
        if (state.refreshTimer)
            clearTimeout(state.refreshTimer);
        state.refreshTimer = setTimeout(() => {
            state.refreshTimer = undefined;
            if (this.activeWorkspace !== state.workspaceRealPath)
                return;
            void this.prewarmWorkspace(state.workspaceRealPath).catch(() => undefined);
        }, this.prewarmRefreshDebounceMs);
        state.refreshTimer.unref?.();
    }
    async ensurePrepared(state, signal, requireClean = false) {
        for (;;) {
            signal.throwIfAborted();
            const policyWorkspaceVersion = resolveWorkspaceCollectionPolicy(this.scanOptions.getCollectionPolicy).workspaceVersion;
            if (state.policyWorkspaceVersion !== policyWorkspaceVersion) {
                // A policy update retires every cached decision for this Workspace.
                // That includes a sticky `skipped_limit`: a wider exclusion set can
                // drop the Workspace back under the file-count limit, and keeping the
                // old verdict would strand indexing until the app restarts.
                state.policyWorkspaceVersion = policyWorkspaceVersion;
                state.outcome = undefined;
                state.dirty = true;
            }
            const cached = state.outcome;
            // A cached limit result is trustworthy only while an active watcher can
            // invalidate it. Unsupported recursive watching must re-scan at the
            // Agent-start gate so a Workspace that has dropped below the limit can
            // recover without restarting the desktop app.
            if (cached?.status === 'skipped_limit' && !state.dirty && state.watcher) {
                this.metrics.attempt({ stage: 'scan', outcome: 'cache_hit' });
                return cached;
            }
            // Watcher events are hints, including ignored build outputs and metadata
            // changes. Validate the filtered inventory before paying for another ZIP.
            if (cached?.status === 'prepared') {
                const changeVersion = state.changeVersion;
                const current = await this.isWorkspaceScanCurrent(state.workspaceRealPath, cached.snapshot.scan, { ...this.scanOptions, signal });
                if (current && state.changeVersion === changeVersion) {
                    state.dirty = false;
                    this.metrics.attempt({ stage: 'scan', outcome: 'cache_hit' });
                    return cached;
                }
                state.dirty = true;
            }
            const changeVersion = state.changeVersion;
            const outcome = await this.buildPreparedWorkspace(state.workspaceRealPath, signal, cached);
            state.outcome = outcome;
            state.dirty = state.changeVersion !== changeVersion;
            if (state.dirty && this.activeWorkspace === state.workspaceRealPath) {
                this.scheduleRefresh(state);
            }
            if (!requireClean || !state.dirty)
                return outcome;
        }
    }
    async buildPreparedWorkspace(workspaceDir, signal, cached) {
        let lastError;
        for (let attempt = 0; attempt < this.maxInitialScanAttempts; attempt += 1) {
            let scan;
            const scanStartedMs = this.nowMs();
            const readScanCost = beginWorkspaceIndexingLocalCost();
            try {
                scan = await this.scan(workspaceDir, { ...this.scanOptions, signal });
            }
            catch (error) {
                this.metrics.attempt({
                    stage: 'scan',
                    outcome: signal.aborted ? 'cancelled' : 'failed',
                    durationMs: this.nowMs() - scanStartedMs,
                });
                signal.throwIfAborted();
                lastError = error;
                if (attempt + 1 >= this.maxInitialScanAttempts)
                    throw error;
                this.metrics.retry('scan', 'error');
                continue;
            }
            if (scan.status === 'skipped_limit') {
                this.metrics.attempt({
                    stage: 'scan',
                    outcome: 'skipped_limit',
                    durationMs: this.nowMs() - scanStartedMs,
                });
                this.metrics.result({ stage: 'scan', outcome: 'skipped_limit', reason: scan.reason });
                return scan;
            }
            this.metrics.attempt({
                stage: 'scan',
                outcome: 'success',
                durationMs: this.nowMs() - scanStartedMs,
            });
            this.metrics.result({ stage: 'scan', outcome: 'success' });
            this.metrics.localCost('scan', readScanCost());
            this.metrics.fileCount('scan', scan.files.length);
            this.metrics.payloadBytes('source', scan.totalBytes);
            if (cached?.status === 'prepared' &&
                cached.snapshot.scan.rootHash === scan.rootHash &&
                cached.snapshot.scan.policy.workspaceVersion === scan.policy.workspaceVersion) {
                // A same-content rewrite changes the inventory fingerprint. Retain the
                // immutable archive, but advance the scan so subsequent checks are cheap.
                this.metrics.attempt({ stage: 'archive', outcome: 'cache_hit' });
                return { status: 'prepared', snapshot: { ...cached.snapshot, scan } };
            }
            const archiveStartedMs = this.nowMs();
            const readArchiveCost = beginWorkspaceIndexingLocalCost();
            try {
                const snapshot = await this.createPreparedSnapshot({
                    dataDir: this.dataDir,
                    scan,
                    createdAtMs: this.nowMs(),
                    signal,
                });
                this.metrics.attempt({
                    stage: 'archive',
                    outcome: 'success',
                    durationMs: this.nowMs() - archiveStartedMs,
                });
                this.metrics.result({ stage: 'archive', outcome: 'success' });
                this.metrics.localCost('archive', readArchiveCost());
                this.metrics.payloadBytes('archive', snapshot.archiveSizeBytes);
                return { status: 'prepared', snapshot };
            }
            catch (error) {
                this.metrics.attempt({
                    stage: 'archive',
                    outcome: signal.aborted ? 'cancelled' : 'failed',
                    durationMs: this.nowMs() - archiveStartedMs,
                });
                signal.throwIfAborted();
                lastError = error;
                if (!isWorkspaceCaptureMutationError(error) || attempt + 1 >= this.maxInitialScanAttempts) {
                    throw error;
                }
                this.metrics.retry('archive', 'error');
            }
        }
        throw lastError instanceof Error ? lastError : new Error('workspace_scan_failed');
    }
}
function toWorkspacePrewarmResult(outcome) {
    if (outcome.status === 'skipped_limit') {
        return {
            status: 'skipped_limit',
            reason: outcome.reason,
            limit: outcome.limit,
            observed: outcome.observed,
        };
    }
    return {
        status: 'prepared',
        rootHash: outcome.snapshot.scan.rootHash,
        fileCount: outcome.snapshot.scan.files.length,
        totalBytes: outcome.snapshot.scan.totalBytes,
    };
}
function isWorkspaceCaptureMutationError(error) {
    return error instanceof Error && error.message.startsWith('workspace_changed_during_capture:');
}
function watchWorkspaceDefault(workspaceDir, onChange, onError) {
    const watcher = watchFs(workspaceDir, { recursive: true }, (_event, filename) => {
        onChange(filename ?? undefined);
    });
    watcher.on('error', onError);
    return watcher;
}
function normalizeNonNegativeInteger(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`invalid_workspace_prewarm_debounce:${value}`);
    }
    return Math.floor(value);
}
//# sourceMappingURL=prewarm-coordinator.js.map