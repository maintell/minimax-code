import { traceSegmentIdle } from './trace.js';
/** Traces `idle` once the session stays without a Turn for `thresholdMs`. */
export function scheduleIdleTrace(trace, sessionId, state, input) {
    if (state.idleTimer)
        clearTimeout(state.idleTimer);
    state.idleTraced = false;
    const { growth, thresholdMs } = input;
    const timer = setTimeout(() => {
        state.idleTimer = undefined;
        state.idleTraced = true;
        traceSegmentIdle(trace, sessionId, {
            phase: 'idle',
            idleMs: thresholdMs,
            ...(growth
                ? { segmentGrowthTokens: growth.tokens, segmentGrowthMessages: growth.messages }
                : {}),
            continued: false,
        });
    }, thresholdMs);
    timer.unref?.();
    state.idleTimer = timer;
}
/** Stops the timer; traces `resumed` when the session had been traced idle. */
export function endIdleTrace(trace, sessionId, state, nowMs) {
    if (state.idleTimer)
        clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    if (!state.idleTraced || state.lastTurnEndedAtMs === undefined)
        return;
    state.idleTraced = false;
    traceSegmentIdle(trace, sessionId, {
        phase: 'resumed',
        idleMs: Math.max(0, nowMs - state.lastTurnEndedAtMs),
        continued: true,
    });
}
//# sourceMappingURL=idle-trace.js.map