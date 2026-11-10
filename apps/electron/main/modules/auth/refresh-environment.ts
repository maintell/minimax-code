const POWER_FIELDS = {
    suspend: 'last_suspend_at_ms',
    resume: 'last_resume_at_ms',
    'lock-screen': 'last_lock_at_ms',
    'unlock-screen': 'last_unlock_at_ms',
};
const MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000;
let snapshot = {};
export function recordAuthRefreshPowerEvent(event, now = Date.now()) {
    try {
        const field = POWER_FIELDS[event];
        if (!field || !isTimestamp(now))
            return;
        snapshot = { ...snapshot, [field]: now };
    }
    catch {
        // Diagnostics breadcrumbs must never affect power handling.
    }
}
export function recordAuthRefreshExecutionGap(gapMs, now = Date.now()) {
    try {
        if (typeof gapMs !== 'number' || !Number.isFinite(gapMs) || gapMs < 0)
            return;
        if (!isTimestamp(now))
            return;
        snapshot = {
            ...snapshot,
            recent_execution_gap_ms: Math.min(Math.round(gapMs), MAX_GAP_MS),
            recent_execution_gap_at_ms: now,
        };
    }
    catch {
        // Diagnostics breadcrumbs must never affect runtime continuity.
    }
}
export function readAuthRefreshEnvironmentSnapshot() {
    return { ...snapshot };
}
export function resetAuthRefreshEnvironmentForTests() {
    snapshot = {};
}
function isTimestamp(value) {
    return Number.isSafeInteger(value) && value > 0;
}
