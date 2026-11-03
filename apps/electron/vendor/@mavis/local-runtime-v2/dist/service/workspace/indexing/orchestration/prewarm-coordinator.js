import { watch as watchFs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDefaultScanNoisePath } from '@mavis/agent-tools/desktop';
import { resolveWorkspaceCollectionPolicy } from '../capture/collection-policy.js';
import { runInitialPreparationWithDeadline } from './initial-preparation-deadline.js';
import { detachWorkspacePreparation } from './service-helpers.js';
import { beginWorkspaceIndexingLocalCost, WorkspaceIndexingMetrics } from '../scan/metrics.js';
import { KeyedOperationQueue } from '../../../../infra/util/keyed-operation-queue.js';
import { createWorkspacePreparedSnapshot, } from '../revision/prepared-snapshot.js';
import { isWorkspaceScanCurrent as isWorkspaceScanCurrentDefault, scanWorkspace as scanWorkspaceDefault, } from '../scan/scanner.js';
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
    async withCleanWorkspace(workspaceDir, callerSignal, usePrepared) {
        const signal = AbortSignal.any([callerSignal, this.abortController.signal]);
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
            detachWorkspacePreparation(this.refreshWorkspace(state.workspaceRealPath));
        }, this.prewarmRefreshDebounceMs);
        state.refreshTimer.unref?.();
    }
    async refreshWorkspace(workspaceDir) {
        try {
            await this.prewarmWorkspace(workspaceDir);
        }
        catch {
            // 定时预热为 best-effort；下次选择或 Agent 启动会重新检查。
        }
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
            const current = await this.currentPreparedOutcome(state, signal);
            if (current)
                return current;
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
    async currentPreparedOutcome(state, signal) {
        const cached = state.outcome;
        // 没有 watcher 时，限额结果不能长期缓存，Agent 启动仍需重扫。
        if (cached?.status === 'skipped_limit' && !state.dirty && state.watcher) {
            this.metrics.attempt({ stage: 'scan', outcome: 'cache_hit' });
            return cached;
        }
        if (cached?.status !== 'prepared')
            return undefined;
        // watcher 只是变化提示；先检查过滤后的 inventory，再决定是否重建 ZIP。
        const changeVersion = state.changeVersion;
        const current = await this.isWorkspaceScanCurrent(state.workspaceRealPath, cached.snapshot.scan, { ...this.scanOptions, signal });
        if (current && state.changeVersion === changeVersion) {
            state.dirty = false;
            this.metrics.attempt({ stage: 'scan', outcome: 'cache_hit' });
            return cached;
        }
        state.dirty = true;
        return undefined;
    }
    async buildPreparedWorkspace(workspaceDir, signal, cached) {
        let lastError;
        for (let attempt = 0; attempt < this.maxInitialScanAttempts; attempt += 1) {
            let scan;
            try {
                scan = await this.scanForPreparation(workspaceDir, signal);
            }
            catch (error) {
                signal.throwIfAborted();
                lastError = error;
                if (attempt + 1 >= this.maxInitialScanAttempts)
                    throw error;
                this.metrics.retry('scan', 'error');
                continue;
            }
            if (scan.status === 'skipped_limit')
                return scan;
            try {
                return await this.prepareScannedWorkspace(scan, signal, cached);
            }
            catch (error) {
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
    async scanForPreparation(workspaceDir, signal) {
        const startedMs = this.nowMs();
        const readCost = beginWorkspaceIndexingLocalCost();
        let scan;
        try {
            scan = await this.scan(workspaceDir, { ...this.scanOptions, signal });
        }
        catch (error) {
            this.metrics.attempt({
                stage: 'scan',
                outcome: signal.aborted ? 'cancelled' : 'failed',
                durationMs: this.nowMs() - startedMs,
            });
            throw error;
        }
        if (scan.status === 'skipped_limit') {
            this.metrics.attempt({
                stage: 'scan',
                outcome: 'skipped_limit',
                durationMs: this.nowMs() - startedMs,
            });
            this.metrics.result({ stage: 'scan', outcome: 'skipped_limit', reason: scan.reason });
            return scan;
        }
        this.metrics.attempt({
            stage: 'scan',
            outcome: 'success',
            durationMs: this.nowMs() - startedMs,
        });
        this.metrics.result({ stage: 'scan', outcome: 'success' });
        this.metrics.localCost('scan', readCost());
        this.metrics.fileCount('scan', scan.files.length);
        this.metrics.payloadBytes('source', scan.totalBytes);
        return scan;
    }
    async prepareScannedWorkspace(scan, signal, cached) {
        if (cached?.status === 'prepared' &&
            cached.snapshot.scan.rootHash === scan.rootHash &&
            cached.snapshot.scan.policy.workspaceVersion === scan.policy.workspaceVersion) {
            // 相同内容的重写只更新 inventory；保留已经构建的不可变 ZIP。
            this.metrics.attempt({ stage: 'archive', outcome: 'cache_hit' });
            return { status: 'prepared', snapshot: { ...cached.snapshot, scan } };
        }
        const startedMs = this.nowMs();
        const readCost = beginWorkspaceIndexingLocalCost();
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
                durationMs: this.nowMs() - startedMs,
            });
            this.metrics.result({ stage: 'archive', outcome: 'success' });
            this.metrics.localCost('archive', readCost());
            this.metrics.payloadBytes('archive', snapshot.archiveSizeBytes);
            return { status: 'prepared', snapshot };
        }
        catch (error) {
            this.metrics.attempt({
                stage: 'archive',
                outcome: signal.aborted ? 'cancelled' : 'failed',
                durationMs: this.nowMs() - startedMs,
            });
            throw error;
        }
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