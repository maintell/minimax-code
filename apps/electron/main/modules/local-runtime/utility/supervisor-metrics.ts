import { incrementDesktopMetric } from "../../observability/desktop-metrics";
/** `process.platform` as the `os` label; other platforms report no os-labelled count. */
export function supervisorOs(platform) {
    return platform === 'darwin' || platform === 'win32' || platform === 'linux'
        ? platform
        : undefined;
}
/**
 * Supervisor metrics from the utility runtime's lifecycle events:
 * - `supervisor_runtime_start_total{result,os}`: one per launch attempt, `ready`
 *   or `startup_failed`.
 * - `supervisor_runtime_exit_total{reason,os}`: one per attempt that ended
 *   without the app asking: a startup failure (its reason), a ready runtime that
 *   exited (`process_exit`) or one the supervisor recycled (memory_pressure,
 *   runtime_unresponsive, oom).
 * - `supervisor_runtime_restart_total{reason}`: each `runtime-recovery-started`.
 *
 * The main process does not know how many sessions a runtime loss interrupts,
 * so it reports no session count: `supervisor_runtime_exit_total` already
 * counts each loss (a crash or a recycle) by reason.
 *
 * A terminal startup failure is reported again for its attempt; each attempt
 * counts once. Nothing is counted while the app quits.
 */
export class SupervisorMetricsObserver {
    constructor(options = {}) {
        this.options = options;
        this.os = supervisorOs(options.platform ?? process.platform);
        this.increment = options.increment ?? incrementDesktopMetric;
    }
    observe(event) {
        try {
            if (!this.quitting())
                this.observeEvent(event);
        }
        catch {
            // Metrics never enter lifecycle control.
        }
    }
    observeEvent(event) {
        switch (event.type) {
            case 'ready':
                this.countStart(event.attemptId, 'ready');
                return;
            case 'startup-failed':
                this.countStart(event.attemptId, 'startup_failed');
                this.countExit(event.attemptId, event.reasonCode);
                return;
            case 'runtime-exited':
                this.countExit(event.attemptId, 'process_exit');
                return;
            case 'runtime-recovery-started':
                this.countExit(event.attemptId, event.reasonCode);
                this.increment('supervisor_runtime_restart_total', 1, { reason: event.reasonCode });
                return;
            default:
                return;
        }
    }
    countStart(attemptId, result) {
        if (!this.os || attemptId === this.lastStartAttemptId)
            return;
        this.lastStartAttemptId = attemptId;
        this.increment('supervisor_runtime_start_total', 1, { result, os: this.os });
    }
    countExit(attemptId, reason) {
        if (!this.os || attemptId === this.lastExitAttemptId)
            return;
        this.lastExitAttemptId = attemptId;
        this.increment('supervisor_runtime_exit_total', 1, { reason, os: this.os });
    }
    quitting() {
        try {
            return this.options.isQuitInProgress?.() === true;
        }
        catch {
            return false;
        }
    }
}

