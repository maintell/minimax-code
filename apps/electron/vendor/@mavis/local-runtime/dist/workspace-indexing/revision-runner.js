import { resolveWorkspaceIndexingObservationSink } from './metrics.js';
import { isRecoverableServerExecutionError, normalizeWorkspaceRemoteErrorCode, } from './remote-error.js';
import { entryStage, observeRevision, } from './revision-context.js';
import { WorkspacePolicyHoldError } from './revision-policy-gate.js';
import { advanceRevision } from './revision-stages.js';
/**
 * Runs one Revision to its next resting state and records how it got there.
 *
 * The stage machine itself lives in `revision-stages`; what this owns is the
 * outcome of an attempt — cancelled, held by the collection policy, failed on
 * the retry ladder, or advanced — which is the part that must stay consistent
 * no matter which stage raised.
 */
export class WorkspaceRevisionRunner {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    async run(record, signal) {
        const attempt = {
            // Seeded from the persisted checkpoints: a hold or failure on a resumed
            // Revision belongs to the stage it re-enters, never to an upload that
            // completed dispatches ago.
            stage: entryStage(record),
            sink: resolveWorkspaceIndexingObservationSink(this.ctx.createObservationSink),
        };
        if (!(await this.ctx.isEnabled().catch(() => false)))
            return;
        try {
            this.ctx.cancellations.assertActive(record.sessionId, signal);
            await advanceRevision(record, signal, this.ctx, attempt);
        }
        catch (error) {
            if (this.ctx.cancellations.isCancelled(record.sessionId, signal, error)) {
                this.ctx.metrics.attempt({
                    stage: attempt.stage,
                    outcome: 'cancelled',
                    kind: record.kind,
                });
                return;
            }
            try {
                if (error instanceof WorkspacePolicyHoldError) {
                    await this.holdForPolicy(record, attempt);
                    return;
                }
                await this.recordFailure(record, error, attempt);
            }
            catch (persistenceError) {
                this.reportError(record, persistenceError);
            }
        }
    }
    /**
     * Publishes a fault on the host error channel. Observability is a weak
     * dependency: a listener that throws must not take a dispatch down with it.
     */
    reportError(record, error) {
        const event = {
            revisionId: record.revisionId,
            sessionId: record.sessionId,
            code: normalizeWorkspaceRemoteErrorCode(error),
        };
        try {
            this.ctx.onError?.(event);
        }
        catch {
            // Observability must remain a weak dependency too.
        }
    }
    /**
     * Parks a non-compliant Revision on a fixed low-frequency re-check. The
     * retry counter is deliberately untouched: a policy hold is a recoverable
     * configuration state, so it must never age a capture into
     * `failed_terminal`, and it must never spin at transport retry speed.
     */
    async holdForPolicy(record, attempt) {
        this.ctx.metrics.attempt({
            stage: attempt.stage,
            outcome: 'policy_blocked',
            kind: record.kind,
        });
        // Every re-check is a physical attempt, but the hold itself is one logical
        // state: a Revision parked for a day must read as one blocked Revision,
        // not as a re-check counter. The persisted marker survives restarts, so
        // the episode does not restart with the process either.
        if (record.lastErrorCode !== 'workspace_policy_blocked') {
            this.ctx.metrics.result({
                stage: attempt.stage,
                outcome: 'policy_blocked',
                reason: 'policy',
                kind: record.kind,
            });
            observeRevision(this.ctx, attempt.sink, {
                stage: 'ready',
                outcome: 'policy_blocked',
                kind: record.kind,
            });
        }
        await this.ctx.store.patchRevision(record.revisionId, {
            remoteState: 'retry_wait',
            nextRetryAtMs: this.ctx.nowMs() + this.ctx.schedule.policyHoldMs,
            lastErrorCode: 'workspace_policy_blocked',
            updatedAtMs: this.ctx.nowMs(),
        });
    }
    /** Advances the retry ladder, or ends it when this fault is the last one. */
    async recordFailure(record, error, attempt) {
        const stage = attempt.stage;
        let persistedRecord = record;
        try {
            persistedRecord = (await this.ctx.store.getRevision(record.revisionId)) ?? record;
        }
        catch {
            // Preserve weak-dependency containment when the state store itself is
            // unavailable; the subsequent patch remains the authoritative attempt.
        }
        const code = normalizeWorkspaceRemoteErrorCode(error);
        const nextRetryCount = persistedRecord.retryCount + 1;
        const explicitlyTerminal = !!error && typeof error === 'object' && 'retryable' in error && error.retryable === false;
        const terminal = nextRetryCount >= this.ctx.schedule.maxRetries ||
            (explicitlyTerminal && !isRecoverableServerExecutionError(code));
        await this.ctx.store.patchRevision(record.revisionId, {
            remoteState: terminal ? 'failed_terminal' : 'retry_wait',
            retryCount: nextRetryCount,
            nextRetryAtMs: terminal
                ? Number.MAX_SAFE_INTEGER
                : this.ctx.nowMs() + this.retryDelay(nextRetryCount),
            lastErrorCode: code,
            updatedAtMs: this.ctx.nowMs(),
        });
        // One attempt sample per try, tagged with the stage that actually failed;
        // the logical result is emitted only when the Revision stops for good, so
        // retry noise never inflates terminal failure counts.
        this.ctx.metrics.attempt({ stage, outcome: 'failed', kind: record.kind });
        if (terminal) {
            this.ctx.metrics.result({ stage, outcome: 'failed', reason: 'error', kind: record.kind });
            observeRevision(this.ctx, attempt.sink, {
                stage: 'ready',
                outcome: 'failed',
                kind: record.kind,
            });
        }
        else {
            this.ctx.metrics.retry(stage, 'error');
        }
        this.reportError(persistedRecord, error);
    }
    retryDelay(retryCount) {
        const { retryBaseMs, retryMaxMs } = this.ctx.schedule;
        return Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, retryCount - 1));
    }
}
//# sourceMappingURL=revision-runner.js.map