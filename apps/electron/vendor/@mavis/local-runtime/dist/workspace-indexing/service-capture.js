import { rm } from 'node:fs/promises';
import { resolveWorkspaceCollectionPolicy } from './collection-policy.js';
import { assertSameWorkspaceBinding, normalizeWorkspaceIndexingErrorCode, toSkippedResult, } from './service-helpers.js';
import { readWorkspaceCaptureManifest, toWorkspaceIndexingRevisionRecord, } from './workspace-artifact-store.js';
/**
 * Produces one committed Workspace Revision: stable scan, artifact build,
 * store commit, remote enqueue. Every method assumes the caller already holds
 * the per-Session lane, and none of them time, report, or classify the
 * outcome — that stays with the Service that owns the public contract.
 */
export class WorkspaceIndexingCaptureRunner {
    dataDir;
    store;
    prewarm;
    scan;
    scanOptions;
    createCapture;
    bindPreparedSnapshot;
    enqueueRemote;
    makeId;
    nowMs;
    maxScanAttempts;
    onWeakDependencyError;
    constructor(options) {
        this.dataDir = options.dataDir;
        this.store = options.store;
        this.prewarm = options.prewarm;
        this.scan = options.scanWorkspace;
        this.scanOptions = options.scanOptions;
        this.createCapture = options.createCapture;
        this.bindPreparedSnapshot = options.bindPreparedSnapshot;
        this.enqueueRemote = options.enqueueRemote;
        this.makeId = options.makeId;
        this.nowMs = options.nowMs;
        this.maxScanAttempts = options.maxScanAttempts;
        this.onWeakDependencyError = options.onWeakDependencyError;
    }
    /**
     * Identity of the collection rules a capture would apply right now. Session
     * records carry it so a stored verdict can be recognised as stale.
     */
    policyWorkspaceVersion() {
        return resolveWorkspaceCollectionPolicy(this.scanOptions.getCollectionPolicy).workspaceVersion;
    }
    /**
     * Captures the Session's first Revision from a prewarmed snapshot, retrying
     * inside the coordinator whenever the Workspace mutated mid-capture.
     */
    async captureInitial(input, existing, signal) {
        return this.prewarm.withCleanWorkspace(input.workspaceDir, signal, async (outcome, confirmCurrent) => {
            if (outcome.status === 'skipped_limit') {
                return this.commitInitialLimit(input, existing, outcome);
            }
            return this.commitPreparedInitial(input, existing, outcome.snapshot, confirmCurrent, signal);
        });
    }
    /**
     * Captures one Revision on top of the Session's latest one. Runs inside the
     * per-Session lane so a capture, a deletion, and a Session start can never
     * interleave on the same Session.
     */
    async captureRevision(input) {
        const session = await this.store.getSession(input.sessionId);
        const latest = await this.store.getLatestRevision(input.sessionId);
        if (!session || !latest || !session.initialRevisionId)
            return { status: 'not_prepared' };
        await assertSameWorkspaceBinding(session, input.workspaceDir);
        const scan = await this.scanStable(input.workspaceDir, this.maxScanAttempts);
        if (scan.status === 'skipped_limit') {
            await this.store.putSession({
                ...session,
                status: 'skipped_limit',
                skipReason: scan.reason,
                policyWorkspaceVersion: scan.policy.workspaceVersion,
                updatedAtMs: this.nowMs(),
            });
            return toSkippedResult(scan);
        }
        if (scan.workspaceId !== session.workspaceId) {
            throw new Error('workspace_session_binding_mismatch');
        }
        if (scan.rootHash === latest.rootHash) {
            // Identical content produces no new Revision and therefore no upload:
            // an idle Workspace must never re-send bytes the backend already has.
            if (session.status !== 'ready' ||
                session.skipReason ||
                session.latestRevisionId !== latest.revisionId ||
                session.latestRootHash !== latest.rootHash ||
                session.policyWorkspaceVersion !== scan.policy.workspaceVersion) {
                await this.store.putSession({
                    ...session,
                    status: 'ready',
                    latestRevisionId: latest.revisionId,
                    latestRootHash: latest.rootHash,
                    skipReason: undefined,
                    policyWorkspaceVersion: scan.policy.workspaceVersion,
                    updatedAtMs: this.nowMs(),
                });
            }
            return { status: 'unchanged', revisionId: latest.revisionId };
        }
        const previousManifest = await readWorkspaceCaptureManifest(latest.manifestPath);
        const nowMs = this.nowMs();
        const revisionId = this.makeId('revision');
        const artifact = await this.createCapture({
            dataDir: this.dataDir,
            sessionId: input.sessionId,
            revisionId,
            workspaceDir: input.workspaceDir,
            scan,
            kind: 'revision',
            previousManifest,
            createdAtMs: nowMs,
        });
        const record = await toWorkspaceIndexingRevisionRecord(artifact, latest.sequence + 1, nowMs);
        await this.store.commitCapture({
            ...session,
            status: 'ready',
            latestRevisionId: revisionId,
            latestRootHash: scan.rootHash,
            skipReason: undefined,
            policyWorkspaceVersion: scan.policy.workspaceVersion,
            updatedAtMs: nowMs,
        }, record);
        await this.enqueueRemoteWeakly(record);
        return {
            status: 'captured',
            kind: 'revision',
            revisionId,
            rootHash: scan.rootHash,
            fileCount: scan.files.length,
            totalBytes: scan.totalBytes,
        };
    }
    async commitInitialLimit(input, existing, scan) {
        const nowMs = this.nowMs();
        await this.store.putSession({
            sessionId: input.sessionId,
            workspaceId: scan.workspaceId,
            workspaceRealPath: scan.workspaceRealPath,
            status: 'skipped_limit',
            createdAtMs: existing?.createdAtMs ?? nowMs,
            updatedAtMs: nowMs,
            skipReason: scan.reason,
            policyWorkspaceVersion: scan.policy.workspaceVersion,
        });
        return toSkippedResult(scan);
    }
    async commitPreparedInitial(input, existing, prepared, confirmCurrent, signal) {
        signal.throwIfAborted();
        const nowMs = this.nowMs();
        const revisionId = this.makeId('revision');
        const artifact = await this.bindPreparedSnapshot({
            dataDir: this.dataDir,
            prepared,
            sessionId: input.sessionId,
            revisionId,
            createdAtMs: nowMs,
            signal,
        });
        let committed = false;
        try {
            signal.throwIfAborted();
            if (!(await confirmCurrent())) {
                throw new Error('workspace_changed_during_capture:final_validation');
            }
            signal.throwIfAborted();
            const revision = await toWorkspaceIndexingRevisionRecord(artifact, 0, nowMs);
            signal.throwIfAborted();
            await this.store.commitCapture({
                sessionId: input.sessionId,
                workspaceId: prepared.scan.workspaceId,
                workspaceRealPath: prepared.scan.workspaceRealPath,
                status: 'ready',
                initialRevisionId: revisionId,
                latestRevisionId: revisionId,
                latestRootHash: prepared.scan.rootHash,
                createdAtMs: existing?.createdAtMs ?? nowMs,
                updatedAtMs: nowMs,
                policyWorkspaceVersion: prepared.scan.policy.workspaceVersion,
            }, revision);
            committed = true;
            await this.enqueueRemoteWeakly(revision);
            return {
                status: 'captured',
                kind: 'initial',
                revisionId,
                rootHash: prepared.scan.rootHash,
                fileCount: prepared.scan.files.length,
                totalBytes: prepared.scan.totalBytes,
            };
        }
        catch (error) {
            if (!committed)
                await rm(artifact.captureDir, { recursive: true, force: true });
            throw error;
        }
    }
    async scanStable(workspaceDir, attempts, signal) {
        let lastError;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                return await this.scan(workspaceDir, {
                    ...this.scanOptions,
                    ...(signal ? { signal } : {}),
                });
            }
            catch (error) {
                signal?.throwIfAborted();
                lastError = error;
            }
        }
        throw lastError instanceof Error ? lastError : new Error('workspace_scan_failed');
    }
    async enqueueRemoteWeakly(record) {
        try {
            await this.enqueueRemote(record.revisionId);
        }
        catch (error) {
            this.onWeakDependencyError?.({
                stage: 'enqueue_remote',
                sessionId: record.sessionId,
                revisionId: record.revisionId,
                code: normalizeWorkspaceIndexingErrorCode(error),
            });
        }
    }
}
//# sourceMappingURL=service-capture.js.map