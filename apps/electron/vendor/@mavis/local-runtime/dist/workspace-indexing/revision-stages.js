import { rm, stat } from 'node:fs/promises';
import { observeRevision, resumeRemoteState, } from './revision-context.js';
/**
 * Drives one Revision as far as its current state allows: uploaded,
 * registered, and — once the remote build reports `ready` — downloaded and
 * installed. Each stage persists its own checkpoint before the next begins, so
 * a fault or a shutdown resumes here instead of repeating finished work.
 *
 * Every stage returning `undefined` means indexing was switched off underneath
 * the dispatch; the Revision keeps its checkpoints and is picked up again once
 * it is re-enabled.
 */
export async function advanceRevision(original, signal, ctx, progress) {
    let record = original;
    ctx.cancellations.assertActive(record.sessionId, signal);
    if (record.remoteState === 'ready' || record.remoteState === 'failed_terminal')
        return;
    // Queued, retrying, and resumed Revisions all enter here, so one check at
    // the top covers every path that could still push bytes outward.
    await ctx.policy.assertCompliant(record, signal);
    if (record.remoteState === 'retry_wait') {
        record = { ...record, remoteState: resumeRemoteState(record) };
    }
    if (record.remoteState === 'pending_upload') {
        const uploaded = await uploadCapture(record, signal, ctx, progress);
        if (!uploaded)
            return;
        record = uploaded;
    }
    if (record.remoteState === 'pending_registration') {
        const registered = await registerRevision(record, signal, ctx, progress);
        if (!registered)
            return;
        record = registered;
    }
    if (record.remoteState !== 'indexing' && record.remoteState !== 'pending_download')
        return;
    await materializeIndex(record, signal, ctx, progress);
}
/** Transfers the capture archive and its manifest, one checkpoint each. */
async function uploadCapture(record, signal, ctx, progress) {
    progress.stage = 'upload';
    let archiveOssKey = record.archiveOssKey;
    let manifestOssKey = record.manifestOssKey;
    if (!archiveOssKey) {
        if (!(await ctx.isEnabled()))
            return undefined;
        // Validate each new transfer. Live policy updates separately abort the
        // active attempt; neither check can recall bytes already sent.
        await ctx.policy.assertCompliant(record, signal);
        const startedMs = ctx.nowMs();
        archiveOssKey = await uploadTracked(record, 'archive', ctx, {
            localPath: record.archivePath,
            filename: 'workspace.zip',
            mimeType: 'application/zip',
            category: 'workspace-capture',
            sessionId: record.sessionId,
            revisionId: record.revisionId,
            signal,
        });
        ctx.cancellations.assertActive(record.sessionId, signal);
        ctx.metrics.attempt({
            stage: 'upload',
            outcome: 'success',
            kind: record.kind,
            durationMs: ctx.nowMs() - startedMs,
        });
        await ctx.store.patchRevision(record.revisionId, {
            archiveOssKey,
            updatedAtMs: ctx.nowMs(),
        });
    }
    if (!manifestOssKey) {
        if (!(await ctx.isEnabled()))
            return undefined;
        await ctx.policy.assertCompliant(record, signal);
        const startedMs = ctx.nowMs();
        manifestOssKey = await uploadTracked(record, 'manifest', ctx, {
            localPath: record.manifestPath,
            filename: 'manifest.json',
            mimeType: 'application/json',
            category: 'workspace-manifest',
            sessionId: record.sessionId,
            revisionId: record.revisionId,
            signal,
        });
        ctx.cancellations.assertActive(record.sessionId, signal);
        ctx.metrics.attempt({
            stage: 'upload',
            outcome: 'success',
            kind: record.kind,
            durationMs: ctx.nowMs() - startedMs,
        });
        await ctx.store.patchRevision(record.revisionId, {
            manifestOssKey,
            updatedAtMs: ctx.nowMs(),
        });
    }
    ctx.cancellations.assertActive(record.sessionId, signal);
    const uploaded = {
        ...record,
        archiveOssKey,
        manifestOssKey,
        remoteState: 'pending_registration',
    };
    ctx.metrics.result({ stage: 'upload', outcome: 'success', kind: uploaded.kind });
    await ctx.store.patchRevision(uploaded.revisionId, {
        remoteState: 'pending_registration',
        updatedAtMs: ctx.nowMs(),
    });
    return uploaded;
}
/** Publishes the uploaded objects so the remote side can build the index. */
async function registerRevision(record, signal, ctx, progress) {
    progress.stage = 'register';
    if (!(await ctx.isEnabled()))
        return undefined;
    if (!record.archiveOssKey || !record.manifestOssKey) {
        throw Object.assign(new Error('workspace_remote_upload_incomplete'), {
            code: 'workspace_remote_upload_incomplete',
        });
    }
    // Registration is what makes the uploaded objects usable remotely, so
    // it is gated on the policy exactly like the transfers themselves.
    await ctx.policy.assertCompliant(record, signal);
    const startedMs = ctx.nowMs();
    await ctx.remote.registerRevision(record, signal);
    ctx.cancellations.assertActive(record.sessionId, signal);
    ctx.metrics.attempt({
        stage: 'register',
        outcome: 'success',
        kind: record.kind,
        durationMs: ctx.nowMs() - startedMs,
    });
    ctx.metrics.result({ stage: 'register', outcome: 'success', kind: record.kind });
    const registered = { ...record, remoteState: 'indexing' };
    await ctx.store.patchRevision(registered.revisionId, {
        remoteState: 'indexing',
        nextRetryAtMs: ctx.nowMs(),
        lastErrorCode: null,
        updatedAtMs: ctx.nowMs(),
    });
    return registered;
}
/**
 * Waits out the remote build, then downloads, verifies, and installs the
 * index the Revision becomes searchable through.
 */
