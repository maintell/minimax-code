import { AsyncSemaphore, normalizeWorkspaceIndexingConcurrency } from './async-semaphore.js';
import { resolveWorkspaceCollectionPolicy, } from './collection-policy.js';
import { KeyedOperationQueue } from './keyed-operation-queue.js';
import { WorkspaceIndexingMetrics } from './metrics.js';
import { WorkspaceIndexingCancellations } from './revision-cancellation.js';
import { normalizeWorkspaceRevisionSchedule } from './revision-context.js';
import { WorkspaceRevisionPolicyGate } from './revision-policy-gate.js';
import { WorkspaceRevisionRunner } from './revision-runner.js';
const DEFAULT_MAX_CONCURRENT_REVISIONS = 2;
const DEFAULT_MAX_CONCURRENT_INSTALLS = 1;
/**
 * Schedules remote indexing work: which Revisions are due, how many run at
 * once, and when a session's work stops. What a due Revision actually does is
 * owned by `WorkspaceRevisionRunner`, so a stage can never reach the in-flight
 * table or the poll timer.
 */
export class WorkspaceIndexingRemoteWorker {
    store;
    isEnabled;
    nowMs;
    metrics;
    getCollectionPolicy;
    policyWorkspaceVersion;
    cancellations = new WorkspaceIndexingCancellations();
    runner;
    revisionSemaphore;
    inFlight = new Map();
    sessionOperations = new KeyedOperationQueue();
    timer;
    constructor(options) {
        this.store = options.store;
        this.isEnabled = options.isEnabled ?? (async () => true);
        this.nowMs = options.nowMs ?? Date.now;
        this.metrics = options.metrics ?? new WorkspaceIndexingMetrics();
        this.getCollectionPolicy = options.getCollectionPolicy;
        this.policyWorkspaceVersion = resolveWorkspaceCollectionPolicy(this.getCollectionPolicy).workspaceVersion;
        this.revisionSemaphore = new AsyncSemaphore(normalizeWorkspaceIndexingConcurrency(options.maxConcurrentRevisions, DEFAULT_MAX_CONCURRENT_REVISIONS));
        this.runner = new WorkspaceRevisionRunner({
            store: options.store,
            remote: options.remote,
            semanticIndexStore: options.semanticIndexStore,
            installSemaphore: new AsyncSemaphore(normalizeWorkspaceIndexingConcurrency(options.maxConcurrentInstalls, DEFAULT_MAX_CONCURRENT_INSTALLS)),
            policy: new WorkspaceRevisionPolicyGate({
                store: options.store,
                getCollectionPolicy: options.getCollectionPolicy,
                readManifest: options.readManifest,
            }),
            cancellations: this.cancellations,
            metrics: this.metrics,
            schedule: normalizeWorkspaceRevisionSchedule(options),
            isEnabled: this.isEnabled,
            nowMs: this.nowMs,
            createObservationSink: options.createObservationSink,
            onError: options.onError,
        });
    }
    start(intervalMs = 5_000) {
        if (this.timer)
            return;
        void this.processDue();
        this.timer = setInterval(() => void this.processDue(), Math.max(250, intervalMs));
        this.timer.unref?.();
    }
    close() {
        clearInterval(this.timer);
        this.timer = undefined;
        for (const active of this.inFlight.values())
            active.controller.abort();
    }
    enqueue(revisionId) {
        void this.isEnabled()
            .then((enabled) => {
            if (!enabled)
                return;
            return this.store
                .patchRevision(revisionId, {
                nextRetryAtMs: this.nowMs(),
                updatedAtMs: this.nowMs(),
            })
                .then(() => this.processRevisionById(revisionId));
        })
            .catch(() => undefined);
    }
    async cancelSession(sessionId) {
        this.cancellations.cancel(sessionId);
        const active = [...this.inFlight.values()].filter((entry) => entry.sessionId === sessionId);
        for (const entry of active)
            entry.controller.abort();
        await Promise.allSettled(active.map((entry) => entry.done));
    }
    resumeSession(sessionId) {
        this.cancellations.resume(sessionId);
    }
    /**
     * Called synchronously after the owner replaces the live policy. Cancel the
     * old Workspace attempt before yielding; the next dispatch rechecks its
     * immutable manifest chain without spending a transport retry.
     */
    notifyCollectionPolicyChanged() {
        const version = resolveWorkspaceCollectionPolicy(this.getCollectionPolicy).workspaceVersion;
        if (version === this.policyWorkspaceVersion)
            return;
        this.policyWorkspaceVersion = version;
        for (const active of this.inFlight.values())
            active.controller.abort();
    }
    async processDue(limit = 10) {
        if (!(await this.isEnabled().catch(() => false)))
            return;
        const nowMs = this.nowMs();
        const records = await this.store.listRemoteWork(nowMs, limit).catch(() => []);
        // Reported from a dedicated count rather than the fetched page, so the
        // gauge does not silently saturate at the batch limit.
        const backlog = await this.store
            .countRemoteWork(nowMs)
            .catch(() => ({ pending: records.length, oldestCreatedAtMs: undefined }));
        this.metrics.backlog(backlog.pending, backlog.oldestCreatedAtMs === undefined ? 0 : Math.max(0, nowMs - backlog.oldestCreatedAtMs));
        await Promise.all(records
            .filter((record) => !this.cancellations.isSessionCancelled(record.sessionId))
            .map((record) => this.processRevision(record)));
    }
    async processRevisionById(revisionId) {
        if (!(await this.isEnabled().catch(() => false)))
            return;
        const record = await this.store.getRevision(revisionId);
        if (record && !this.cancellations.isSessionCancelled(record.sessionId)) {
            await this.processRevision(record);
        }
    }
    /**
     * Admits one Revision into the dispatch table. A Revision already in flight
     * is joined rather than started twice, and a session runs its Revisions in
     * arrival order so two dispatches never race on the same capture chain.
     */
    processRevision(record) {
        if (this.cancellations.isSessionCancelled(record.sessionId))
            return Promise.resolve();
        const existing = this.inFlight.get(record.revisionId);
        if (existing)
            return existing.done;
        const controller = new AbortController();
        const done = this.sessionOperations
            .run(record.sessionId, () => this.runRevisionWithConcurrency(record, controller.signal))
            .finally(() => {
            if (this.inFlight.get(record.revisionId)?.done === done) {
                this.inFlight.delete(record.revisionId);
                this.metrics.inflight('upload', this.inFlight.size);
            }
        });
        this.inFlight.set(record.revisionId, {
            sessionId: record.sessionId,
            controller,
            done,
        });
        this.metrics.inflight('upload', this.inFlight.size);
        return done;
    }
    async runRevisionWithConcurrency(record, signal) {
        try {
            await this.revisionSemaphore.run(() => this.runner.run(record, signal), signal);
        }
        catch (error) {
            // Only reachable when the dispatch itself could not run — the runner
            // already resolves every outcome a started attempt can reach.
            if (!this.cancellations.isCancelled(record.sessionId, signal, error)) {
                this.runner.reportError(record, error);
            }
        }
    }
}
//# sourceMappingURL=remote-worker.js.map