import path from 'node:path';
import { createWorkspaceCapture } from './capture.js';
import { emitWorkspaceIndexingObservation, resolveWorkspaceIndexingObservationSink, WorkspaceIndexingMetrics, } from './metrics.js';
import { normalizeInitialPreparationTimeoutMs, runInitialPreparationWithDeadline, } from './initial-preparation-deadline.js';
import { KeyedOperationQueue } from './keyed-operation-queue.js';
import { bindWorkspacePreparedSnapshot, } from './prepared-snapshot.js';
import { WorkspacePrewarmCoordinator, } from './prewarm-coordinator.js';
import { scanWorkspace as scanWorkspaceDefault, } from './scanner.js';
import { WorkspaceIndexingCaptureRunner } from './service-capture.js';
import { WorkspaceInitialSnapshotError, } from './service-types.js';
import { WorkspaceSemanticIndexStore } from './semantic-index-store.js';
import { assertSameWorkspaceBinding, normalizeWorkspaceIndexingErrorCode, sha256, } from './service-helpers.js';
import { deleteLocalWorkspaceArtifacts } from './workspace-artifact-store.js';
const DEFAULT_INITIAL_SCAN_ATTEMPTS = 2;
/**
 * Metric and observation shape per terminal preparation status. `observed`
 * absent means the status is real bookkeeping but not a user-visible
 * lifecycle change, so the business layer never sees it.
 */
