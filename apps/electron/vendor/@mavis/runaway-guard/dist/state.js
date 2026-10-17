import { randomBytes } from 'node:crypto';
export function clearDetectionStreaks(state) {
    state.detectActionStreaks.clear();
    state.pollingActionStreaks.clear();
    state.detectResultStreaks.clear();
    state.errorFamilyStreaks.clear();
    state.progressStreaks.clear();
    state.recentActionBatches = [];
    state.activeAbabKey = undefined;
}
export function recordMaxOccurrences(state, signalKind, occurrences) {
    const stats = state.signalStats[signalKind];
    stats.maxOccurrences = Math.max(stats.maxOccurrences, occurrences);
}
export function snapshotTurnSummary(ctx, state) {
    return {
        schemaVersion: 1,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        agentName: ctx.agentName,
        stepCount: state.stepIndex,
        projectionSkippedCount: state.fingerprintSkippedCount,
        reminderInjected: state.reminderInjected,
        signals: snapshotSignalStats(state.signalStats),
    };
}
function snapshotSignalStats(stats) {
    return {
        exact_action_repeat: { ...stats.exact_action_repeat },
        exact_result_repeat: { ...stats.exact_result_repeat },
        same_error_family: { ...stats.same_error_family },
        abab_action_cycle: { ...stats.abab_action_cycle },
        polling_repeat: { ...stats.polling_repeat },
        unchanged_progress_repeat: { ...stats.unchanged_progress_repeat },
    };
}
export function stateFor(states, ctx) {
    const key = runKey(ctx);
    const existing = states.get(key);
    if (existing)
        return existing;
    const state = newShadowState();
    states.set(key, state);
    return state;
}
export function newShadowState() {
    return {
        secret: randomBytes(32),
        stepIndex: 0,
        fingerprintSkippedCount: 0,
        reminderAttempted: false,
        reminderInjected: false,
        signalStats: createSignalStats(),
        detectActionStreaks: new Map(),
        pollingActionStreaks: new Map(),
        detectResultStreaks: new Map(),
        errorFamilyStreaks: new Map(),
        progressStreaks: new Map(),
        recentActionBatches: [],
    };
}
function createSignalStats() {
    return {
        exact_action_repeat: emptySignalStats(),
        exact_result_repeat: emptySignalStats(),
        same_error_family: emptySignalStats(),
        abab_action_cycle: emptySignalStats(),
        polling_repeat: emptySignalStats(),
        unchanged_progress_repeat: emptySignalStats(),
    };
}
function emptySignalStats() {
    return { episodeCount: 0, maxOccurrences: 0 };
}
export function runKey(ctx) {
    return `${ctx.sessionId}\u0000${ctx.turnId}`;
}
//# sourceMappingURL=state.js.map