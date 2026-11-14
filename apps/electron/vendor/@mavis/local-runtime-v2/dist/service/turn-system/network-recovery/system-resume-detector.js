import { SYSTEM_SLEEP_GAP_MS } from '@mavis/agent-core/pi-turn-runner';
const DEFAULT_TICK_MS = 5_000;
const DEFAULT_DRIFT_MS = SYSTEM_SLEEP_GAP_MS;
/**
 * Timers stop while the system sleeps and the wall clock does not, so a tick
 * that lands much later than scheduled marks a wake. Works the same in the
 * Electron, CLI and TUI hosts without any platform power API.
 */
export function createSystemResumeDetector(options = {}) {
    const now = options.now ?? Date.now;
    const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    const driftMs = options.driftMs ?? DEFAULT_DRIFT_MS;
    const listeners = new Set();
    let timer;
    let lastTickAt = 0;
    const tick = () => {
        const at = now();
        const gap = at - lastTickAt;
        lastTickAt = at;
        if (gap <= tickMs + driftMs)
            return;
        for (const listener of [...listeners]) {
            try {
                listener();
            }
            catch {
                // One listener must not keep the others from hearing the wake.
            }
        }
    };
    return {
        onResume(listener) {
            listeners.add(listener);
            if (!timer) {
                lastTickAt = now();
                timer = setInterval(tick, tickMs);
                timer.unref?.();
            }
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0 && timer) {
                    clearInterval(timer);
                    timer = undefined;
                }
            };
        },
    };
}
//# sourceMappingURL=system-resume-detector.js.map