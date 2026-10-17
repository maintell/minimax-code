import { SandboxError } from '../sandbox-errors.js';
export function sandboxErrorOutcome(error, reasonCode = 'EXECUTION_FAILED') {
    return {
        termination: 'not_started',
        reasonCode: error instanceof SandboxError ? error.code : reasonCode,
        ...(error instanceof SandboxError ? { errorCode: error.code, errorStage: error.stage } : {}),
    };
}
/** One attempt owns immutable correlation, bounded stage detail and exact denial counts. */
export class SandboxInvocationTrace {
    identity;
    now;
    callbacks;
    #startedAt;
    #stages = [];
    #denials = {};
    #policy = { execution_mode: 'not_started' };
    #finished = false;
    #spawned = false;
    #violationCount = 0;
    #detailCount = 0;
    #lateTimer;
    constructor(identity, now, callbacks) {
        this.identity = identity;
        this.now = now;
        this.callbacks = callbacks;
        this.#startedAt = now();
    }
    stage(stage, details) {
        if (this.#finished || this.#stages.length >= 16)
            return;
        if (stage === 'process.started')
            this.#spawned = true;
        const fact = { stage, offset_ms: this.duration(), ...(details ? { details } : {}) };
        this.#stages.push(fact);
        this.callbacks.emit(`sandbox.${stage}`, fact, false, true);
    }
    policy(policy) {
        this.#policy = policy;
        this.stage('policy.resolved', policy);
    }
    violation(violation) {
        this.#violationCount += 1;
        const key = `${violation.source}:${violation.operation}`;
        this.#denials[key] = (this.#denials[key] ?? 0) + 1;
        if (this.#detailCount < 3) {
            this.#detailCount += 1;
            this.callbacks.emit('sandbox.violation', {
                violation_sequence: violation.sequence,
                occurred_at_ms: violation.timestampMs,
                operation: violation.operation,
                source: violation.source,
                target: violation.target,
                filesystem_generation: violation.effectiveGeneration,
                attribution: 'exact',
                late: this.#finished,
                reason_code: 'SANDBOX_DENIAL_OBSERVED',
                rule_id: null,
                rule_attribution: 'unknown',
                network_decision_generation: null,
            }, true);
        }
        // A finished summary is immutable. Late monitor facts produce a bounded delta summary.
        if (this.#finished && !this.#lateTimer) {
            this.#lateTimer = setTimeout(() => {
                this.#lateTimer = undefined;
                this.callbacks.emit('sandbox.violation_summary', this.violationSummary());
            }, 1_000);
            this.#lateTimer.unref?.();
        }
    }
    finish(outcome) {
        if (this.#finished)
            return;
        this.#stages.push({
            stage: 'invocation.finished',
            offset_ms: this.duration(),
            details: { termination_kind: outcome.termination, reason_code: outcome.reasonCode },
        });
        this.#finished = true;
        const durationMs = this.duration();
        this.callbacks.emit('sandbox.invocation.finished', {
            ...this.#policy,
            termination_kind: outcome.termination,
            exit_code: outcome.exitCode ?? null,
            reason_code: outcome.reasonCode,
            error_code: outcome.errorCode ?? null,
            error_stage: outcome.errorStage ?? null,
            cleanup_result: outcome.cleanup ?? 'success',
            duration_ms: durationMs,
            stages: this.#stages,
            ...this.violationSummary(),
            sandbox_observation: this.sandboxObservation(outcome),
            ...unstartedExecution(outcome, this.#spawned),
        }, outcome.termination !== 'exited_zero' || outcome.cleanup === 'failure');
        this.callbacks.completed(outcome, durationMs);
    }
    flushLate() {
        if (!this.#lateTimer)
            return;
        clearTimeout(this.#lateTimer);
        this.#lateTimer = undefined;
        this.callbacks.emit('sandbox.violation_summary', this.violationSummary());
    }
    sandboxObservation(outcome) {
        if (this.#policy.execution_mode === 'native')
            return 'not_applied';
        if (this.#violationCount > 0)
            return 'denial_observed';
        if (outcome.termination === 'not_started' || outcome.termination === 'spawn_failed')
            return 'unknown';
        return 'no_denial_observed';
    }
    duration() {
        return Math.max(0, Math.round(this.now() - this.#startedAt));
    }
    violationSummary() {
        return {
            violation_count: this.#violationCount,
            violations_by_reason: { ...this.#denials },
            dropped_detail_count: this.#violationCount - this.#detailCount,
        };
    }
}
function unstartedExecution(outcome, spawned) {
    if (outcome.termination === 'aborted' && !spawned)
        return { execution_mode: 'not_started' };
    if (outcome.termination === 'not_started' || outcome.termination === 'spawn_failed') {
        return { execution_mode: 'not_started' };
    }
    return {};
}
//# sourceMappingURL=invocation-trace.js.map