async function materializeIndex(record, signal, ctx, progress) {
    progress.stage = 'remote_wait';
    if (!(await ctx.isEnabled()))
        return;
    ctx.cancellations.assertActive(record.sessionId, signal);
    const status = await ctx.remote.getRevisionStatus({
        workspaceId: record.workspaceId,
        sessionId: record.sessionId,
        revisionId: record.revisionId,
        rootHash: record.rootHash,
        signal,
    });
    ctx.cancellations.assertActive(record.sessionId, signal);
    if (status.status === 'failed') {
        // The attempt sample is emitted once by the failure handler, tagged with
        // the stage recorded above, so this throw must not count it again.
        throw Object.assign(new Error(status.errorCode), {
            code: status.errorCode,
            retryable: status.retryable,
        });
    }
    if (status.status !== 'ready') {
        ctx.metrics.attempt({ stage: 'remote_wait', outcome: 'pending', kind: record.kind });
        await ctx.store.patchRevision(record.revisionId, {
            remoteState: 'indexing',
            nextRetryAtMs: ctx.nowMs() + ctx.schedule.pollMs,
            updatedAtMs: ctx.nowMs(),
        });
        return;
    }
    // Reaching `ready` is a transition out of `indexing`, and only that
    // transition ends the remote wait. A download or install fault re-enters
    // this poll from `pending_download`, where the wait is already over: the
    // physical poll still counts, but re-reporting the completion — or the
    // duration since capture — would multiply one logical wait by its retries.
    const completesRemoteWait = record.remoteState === 'indexing';
    ctx.metrics.attempt({
        stage: 'remote_wait',
        outcome: 'success',
        kind: record.kind,
        // Measured from capture, so the histogram answers "how long until this
        // Workspace became searchable" rather than "how long one poll took".
        ...(completesRemoteWait ? { durationMs: Math.max(0, ctx.nowMs() - record.createdAtMs) } : {}),
    });
    if (completesRemoteWait) {
        ctx.metrics.result({ stage: 'remote_wait', outcome: 'success', kind: record.kind });
    }
    if (!(await ctx.isEnabled()))
        return;
    ctx.cancellations.assertActive(record.sessionId, signal);
    await ctx.store.patchRevision(record.revisionId, {
        remoteState: 'pending_download',
        embeddingModel: status.embeddingModel,
        dimensions: status.dimensions,
        normalization: status.normalization,
        indexSha256: status.sha256,
        indexSizeBytes: status.sizeBytes,
        updatedAtMs: ctx.nowMs(),
    });
    if (!(await ctx.isEnabled()))
        return;
    ctx.cancellations.assertActive(record.sessionId, signal);
    const targetPath = await ctx.semanticIndexStore.createDownloadTarget({
        workspaceId: record.workspaceId,
        revisionId: record.revisionId,
    });
    let installed;
    try {
        ctx.cancellations.assertActive(record.sessionId, signal);
        progress.stage = 'download';
        const downloadStartedMs = ctx.nowMs();
        const downloaded = await ctx.remote.downloadIndex({
            url: status.downloadUrl,
            expectedSizeBytes: status.sizeBytes,
            targetPath,
            signal,
        });
        ctx.cancellations.assertActive(record.sessionId, signal);
        ctx.metrics.attempt({
            stage: 'download',
            outcome: 'success',
            kind: record.kind,
            durationMs: ctx.nowMs() - downloadStartedMs,
        });
        ctx.metrics.payloadBytes('index', downloaded.sizeBytes, record.kind);
        if (downloaded.sha256 !== status.sha256) {
            throw Object.assign(new Error('workspace_semantic_index_archive_hash_mismatch'), {
                code: 'workspace_semantic_index_archive_hash_mismatch',
            });
        }
        ctx.cancellations.assertActive(record.sessionId, signal);
        progress.stage = 'install';
        const installStartedMs = ctx.nowMs();
        installed = await ctx.installSemaphore.run(() => ctx.semanticIndexStore.install({
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            revisionId: record.revisionId,
            revisionSequence: record.sequence,
            capturedAtMs: record.createdAtMs,
            rootHash: record.rootHash,
            archivePath: downloaded.path,
            archiveSha256: status.sha256,
            archiveSizeBytes: status.sizeBytes,
            embeddingModel: status.embeddingModel,
            dimensions: status.dimensions,
            normalization: status.normalization,
        }), signal);
        ctx.cancellations.assertActive(record.sessionId, signal);
        ctx.metrics.attempt({
            stage: 'install',
            outcome: 'success',
            kind: record.kind,
            durationMs: ctx.nowMs() - installStartedMs,
        });
        ctx.metrics.result({ stage: 'install', outcome: 'success', kind: record.kind });
    }
    finally {
        await rm(targetPath, { force: true });
    }
    ctx.cancellations.assertActive(record.sessionId, signal);
    await ctx.store.patchRevision(record.revisionId, {
        remoteState: 'ready',
        retryCount: 0,
        nextRetryAtMs: Number.MAX_SAFE_INTEGER,
        lastErrorCode: null,
        indexArchivePath: installed.indexPath,
        updatedAtMs: ctx.nowMs(),
    });
    ctx.metrics.result({ stage: 'ready', outcome: 'success', kind: record.kind });
    observeRevision(ctx, progress.sink, {
        stage: 'ready',
        outcome: 'success',
        kind: record.kind,
        durationMs: Math.max(0, ctx.nowMs() - record.createdAtMs),
    });
}
/**
 * Uploads one payload and samples its size first, so the transferred volume is
 * reported even when the upload itself fails.
 */
async function uploadTracked(record, payload, ctx, input) {
    const sizeBytes = await stat(input.localPath)
        .then((stats) => stats.size)
        .catch(() => undefined);
    if (sizeBytes !== undefined)
        ctx.metrics.payloadBytes(payload, sizeBytes, record.kind);
    input.signal?.throwIfAborted();
    return ctx.remote.uploadFile(input);
}
//# sourceMappingURL=revision-stages.js.map