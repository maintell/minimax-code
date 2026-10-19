import { emitWorkspaceIndexingObservation, } from './metrics.js';
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_POLL_MS = 10_000;
/**
 * Re-check cadence for a Revision held back by the collection policy. Long
 * enough that a permanently non-compliant capture costs almost nothing, short
 * enough that widening the policy resumes indexing without an app restart.
 */
const DEFAULT_POLICY_HOLD_MS = 5 * 60_000;
export function normalizeWorkspaceRevisionSchedule(options) {
    const retryBaseMs = Math.max(1, options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS);
    return {
        retryBaseMs,
        retryMaxMs: Math.max(retryBaseMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS),
        maxRetries: Math.max(1, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES)),
        pollMs: Math.max(1, options.pollMs ?? DEFAULT_POLL_MS),
        policyHoldMs: Math.max(1, options.policyHoldMs ?? DEFAULT_POLICY_HOLD_MS),
    };
}
/**
 * State a dispatch actually resumes from. A parked Revision re-enters at the
 * first stage its persisted checkpoints leave unfinished, so the stored OSS
 * keys and embedding model — not the `retry_wait` marker — decide where the
 * work picks up.
 */
export function resumeRemoteState(record) {
    if (record.remoteState !== 'retry_wait')
        return record.remoteState;
    if (!record.archiveOssKey || !record.manifestOssKey)
        return 'pending_upload';
    return record.embeddingModel ? 'pending_download' : 'pending_registration';
}
/** Stage a dispatch enters in, before any remote call has been made. */
export function entryStage(record) {
    switch (resumeRemoteState(record)) {
        case 'pending_registration':
            return 'register';
        case 'indexing':
        case 'pending_download':
            return 'remote_wait';
        default:
            return 'upload';
    }
}
/** Stamps an observation with the context clock and delivers it to `sink`. */
export function observeRevision(ctx, sink, event) {
    emitWorkspaceIndexingObservation(sink, {
        ...event,
        timestampMs: ctx.nowMs(),
    });
}
//# sourceMappingURL=revision-context.js.map