const PREPARE_REPORT_BY_STATUS = {
    captured: { outcome: 'success', reason: 'none', observed: 'success' },
    already_prepared: { outcome: 'cache_hit', reason: 'none', observed: 'success' },
    skipped_limit: { outcome: 'skipped_limit', reason: 'none', observed: 'skipped_limit' },
    skipped_timeout: { outcome: 'timeout', reason: 'timeout', observed: 'timeout' },
    disabled: { outcome: 'disabled', reason: 'disabled', observed: 'disabled' },
    unchanged: { outcome: 'unchanged', reason: 'unchanged' },
    not_prepared: { outcome: 'unavailable', reason: 'not_prepared' },
    no_session: undefined,
    no_workspace: undefined,
};
export { WorkspaceInitialSnapshotError } from './service-types.js';
export class WorkspaceIndexingService {
    dataDir;
    store;
    isEnabled;
    prewarm;
    capture;
    deleteArtifacts;
    semanticIndexStore;
    cancelRemote;
    resumeRemote;
    nowMs;
    initialPreparationTimeoutMs;
    operations = new KeyedOperationQueue();
    metrics;
    createObservationSink;
    onWeakDependencyError;
    constructor(options) {
        this.dataDir = options.dataDir;
        this.store = options.store;
        this.isEnabled = options.isEnabled;
        const scan = options.scanWorkspace ?? scanWorkspaceDefault;
        const scanOptions = options.scanOptions ?? {};
        this.metrics = options.metrics ?? new WorkspaceIndexingMetrics();
        this.createObservationSink = options.createObservationSink;
        this.nowMs = options.nowMs ?? Date.now;
        const maxScanAttempts = Math.max(1, Math.floor(options.maxInitialScanAttempts ?? DEFAULT_INITIAL_SCAN_ATTEMPTS));
        this.initialPreparationTimeoutMs = normalizeInitialPreparationTimeoutMs(options.initialPreparationTimeoutMs);
        this.prewarm = new WorkspacePrewarmCoordinator({
            dataDir: options.dataDir,
            isEnabled: options.isEnabled,
            scanWorkspace: scan,
            isWorkspaceScanCurrent: options.isWorkspaceScanCurrent,
            scanOptions,
            createPreparedSnapshot: options.createPreparedSnapshot,
            watchWorkspace: options.watchWorkspace,
            prewarmRefreshDebounceMs: options.prewarmRefreshDebounceMs,
            maxInitialScanAttempts: maxScanAttempts,
            initialPreparationTimeoutMs: this.initialPreparationTimeoutMs,
            nowMs: this.nowMs,
            metrics: this.metrics,
        });
        this.semanticIndexStore =
            options.semanticIndexStore ??
                new WorkspaceSemanticIndexStore({ dataDir: options.dataDir, nowMs: options.nowMs });
        this.deleteArtifacts = options.deleteLocalArtifacts ?? deleteLocalWorkspaceArtifacts;
        this.cancelRemote = options.cancelRemote ?? (async () => undefined);
        this.resumeRemote = options.resumeRemote ?? (() => undefined);
        this.onWeakDependencyError = options.onWeakDependencyError;
        this.capture = new WorkspaceIndexingCaptureRunner({
            dataDir: options.dataDir,
            store: options.store,
            prewarm: this.prewarm,
            scanWorkspace: scan,
            scanOptions,
            createCapture: options.createCapture ?? createWorkspaceCapture,
            bindPreparedSnapshot: options.bindPreparedSnapshot ?? bindWorkspacePreparedSnapshot,
            enqueueRemote: options.enqueueRemote ?? (() => undefined),
            makeId: options.makeId ??
                ((prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`),
            nowMs: this.nowMs,
            maxScanAttempts,
            onWeakDependencyError: options.onWeakDependencyError,
        });
    }
    /**
     * Prepares a reusable immutable Workspace artifact before a Session exists.
     * Callers schedule this method in the background; Session startup later
     * validates and binds the artifact in a cheap local transaction.
     */
    async prewarmWorkspace(workspaceDir) {
        return this.prewarm.prewarmWorkspace(workspaceDir);
    }
    /** Stops best-effort refresh work. Session and Revision state are untouched. */
    closeWorkspacePrewarm() {
        this.prewarm.close();
    }
    async prepareSessionStart(input) {
        return this.prepareSessionStartForSession(input.sessionId, async () => input);
    }
    /**
     * Resolves the owning Session inside the same per-Session lane used by
     * deletion. This prevents a stale Session lookup from recreating indexing
     * state after deletion has already cleaned it.
     */
    async prepareSessionStartForSession(sessionId, resolveSession) {
        // Measured around the per-Session lane, so the histogram reports the time
        // the Agent start gate was actually blocked — queue wait included — rather
        // than the isolated scan cost.
        const startedMs = this.nowMs();
        // Bound before the lane is entered: this preparation reports to whoever
        // owned it when it was requested, however long it then waits in the queue.
        const sink = resolveWorkspaceIndexingObservationSink(this.createObservationSink);
        try {
            const result = await this.operations.run(sessionId, async () => {
                if (!(await this.isEnabled()))
                    return { status: 'disabled' };
                const resolved = await resolveSession();
                if ('status' in resolved)
                    return resolved;
                if (resolved.sessionId !== sessionId) {
                    throw new Error('workspace_session_lookup_mismatch');
                }
                const lockedExisting = await this.store.getSession(sessionId);
                const lockedResult = await this.getExistingPreparationResult(resolved, lockedExisting);
                if (lockedResult)
                    return lockedResult;
                const outcome = await runInitialPreparationWithDeadline(this.initialPreparationTimeoutMs, (signal) => this.capture.captureInitial(resolved, lockedExisting, signal));
                if (outcome.status === 'completed')
                    return outcome.value;
                const nowMs = this.nowMs();
                const workspaceRealPath = path.resolve(resolved.workspaceDir);
                await this.store.putSession({
                    sessionId,
                    workspaceId: sha256(Buffer.from(workspaceRealPath, 'utf8')),
                    workspaceRealPath,
                    status: 'skipped_timeout',
                    createdAtMs: lockedExisting?.createdAtMs ?? nowMs,
                    updatedAtMs: nowMs,
                    skipReason: 'timeout',
                    policyWorkspaceVersion: this.capture.policyWorkspaceVersion(),
                });
                return {
                    status: 'skipped_timeout',
                    timeoutMs: this.initialPreparationTimeoutMs,
                };
            });
            this.reportPreparation(sink, result, this.nowMs() - startedMs);
            return result;
        }
        catch (error) {
            const durationMs = this.nowMs() - startedMs;
            this.metrics.attempt({ stage: 'prepare', outcome: 'failed', durationMs });
            this.metrics.result({ stage: 'prepare', outcome: 'failed', reason: 'error' });
            this.observe(sink, { stage: 'prepare', outcome: 'failed', durationMs });
            if (error instanceof WorkspaceInitialSnapshotError)
                throw error;
            throw new WorkspaceInitialSnapshotError({ cause: error });
        }
    }
    /**
     * Translates one preparation or revision result into a single attempt
     * sample, a single logical result, and at most one business observation.
     * `no_session` / `no_workspace` are eligibility verdicts owned by the host
     * start gate, so they are deliberately not reported as preparation outcomes.
     */
    reportPreparation(sink, result, durationMs) {
        const mapped = PREPARE_REPORT_BY_STATUS[result.status];
        if (!mapped)
            return;
        const kind = result.status === 'captured' ? result.kind : undefined;
        const reason = result.status === 'skipped_limit' ? result.reason : mapped.reason;
        this.metrics.attempt({
            stage: 'prepare',
            outcome: mapped.outcome,
            durationMs,
            ...(kind ? { kind } : {}),
        });
        this.metrics.result({
            stage: 'prepare',
            outcome: mapped.outcome,
            reason,
            ...(kind ? { kind } : {}),
        });
        if (!mapped.observed)
            return;
        this.observe(sink, {
            stage: 'prepare',
            outcome: mapped.observed,
            durationMs,
            ...(kind ? { kind } : {}),
            ...(result.status === 'captured'
                ? { fileCount: result.fileCount, totalBytes: result.totalBytes }
                : {}),
        });
    }
    observe(sink, event) {
        emitWorkspaceIndexingObservation(sink, {
            ...event,
            timestampMs: event.timestampMs ?? this.nowMs(),
        });
    }
    async getExistingPreparationResult(input, existing) {
        if (!existing)
            return undefined;
        await assertSameWorkspaceBinding(existing, input.workspaceDir);
        if (existing.initialRevisionId && existing.latestRevisionId) {
            const latest = await this.store.getRevision(existing.latestRevisionId);
            if (latest) {
                return { status: 'already_prepared', revisionId: existing.latestRevisionId };
            }
        }
        // A skip decided under a different collection policy is stale: a wider
        // exclusion set can drop the Workspace back under the limits, and a
        // narrower one can push it over. Fall through to one fresh attempt instead
        // of replaying a verdict the current rules never produced.
        if (existing.policyWorkspaceVersion !== this.capture.policyWorkspaceVersion())
            return undefined;
        if (existing.status === 'skipped_limit' &&
            (existing.skipReason === 'file_count' || existing.skipReason === 'total_bytes')) {
            return { status: 'skipped_limit', reason: existing.skipReason };
        }
        if (existing.status === 'skipped_timeout') {
            return { status: 'skipped_timeout', timeoutMs: this.initialPreparationTimeoutMs };
        }
        return undefined;
    }
    async captureRevisionIfChanged(input) {
        // Same binding rule as Session start, and for the same reason: the Turn
        // that triggered this capture owns its outcome.
        const sink = resolveWorkspaceIndexingObservationSink(this.createObservationSink);
        if (!(await this.isEnabled()))
            return { status: 'disabled' };
        const startedMs = this.nowMs();
        const result = await this.operations
            .run(input.sessionId, () => this.capture.captureRevision(input))
            .catch((error) => {
            // Per-Turn capture is the busiest path in a live Session, so a failure
            // here must land in the same attempt/result series as a Session-start
            // failure; otherwise `kind=revision` reads as permanently healthy.
            const durationMs = this.nowMs() - startedMs;
            this.metrics.attempt({
                stage: 'prepare',
                outcome: 'failed',
                durationMs,
                kind: 'revision',
            });
            this.metrics.result({
                stage: 'prepare',
                outcome: 'failed',
                reason: 'error',
                kind: 'revision',
            });
            this.observe(sink, { stage: 'prepare', outcome: 'failed', durationMs, kind: 'revision' });
            throw error;
        });
        this.reportPreparation(sink, result, this.nowMs() - startedMs);
        return result;
    }
    async deleteSession(sessionId, completeSessionDeletion) {
        await this.operations.run(sessionId, async () => {
            try {
                await this.cancelRemote(sessionId);
                const session = await this.store.getSession(sessionId);
                if (session) {
                    const revisions = await this.store.listRevisions(sessionId);
                    try {
                        await this.deleteArtifacts(this.dataDir, this.semanticIndexStore, session, revisions);
                    }
                    catch (error) {
                        this.onWeakDependencyError?.({
                            stage: 'delete_local_artifacts',
                            sessionId,
                            revisionId: revisions.at(-1)?.revisionId ?? 'none',
                            code: normalizeWorkspaceIndexingErrorCode(error),
                        });
                        throw error;
                    }
                    await this.store.deleteSession(sessionId);
                }
                await completeSessionDeletion?.();
            }
            finally {
                this.resumeRemote(sessionId);
            }
        });
    }
}
//# sourceMappingURL=service.js.map