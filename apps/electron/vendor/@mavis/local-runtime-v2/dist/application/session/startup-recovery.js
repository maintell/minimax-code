import { getRuntimeBuildEnv } from '@mavis/config';
import { describeError } from './turn-message-delivery.js';
/** Startup recovery steps in execution order; each name is unique and appears in the runtime log. */
export const STARTUP_RECOVERY_STEP_NAMES = [
    'subagent-queue-dispatch',
    'cloud-handoff-upload',
    'questionnaire-recovery',
    'goal-takeover',
    'plan-lifecycle-recovery',
    'cron-recovery',
];
/** How long close waits for the active step before releasing services anyway. */
const STARTUP_RECOVERY_CLOSE_GRACE_MS = 3_000;
export function createStartupRecoveryRunner(input) {
    const nowMs = input.nowMs ?? Date.now;
    let stopped = false;
    const controller = new AbortController();
    let stopPromise;
    let resolveStopped;
    const stoppedOutcome = new Promise((resolve) => {
        resolveStopped = resolve;
    });
    let run;
    let activeStep;
    const log = (level, fields, message) => {
        try {
            input.logger[level](fields, message);
        }
        catch {
            // Diagnostics cannot fail recovery.
        }
    };
    const runStep = async (step) => {
        if (input.fault?.step === step.name) {
            if (input.fault.mode === 'hang')
                await new Promise(() => undefined);
            throw new Error(`injected startup recovery fault: ${step.name}`);
        }
        await step.run(controller.signal);
    };
    /** Settles with the step, never rejects; close waits on it. */
    const settleQuietly = async (pending) => {
        try {
            await pending;
        }
        catch {
            // The runner records the failure; close only waits.
        }
    };
    const runSteps = async () => {
        const startedAtMs = nowMs();
        log('info', { event: 'startup_recovery_started', steps: input.steps.map((step) => step.name) }, 'Startup recovery started');
        for (const step of input.steps) {
            if (stopped)
                return 'stopped';
            const stepStartedAtMs = nowMs();
            log('info', { event: 'startup_recovery_step_started', step: step.name }, `Startup recovery step started: ${step.name}`);
            const pending = runStep(step);
            activeStep = settleQuietly(pending);
            try {
                await pending;
            }
            catch (error) {
                if (stopped)
                    return 'stopped';
                const durationMs = Math.max(0, nowMs() - stepStartedAtMs);
                const reason = describeError(error);
                log('warn', { event: 'startup_recovery_step_failed', step: step.name, durationMs, error: reason }, `Startup recovery step failed: ${step.name} (${durationMs}ms): ${reason}`);
                reportFailure(step, reason);
                continue;
            }
            finally {
                activeStep = undefined;
            }
            if (stopped)
                return 'stopped';
            const durationMs = Math.max(0, nowMs() - stepStartedAtMs);
            log('info', { event: 'startup_recovery_step_completed', step: step.name, durationMs }, `Startup recovery step completed: ${step.name} (${durationMs}ms)`);
        }
        const durationMs = Math.max(0, nowMs() - startedAtMs);
        log('info', { event: 'startup_recovery_completed', durationMs }, `Startup recovery completed (${durationMs}ms)`);
        return 'completed';
    };
    const reportFailure = (step, reason) => {
        try {
            input.reportFailure?.(step.name, `owner=${step.owner};stage=startup-recovery;error=${reason}`);
        }
        catch {
            // Diagnostics cannot fail recovery.
        }
    };
    const runUntilStopped = async () => {
        try {
            return await Promise.race([runSteps(), stoppedOutcome]);
        }
        catch {
            return 'stopped';
        }
    };
    return {
        start: () => {
            run ??= stopped ? stoppedOutcome : runUntilStopped();
            return run;
        },
        stop: () => {
            stopPromise ??= (async () => {
                stopped = true;
                controller.abort();
                resolveStopped('stopped');
                const active = activeStep;
                if (!active)
                    return;
                let timer;
                const grace = new Promise((resolve) => {
                    timer = setTimeout(resolve, input.closeGraceMs ?? STARTUP_RECOVERY_CLOSE_GRACE_MS);
                    timer.unref?.();
                });
                try {
                    await Promise.race([active, grace]);
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
            })();
            return stopPromise;
        },
    };
}
/**
 * Validates the configured test fault. Production builds and unknown step
 * names or modes yield no fault.
 */
function resolveStartupRecoveryFault(configured, buildEnv) {
    if (!configured || buildEnv === 'prod')
        return undefined;
    const step = STARTUP_RECOVERY_STEP_NAMES.find((name) => name === configured.step);
    const mode = configured.mode === 'hang' || configured.mode === 'fail' ? configured.mode : undefined;
    return step && mode ? { step, mode } : undefined;
}
/**
 * The composition-root option for a configured test fault. Logs once when it
 * takes effect so a stuck instance is not mistaken for a product hang.
 */
export function startupRecoveryFaultOption(configured, logger, buildEnv = getRuntimeBuildEnv()) {
    const fault = resolveStartupRecoveryFault(configured, buildEnv);
    if (!fault)
        return {};
    logger.warn({ event: 'startup_recovery_fault_enabled', step: fault.step, mode: fault.mode }, 'Startup recovery test fault enabled');
    return { startupRecoveryFault: fault };
}
//# sourceMappingURL=startup-recovery.js.map