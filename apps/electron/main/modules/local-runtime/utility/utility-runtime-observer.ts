import { randomUUID } from "node:crypto";
import { boundFailureDetail } from "../../observability/failure-detail";
/**
 * Windows native exit codes surface as negative NTSTATUS values in Node's
 * int32 view. Somewhere between JSON serialization and the analytics store
 * they get widened to uint64 and rounded through IEEE doubles, destroying
 * the low bits (0xC0000005 became indistinguishable from 0xC0000409 in
 * aggregations). Normalize to the unsigned 32-bit value (exact in doubles)
 * and mirror it as a hex string for direct dashboard grouping.
 */
function exitCodePayload(exitCode) {
    if (!Number.isInteger(exitCode))
        return {};
    const unsigned = exitCode >>> 0;
    return {
        exit_code: unsigned,
        exit_code_hex: `0x${unsigned.toString(16).toUpperCase()}`,
    };
}
export class UtilityRuntimeObserver {
    constructor(options) {
        this.options = options;
        this.activeIncident = null;
        this.databaseMigration = null;
        this.now = options.now ?? Date.now;
        this.createIncidentId = options.createIncidentId ?? randomUUID;
    }
    observe(event) {
        try {
            this.observeEvent(event);
        }
        catch {
            // Includes diagnostic IDs, clocks and payload construction, not only the sink.
            // The process manager owns recovery and must continue even if observation fails.
        }
    }
    observeEvent(event) {
        switch (event.type) {
            case 'database-migration':
                this.onDatabaseMigration(event);
                return;
            case 'execution-gap':
                this.safeEmit('utility_runtime.execution_gap', {
                    domain: 'utility_runtime',
                    continuity_epoch: event.epoch,
                    execution_gap_ms: event.executionGapMs,
                    gap_threshold_ms: event.gapThresholdMs,
                });
                return;
            case 'startup-failed':
                this.finishDatabaseMigration(event.attemptId, event.reasonCode === 'bootstrap_timeout' ? 'timeout' : 'failed', event.reasonCode);
                this.onStartupFailed(event);
                return;
            case 'runtime-exited':
                this.onRuntimeExited(event);
                return;
            case 'runtime-recovery-started':
                this.onRuntimeRecoveryStarted(event);
                return;
            case 'runtime-failed':
                this.onRuntimeFailed(event);
                return;
            case 'ready':
                // A missing completion observation must not turn a later crash into a DB failure.
                if (this.databaseMigration?.attemptId === event.attemptId)
                    this.databaseMigration.finished = true;
                this.onReady(event.attemptId);
                return;
            case 'slow-exit':
                this.safeEmit('utility_runtime.slow_exit', {
                    domain: 'utility_runtime',
                    wait_ms: event.waitMs,
                    after_exit: event.afterExit,
                });
                return;
            case 'runtime-recovery-cooldown':
                this.safeEmit('utility_runtime.recovery_cooldown', {
                    domain: 'utility_runtime',
                    reason_code: event.reasonCode,
                    attempt_count: event.attemptCount,
                    cooldown_ms: event.cooldownMs,
                });
                return;
            case 'terminal-failed':
                this.onTerminalFailed(event.attemptId);
                return;
            case 'stopped':
                if (this.databaseMigration)
                    this.finishDatabaseMigration(this.databaseMigration.attemptId, 'interrupted', 'stopped');
                // A deliberate stop (app quit, runtime teardown) abandons any pending
                // recovery; close the incident so it never counts as an open-ended
                // failure with no summary.
                this.finishIncident('interrupted');
                return;
        }
    }
    onDatabaseMigration(observation) {
        const { attemptId, event } = observation;
        const previous = this.databaseMigration;
        if (previous?.attemptId === attemptId && previous.finished)
            return;
        if (previous?.attemptId !== attemptId) {
            this.databaseMigration = {
                attemptId,
                startedAtEpochMs: event.startedAtEpochMs,
                pendingMigrationCount: event.pendingMigrationCount,
                finished: false,
            };
        }
        if (event.phase === 'started')
            return;
        const migration = this.databaseMigration;
        if (!migration ||
            migration.startedAtEpochMs !== event.startedAtEpochMs ||
            migration.pendingMigrationCount !== event.pendingMigrationCount)
            return;
        this.finishDatabaseMigration(attemptId, event.phase === 'completed' ? 'success' : 'failed', event.phase === 'failed' ? 'init_failed' : undefined, event.durationMs);
    }
    finishDatabaseMigration(attemptId, outcome, reasonCode, durationMs) {
        const migration = this.databaseMigration;
        if (!migration || migration.attemptId !== attemptId || migration.finished)
            return;
        migration.finished = true;
        try {
            // Child timings exclude IPC delay; Main measures unfinished work even if the child is killed.
            const elapsedMs = durationMs ??
                (this.options.now?.() ?? performance.timeOrigin + performance.now()) -
                    migration.startedAtEpochMs;
            if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
                return;
            this.safeEmit('app.db_migration_summary', {
                outcome,
                pending_migration_count: migration.pendingMigrationCount,
                [outcome === 'success' ? 'db_migration_duration_ms' : 'db_migration_elapsed_ms']: Math.round(elapsedMs * 1000) / 1000,
                ...(reasonCode ? { reason_code: reasonCode } : {}),
            });
        }
        catch {
            // Clocks and telemetry sinks cannot affect failure/recovery handling.
        }
    }
    onStartupFailed(event) {
        let incident = this.activeIncident;
        if (incident?.failedAttemptIds.has(event.attemptId)) {
            if (event.terminal)
                this.finishIncident('terminal_failed');
            return;
        }
        if (!incident) {
            incident = this.startIncident({
                failurePhase: 'startup',
                reasonCode: event.reasonCode,
                attemptId: event.attemptId,
                exitCode: event.exitCode,
                detail: event.detail,
            });
        }
        else {
            incident.failedAttemptIds.add(event.attemptId);
            incident.attemptCount += 1;
            incident.lastFailure = {
                attemptId: event.attemptId,
                failurePhase: 'startup',
                reasonCode: event.reasonCode,
                exitCode: event.exitCode,
                detail: event.detail,
            };
            // Keep the root diagnostic stable; later retries have their own fields.
        }
        if (event.terminal)
            this.finishIncident('terminal_failed');
    }
    onRuntimeExited(event) {
        if (this.activeIncident) {
            if (this.activeIncident.lastFailure.attemptId !== event.attemptId) {
                this.activeIncident.lastFailure = {
                    attemptId: event.attemptId,
                    failurePhase: 'runtime',
                    reasonCode: 'process_exit',
                    exitCode: event.exitCode,
                };
            }
            return;
        }
        this.startIncident({
            failurePhase: 'runtime',
            reasonCode: 'process_exit',
            attemptId: event.attemptId,
            exitCode: event.exitCode,
        });
    }
    onRuntimeRecoveryStarted(event) {
        if (this.activeIncident)
            return;
        this.startIncident({
            failurePhase: 'runtime',
            reasonCode: event.reasonCode,
            attemptId: event.attemptId,
        });
    }
    /**
     * The supervisor gave up on an already-ready runtime (crash-loop breaker).
     * The manager always reports the underlying exit first, so the normal path
     * finds an incident that already knows this attempt, re-attributes it to the
     * give-up reason and settles it as terminal. An absent incident still opens
     * one: a terminal outcome must never be emitted without its own root record.
     */
    onRuntimeFailed(event) {
        let incident = this.activeIncident;
        if (!incident) {
            incident = this.startIncident({
                failurePhase: 'runtime',
                reasonCode: event.reasonCode,
                attemptId: event.attemptId,
                exitCode: event.exitCode,
            });
            this.finishIncident('terminal_failed');
            return;
        }
        if (!incident.failedAttemptIds.has(event.attemptId)) {
            incident.failedAttemptIds.add(event.attemptId);
            incident.attemptCount += 1;
        }
        if (incident.lastFailure.attemptId !== event.attemptId) {
            incident.lastFailure = {
                attemptId: event.attemptId,
                failurePhase: 'runtime',
                reasonCode: 'process_exit',
                exitCode: event.exitCode,
            };
        }
        // The give-up verdict is the actionable reason; the preceding
        // runtime-exited event already captured the underlying exit code.
        incident.reasonCode = event.reasonCode;
        // The verdict always knows the tripping exit code; an incident opened
        // without one (e.g. a startup-phase root) must not drop it.
        if (incident.exitCode === undefined) {
            incident.exitCode = event.exitCode;
        }
        this.finishIncident('terminal_failed');
    }
    onReady(attemptId) {
        const incident = this.activeIncident;
        if (!incident || incident.failedAttemptIds.has(attemptId))
            return;
        incident.attemptCount += 1;
        this.finishIncident('recovered');
    }
    onTerminalFailed(attemptId) {
        const incident = this.activeIncident;
        if (!incident || !incident.failedAttemptIds.has(attemptId))
            return;
        this.finishIncident('terminal_failed');
    }
    startIncident(input) {
        const incident = {
            incidentId: this.createIncidentId(),
            failurePhase: input.failurePhase,
            reasonCode: input.reasonCode,
            startedAt: this.now(),
            quitInProgress: this.probeQuitInProgress(),
            attemptCount: 0,
            failedAttemptIds: new Set([input.attemptId]),
            lastFailure: { ...input },
            ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
        };
        this.activeIncident = incident;
        this.safeEmit('utility_runtime.recovery_started', this.commonPayload(incident));
        return incident;
    }
    finishIncident(outcome) {
        const incident = this.activeIncident;
        if (!incident)
            return;
        this.activeIncident = null;
        this.safeEmit('utility_runtime.recovery_summary', {
            ...this.commonPayload(incident),
            ...this.lastFailurePayload(incident.lastFailure),
            outcome,
            attempt_count: incident.attemptCount,
            duration_ms: Math.max(0, Math.round(this.now() - incident.startedAt)),
        });
    }
    commonPayload(incident) {
        return {
            domain: 'utility_runtime',
            incident_id: incident.incidentId,
            failure_phase: incident.failurePhase,
            reason_code: incident.reasonCode,
            ...(incident.quitInProgress ? { quit_in_progress: true } : {}),
            ...(incident.exitCode !== undefined ? exitCodePayload(incident.exitCode) : {}),
            ...(incident.detail !== undefined
                ? { failure_detail: boundFailureDetail(incident.detail) }
                : {}),
        };
    }
    lastFailurePayload(failure) {
        const exitCode = failure.exitCode !== undefined ? exitCodePayload(failure.exitCode) : {};
        return {
            last_failure_attempt_id: failure.attemptId,
            last_failure_phase: failure.failurePhase,
            last_failure_reason: failure.reasonCode,
            ...(exitCode.exit_code !== undefined
                ? {
                    last_failure_exit_code: exitCode.exit_code,
                    last_failure_exit_code_hex: exitCode.exit_code_hex,
                }
                : {}),
            ...(failure.detail !== undefined
                ? { last_failure_detail: boundFailureDetail(failure.detail) }
                : {}),
        };
    }
    probeQuitInProgress() {
        try {
            return this.options.isQuitInProgress?.() === true;
        }
        catch {
            // A broken probe must never hide the underlying incident report.
            return false;
        }
    }
    safeEmit(eventName, payload) {
        try {
            this.options.emit(eventName, payload);
        }
        catch {
            // Observability is best-effort and must never enter lifecycle control.
        }
    }
}

