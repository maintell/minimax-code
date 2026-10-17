import { performance } from "node:perf_hooks";
const DEFAULT_CADENCE_INTERVAL_MS = 1000;
// Cadence plus a conservative 2s scheduling-drift allowance. A false gap only
// reopens an observation window; missing a real gap could authorize a false
// recycle, so the production default deliberately favors forgiveness.
const DEFAULT_GAP_THRESHOLD_MS = 3000;
function positiveFinite(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
/**
 * Creates one app-lifetime continuity observer. Clock and scheduler injection
 * stay at the construction seam so ordinary callers only learn the four-method
 * `ExecutionContinuity` Interface.
 */
export function createExecutionContinuity(options = {}) {
    const now = options.now ?? (() => performance.now());
    const cadenceIntervalMs = positiveFinite(options.cadenceIntervalMs, DEFAULT_CADENCE_INTERVAL_MS);
    const configuredGapThresholdMs = positiveFinite(options.gapThresholdMs, DEFAULT_GAP_THRESHOLD_MS);
    // A threshold below the cadence would declare every healthy tick a gap.
    const gapThresholdMs = Math.max(cadenceIntervalMs, configuredGapThresholdMs);
    const scheduleInterval = options.scheduleInterval ?? setInterval;
    const clearScheduledInterval = options.clearScheduledInterval ?? clearInterval;
    let epoch = 0;
    let lastObservedAt = now();
    let disposed = false;
    const listeners = new Set();
    const continuity = {
        observeNow() {
            if (disposed)
                return;
            const observedAt = now();
            const rawGapMs = observedAt - lastObservedAt;
            lastObservedAt = observedAt;
            const invalidClockSample = !Number.isFinite(rawGapMs) || rawGapMs < 0;
            if (!invalidClockSample && rawGapMs <= gapThresholdMs)
                return;
            epoch += 1;
            const observation = {
                epoch,
                executionGapMs: invalidClockSample ? 0 : rawGapMs,
                gapThresholdMs,
            };
            for (const listener of [...listeners]) {
                try {
                    listener(observation);
                }
                catch {
                    // Telemetry/recovery hint consumers must not affect the correctness
                    // primitive that invalidates fault-detection windows.
                }
            }
        },
        capture: () => epoch,
        isCurrent: (capturedEpoch) => capturedEpoch === epoch,
        onGap(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const cadenceTimer = scheduleInterval(() => continuity.observeNow(), cadenceIntervalMs);
    cadenceTimer.unref?.();
    return {
        continuity,
        dispose() {
            if (disposed)
                return;
            disposed = true;
            clearScheduledInterval(cadenceTimer);
            listeners.clear();
        },
    };
}
