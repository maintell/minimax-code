import { addGitObservation, measureGitRead, gitWatcherErrorCode, } from '../git-read-observation.js';
import { randomUUID } from 'node:crypto';
import { clearWorkspaceEntries, currentWorkspaceSnapshotId, evictOldestIdleWorkspaceEntry, isCurrentWorkspaceSnapshot, releaseWorkspaceEntry, trimIdleWorkspaceEntries, } from './snapshot-entry-cache.js';
import { createDeferred, publishWorkspaceGitChanged, StaleWorkspaceGitSnapshotError, WorkspaceGitSnapshotManagerClosedError, WorkspaceGitSnapshotReleasedError, } from './snapshot-support.js';
/**
 * Runtime-owned source of truth for one Git snapshot per workspace.
 *
 * In-flight work and completed values share the same snapshot id. A watcher or
 * mutation advances that id before a later request can join the old work. A
 * request that crosses the boundary retries against the new id instead of
 * returning an apparently precise stale result.
 */
export class WorkspaceGitSnapshotManager {
    options;
    entries = new Map();
    instanceId;
    maxWorkspaces;
    reuseCompletedResults;
    changeNotificationWindowMs;
    snapshotSequence = 0;
    usageSequence = 0;
    closed = false;
    constructor(options) {
        this.options = options;
        this.instanceId = options.instanceId ?? randomUUID();
        this.maxWorkspaces = Math.max(1, options.maxWorkspaces ?? 8);
        this.reuseCompletedResults = options.reuseCompletedResults !== false;
        this.changeNotificationWindowMs = Math.max(0, options.changeNotificationWindowMs ?? 0);
    }
    async getChanges(workspace, mode, trace) {
        for (;;) {
            const entry = this.getOrCreateEntry(workspace);
            entry.activeReaders += 1;
            try {
                addGitObservation(trace, 'attempts');
                if (trace) {
                    trace.workspace_key = entry.observationKey;
                    trace.start_snapshot ??= entry.snapshotId;
                }
                const result = await this.readChangesAttempt(entry, mode, trace);
                if (result)
                    return result;
            }
            finally {
                if (trace) {
                    trace.end_snapshot = entry.snapshotId;
                    trace.watcher_healthy = entry.watcherHealthy;
                    trace.watcher_error = entry.watcherErrorCode ?? 'none';
                    trace.invalidation_reason = entry.lastInvalidationReason ?? 'none';
                }
                this.finishRead(entry);
            }
        }
    }
    async readChangesAttempt(entry, mode, trace) {
        await measureGitRead(trace, 'watcher_setup_ms', () => this.ensureWatcher(entry));
        await this.waitForReadBarrier(entry, trace);
        this.beginReadGeneration(entry);
        const requestSnapshotId = entry.snapshotId;
        const request = mode === 'fast' ? this.getBase(entry, trace) : this.getFull(entry, trace);
        try {
            const result = await measureGitRead(trace, mode === 'fast' ? 'base_wait_ms' : 'full_wait_ms', () => request);
            await measureGitRead(trace, 'classification_wait_ms', () => this.waitForPathClassification(entry));
            if (this.isStableResult(entry, result.snapshotId))
                return result;
            if (entry.disposed)
                throw new WorkspaceGitSnapshotReleasedError();
            await this.waitForReadBarrier(entry, trace);
            return undefined;
        }
        catch (error) {
            return this.handleChangesFailure(entry, requestSnapshotId, error, trace);
        }
    }
    async handleChangesFailure(entry, requestSnapshotId, error, trace) {
        await this.waitForReadBarrier(entry, trace);
        if (this.closed)
            throw new WorkspaceGitSnapshotManagerClosedError();
        if (error instanceof WorkspaceGitSnapshotReleasedError || entry.disposed) {
            throw new WorkspaceGitSnapshotReleasedError();
        }
        if (error instanceof StaleWorkspaceGitSnapshotError)
            return undefined;
        if (!this.isCurrentEntry(entry))
            return undefined;
        if (entry.snapshotId !== requestSnapshotId || entry.mutating)
            return undefined;
        throw error;
    }
    async getMetadata(workspace) {
        const loader = this.options.loadMetadata;
        if (!loader) {
            throw new Error('WorkspaceGitSnapshotManager metadata loader is not configured');
        }
        for (;;) {
            const entry = this.getOrCreateEntry(workspace);
            entry.activeReaders += 1;
            try {
                const result = await this.readMetadataAttempt(entry, loader);
                if (result)
                    return result;
            }
            finally {
                this.finishRead(entry);
            }
        }
    }
    async readMetadataAttempt(entry, loader) {
        await this.ensureWatcher(entry);
        await this.waitForReadBarrier(entry);
        this.beginReadGeneration(entry);
        if (entry.metadata !== undefined) {
            return { snapshotId: entry.snapshotId, value: entry.metadata };
        }
        const revision = entry.metadataRevision;
        const request = entry.metadataRequest ?? this.startMetadataRequest(entry, revision, loader);
        try {
            const result = await request;
            await this.waitForPathClassification(entry);
            if (this.isStableMetadata(entry, result.revision)) {
                return { snapshotId: entry.snapshotId, value: result.value };
            }
            await this.waitForReadBarrier(entry);
            if (entry.disposed)
                throw new WorkspaceGitSnapshotReleasedError();
            return undefined;
        }
        catch (error) {
            return this.handleMetadataFailure(entry, revision, error);
        }
    }
    async handleMetadataFailure(entry, revision, error) {
        await this.waitForReadBarrier(entry);
        if (this.closed)
            throw new WorkspaceGitSnapshotManagerClosedError();
        if (error instanceof WorkspaceGitSnapshotReleasedError || entry.disposed) {
            throw new WorkspaceGitSnapshotReleasedError();
        }
        if (!this.isCurrentEntry(entry))
            return undefined;
        if (entry.metadataRevision !== revision || entry.mutating)
            return undefined;
        throw error;
    }
    isStableMetadata(entry, revision) {
        return this.isCurrentEntry(entry) && !entry.mutating && entry.metadataRevision === revision;
    }
    finishRead(entry) {
        entry.activeReaders -= 1;
        if (entry.activeReaders === 0) {
            entry.readGenerationSnapshotId = undefined;
            if (!this.canReuseCompleted(entry)) {
                entry.base = undefined;
                entry.full = undefined;
                entry.metadata = undefined;
            }
        }
        this.trimEntries();
    }
    currentSnapshotId(workspace) {
        return currentWorkspaceSnapshotId(this.entries, workspace);
    }
    /** Associates a caller-visible spelling with the canonical snapshot owner. */
    registerWorkspaceAlias(workspace, alias) {
        const entry = this.getOrCreateEntry(workspace);
        if (alias !== workspace)
            entry.aliases.add(alias);
    }
    /**
     * Establishes the workspace watcher without running a Git status query.
     * Probe uses this boundary so a non-Git directory can observe a later
     * `git init` while ordinary file churn remains query-free.
     */
    async observeWorkspace(workspace) {
        const entry = this.getOrCreateEntry(workspace);
        entry.activeReaders += 1;
        try {
            await this.ensureWatcher(entry);
            if (!this.isCurrentEntry(entry) || entry.disposed) {
                throw new WorkspaceGitSnapshotReleasedError();
            }
        }
        finally {
            this.finishRead(entry);
        }
    }
    /** Retires one workspace generation and closes every resource owned by it. */
    releaseWorkspace(workspace) {
        return releaseWorkspaceEntry(this.entries, workspace);
    }
    isCurrentSnapshot(workspace, snapshotId) {
        return isCurrentWorkspaceSnapshot(this.entries, workspace, snapshotId);
    }
    invalidate(workspace, options = {}) {
        const entry = this.getOrCreateEntry(workspace);
        const kind = options.kind ?? 'repository';
        this.advanceSnapshot(entry, kind, options.reason ?? 'manual');
        if (options.notify !== false) {
            this.publishChanged(entry, kind, options.reason ?? 'manual');
        }
        return entry.snapshotId;
    }
    /** Serializes product-owned Git writes and exposes only the final state to readers. */
    async runMutation(workspace, kind, operation) {
        const entry = this.getOrCreateEntry(workspace);
        entry.mutationReservations += 1;
        try {
            const previous = entry.mutationTail;
            const gate = createDeferred();
            entry.mutationTail = this.appendMutationBarrier(previous, gate.promise);
            await this.waitForSettledBarrier(previous);
            if (!this.isCurrentEntry(entry)) {
                gate.resolve();
                if (this.closed)
                    throw new WorkspaceGitSnapshotManagerClosedError();
                throw new WorkspaceGitSnapshotReleasedError();
            }
            entry.mutating = true;
            entry.mutationObservedKind = undefined;
            this.resolvePendingValidation(entry);
            this.advanceSnapshot(entry, kind);
            try {
                return await operation();
            }
            finally {
                const finalKind = this.mergeChangeKind(entry.mutationObservedKind, kind);
                entry.mutationObservedKind = undefined;
                entry.mutating = false;
                this.advanceSnapshot(entry, finalKind);
                try {
                    this.publishChanged(entry, finalKind, 'mutation');
                }
                finally {
                    gate.resolve();
                }
            }
        }
        finally {
            entry.mutationReservations -= 1;
            this.trimEntries();
        }
    }
    async appendMutationBarrier(previous, next) {
        await this.waitForSettledBarrier(previous);
        await next;
    }
    async waitForSettledBarrier(barrier) {
        try {
            await barrier;
        }
        catch {
            // A failed product operation cannot poison the workspace mutation queue.
        }
    }
    invalidateAll(reason = 'manual') {
        for (const entry of this.entries.values()) {
            this.advanceSnapshot(entry, 'repository', reason);
            this.publishChanged(entry, 'repository', reason);
        }
    }
    clear() {
        clearWorkspaceEntries(this.entries);
    }
    /** Permanently releases this runtime-owned manager and prevents resource resurrection. */
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.clear();
    }
    getOrCreateEntry(workspace) {
        if (this.closed)
            throw new WorkspaceGitSnapshotManagerClosedError();
        const existing = this.entries.get(workspace);
        if (existing) {
            existing.lastUsed = ++this.usageSequence;
            return existing;
        }
        this.evictIfNeeded();
        const observationKey = this.nextSnapshotId();
        const entry = {
            workspace,
            observationKey,
            activeBaseLoads: 0,
            activeFullLoads: 0,
            aliases: new Set(),
            snapshotId: observationKey,
            metadataRevision: 0,
            watcherHealthy: this.options.startWatcher === undefined,
            watcherSetup: Promise.resolve(),
            watcherSetupAttempts: 0,
            watcherSetupPending: false,
            watcherErrorReported: false,
            mutationTail: Promise.resolve(),
            mutating: false,
            mutationObservedKind: undefined,
            mutationReservations: 0,
            activeReaders: 0,
            lastUsed: ++this.usageSequence,
            disposed: false,
        };
        this.entries.set(workspace, entry);
        entry.watcherSetup = this.scheduleWatcherSetup(entry);
        return entry;
    }
    /**
     * A failed watcher is retried only when the next product read arrives. The
     * setup itself is singleflight, so progressive fast/full readers do not each
     * create a watcher and persistent failures do not create a background loop.
     */
    async ensureWatcher(entry) {
        const setupWasPending = entry.watcherSetupPending;
        await entry.watcherSetup;
        if (setupWasPending ||
            !this.options.startWatcher ||
            entry.watcherHealthy ||
            entry.readGenerationSnapshotId === entry.snapshotId ||
            !this.isCurrentEntry(entry)) {
            return;
        }
        await this.scheduleWatcherSetup(entry);
    }
    scheduleWatcherSetup(entry) {
        if (!this.options.startWatcher || entry.watcherSetupPending || !this.isCurrentEntry(entry)) {
            return entry.watcherSetup;
        }
        entry.watcherSetupPending = true;
        const recovering = entry.watcherSetupAttempts > 0;
        entry.watcherSetupAttempts += 1;
        const setup = this.startWatcherAndClearPending(entry, recovering);
        entry.watcherSetup = setup;
        return setup;
    }
    async startWatcherAndClearPending(entry, recovering) {
        try {
            await this.startWatcher(entry, recovering);
        }
        finally {
            entry.watcherSetupPending = false;
        }
    }
    async startWatcher(entry, recovering) {
        if (!this.options.startWatcher)
            return;
        let setupFailed = false;
        try {
            const watcher = await this.options.startWatcher(entry.workspace, {
                onPotentialChange: () => this.onPotentialChange(entry),
                onIgnoredOnly: () => this.onIgnoredOnly(entry),
                onChange: (kind) => this.onWatcherChange(entry, kind),
                onError: (error) => {
                    setupFailed = true;
                    this.onWatcherError(entry, error);
                },
            });
            if (!this.isCurrentEntry(entry) || setupFailed) {
                watcher.close();
                return;
            }
            entry.watcher = watcher;
            if (recovering)
                this.advanceSnapshot(entry, 'repository', 'recovery');
            entry.watcherHealthy = true;
            entry.watcherErrorCode = undefined;
            entry.watcherErrorReported = false;
        }
        catch (error) {
            if (!setupFailed)
                this.onWatcherError(entry, error);
        }
    }
    onPotentialChange(entry) {
        if (!this.isCurrentEntry(entry))
            return;
        if (entry.mutating) {
            return;
        }
        entry.pendingValidation ??= createDeferred();
    }
    onIgnoredOnly(entry) {
        if (!this.isCurrentEntry(entry))
            return;
        this.resolvePendingValidation(entry);
    }
    onWatcherChange(entry, kind) {
        if (!this.isCurrentEntry(entry))
            return;
        if (entry.mutating) {
            entry.mutationObservedKind = this.mergeChangeKind(entry.mutationObservedKind, kind);
            this.resolvePendingValidation(entry);
            return;
        }
        this.advanceSnapshot(entry, kind, 'watcher');
        this.resolvePendingValidation(entry);
        this.publishChanged(entry, kind, 'watcher');
    }
    onWatcherError(entry, error) {
        if (!this.isCurrentEntry(entry))
            return;
        const shouldPublish = !entry.watcherErrorReported;
        entry.watcherErrorReported = true;
        if (entry.mutating)
            entry.mutationObservedKind = 'repository';
        entry.watcher?.close();
        entry.watcher = undefined;
        entry.watcherHealthy = false;
        entry.watcherErrorCode = gitWatcherErrorCode(error);
        this.advanceSnapshot(entry, 'repository', 'watcher-error');
        this.resolvePendingValidation(entry);
        if (shouldPublish)
            this.publishChanged(entry, 'repository', 'watcher-error');
    }
    getBase(entry, trace) {
        if (trace)
            trace.base_compute_id = `${entry.snapshotId}:base`;
        if (entry.base?.snapshotId === entry.snapshotId) {
            addGitObservation(trace, 'base_cache_hits');
            return Promise.resolve(entry.base);
        }
        if (entry.baseRequest) {
            addGitObservation(trace, 'base_inflight_joins');
            return entry.baseRequest;
        }
        const snapshotId = entry.snapshotId;
        const request = this.loadBaseRequestAndClear(entry, snapshotId, trace);
        entry.baseRequest = request;
        return request;
    }
    async loadBaseRequestAndClear(entry, snapshotId, trace) {
        addGitObservation(trace, 'base_loads');
        entry.activeBaseLoads += 1;
        if (trace)
            trace.max_active_base_loads = Math.max(trace.max_active_base_loads ?? 0, entry.activeBaseLoads);
        try {
            const value = await measureGitRead(trace, 'base_compute_ms', () => this.options.loadBase(entry.workspace, trace));
            const result = { snapshotId, value };
            if (this.isStableResult(entry, snapshotId))
                entry.base = result;
            return result;
        }
        finally {
            entry.activeBaseLoads -= 1;
            if (entry.snapshotId === snapshotId)
                entry.baseRequest = undefined;
            this.trimEntries();
        }
    }
    getFull(entry, trace) {
        if (trace)
            trace.full_compute_id = `${entry.snapshotId}:full`;
        if (entry.full?.snapshotId === entry.snapshotId) {
            addGitObservation(trace, 'full_cache_hits');
            return Promise.resolve(entry.full);
        }
        if (entry.fullRequest) {
            addGitObservation(trace, 'full_inflight_joins');
            return entry.fullRequest;
        }
        const snapshotId = entry.snapshotId;
        const request = this.loadFullRequestAndClear(entry, snapshotId, trace);
        entry.fullRequest = request;
        return request;
    }
    async loadFullRequestAndClear(entry, snapshotId, trace) {
        addGitObservation(trace, 'full_loads');
        entry.activeFullLoads += 1;
        if (trace)
            trace.max_active_full_loads = Math.max(trace.max_active_full_loads ?? 0, entry.activeFullLoads);
        try {
            const base = await measureGitRead(trace, 'base_wait_ms', () => this.getBase(entry, trace));
            await measureGitRead(trace, 'classification_wait_ms', () => this.waitForPathClassification(entry));
            if (!this.isStableResult(entry, base.snapshotId)) {
                throw new StaleWorkspaceGitSnapshotError();
            }
            const value = await measureGitRead(trace, 'full_compute_ms', () => this.options.loadFull(entry.workspace, base.value, trace));
            const result = { snapshotId, value };
            if (this.isStableResult(entry, snapshotId))
                entry.full = result;
            return result;
        }
        finally {
            entry.activeFullLoads -= 1;
            if (entry.snapshotId === snapshotId)
                entry.fullRequest = undefined;
            this.trimEntries();
        }
    }
    startMetadataRequest(entry, revision, loader) {
        const request = this.loadMetadataRequestAndClear(entry, revision, loader);
        entry.metadataRequest = request;
        return request;
    }
    async loadMetadataRequestAndClear(entry, revision, loader) {
        try {
            const value = await loader(entry.workspace);
            if (this.isStableMetadata(entry, revision))
                entry.metadata = value;
            return { revision, value };
        }
        finally {
            if (entry.metadataRevision === revision)
                entry.metadataRequest = undefined;
            this.trimEntries();
        }
    }
    advanceSnapshot(entry, kind, reason = 'mutation') {
        entry.lastInvalidationReason = reason;
        entry.snapshotId = this.nextSnapshotId();
        entry.readGenerationSnapshotId = undefined;
        entry.base = undefined;
        entry.full = undefined;
        entry.baseRequest = undefined;
        entry.fullRequest = undefined;
        if (kind === 'repository') {
            entry.metadata = undefined;
            entry.metadataRevision += 1;
            entry.metadataRequest = undefined;
        }
    }
    publishChanged(entry, kind, reason) {
        const onChanged = this.options.onChanged;
        publishWorkspaceGitChanged({
            entry,
            kind,
            reason,
            ...(onChanged
                ? {
                    onChanged: (event) => {
                        try {
                            onChanged(event);
                        }
                        catch {
                            // The repository/file mutation and snapshot transition already
                            // committed. Delivery is best-effort and cannot turn that
                            // successful product operation into a caller-visible failure.
                        }
                        finally {
                            this.trimEntries();
                        }
                    },
                }
                : { onChanged: undefined }),
            notificationWindowMs: this.changeNotificationWindowMs,
            isCurrent: () => this.isCurrentEntry(entry),
        });
    }
    canReuseCompleted(entry) {
        return (this.reuseCompletedResults &&
            entry.watcherHealthy &&
            !entry.pendingValidation &&
            !entry.mutating &&
            entry.mutationReservations === 0 &&
            !entry.disposed);
    }
    mergeChangeKind(current, next) {
        return current === 'repository' || next === 'repository' ? 'repository' : 'workspace';
    }
    /**
     * An unhealthy watcher cannot prove that two sequential physical reads saw
     * the same repository state. Give each standalone read a fresh identity,
     * while concurrent fast/full/metadata readers still join the active work.
     */
    beginReadGeneration(entry) {
        if (this.canReuseCompleted(entry))
            return;
        if (entry.readGenerationSnapshotId === entry.snapshotId)
            return;
        this.advanceSnapshot(entry, 'repository', 'unhealthy-watcher');
        entry.readGenerationSnapshotId = entry.snapshotId;
    }
    isStableResult(entry, snapshotId) {
        return (this.isCurrentEntry(entry) &&
            !entry.mutating &&
            !entry.pendingValidation &&
            entry.snapshotId === snapshotId);
    }
    isCurrentEntry(entry) {
        return !entry.disposed && this.entries.get(entry.workspace) === entry;
    }
    async waitForPathClassification(entry) {
        while (entry.pendingValidation)
            await entry.pendingValidation.promise;
    }
    async waitForReadBarrier(entry, trace) {
        await measureGitRead(trace, 'mutation_wait_ms', () => entry.mutationTail);
        await measureGitRead(trace, 'classification_wait_ms', () => this.waitForPathClassification(entry));
    }
    resolvePendingValidation(entry) {
        const pending = entry.pendingValidation;
        entry.pendingValidation = undefined;
        pending?.resolve();
    }
    evictIfNeeded() {
        if (this.entries.size < this.maxWorkspaces)
            return;
        evictOldestIdleWorkspaceEntry(this.entries);
    }
    trimEntries() {
        trimIdleWorkspaceEntries(this.entries, this.maxWorkspaces);
    }
    nextSnapshotId() {
        this.snapshotSequence += 1;
        return `${this.instanceId}:${this.snapshotSequence}`;
    }
}
//# sourceMappingURL=snapshot-manager.js.map