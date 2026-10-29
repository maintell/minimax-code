import { isTerminalStatus } from '@mavis/goal';
/** Owns all process-local Goal active-time projection state. */
export class GoalTimeAccounting {
    nowMs;
    baselines = new Map();
    constructor(nowMs) {
        this.nowMs = nowMs;
    }
    project(persisted, timing) {
        const baseline = this.resolveOrCreate(timing, persisted);
        const projectedSeconds = baseline.baselineTimeUsedSeconds + this.elapsedSeconds(timing, persisted, baseline);
        return {
            ...persisted,
            timeUsedSeconds: Math.max(persisted.timeUsedSeconds, projectedSeconds),
        };
    }
    elapsedSeconds(timing, goal, baseline = this.resolveOrCreate(timing, goal)) {
        if (isTerminalStatus(goal.status)) {
            const stoppedBaseline = this.resume(timing, goal, baseline);
            return this.effectiveElapsedSeconds(timing, stoppedBaseline, this.clampToTimingWindow(timing, goal.updatedAt));
        }
        if (goal.status !== 'paused') {
            return this.effectiveElapsedSeconds(timing, this.resume(timing, goal, baseline));
        }
        if (baseline.pausedAtMs !== undefined) {
            return this.effectiveElapsedSeconds(timing, baseline, baseline.pausedAtMs);
        }
        const pausedAtMs = this.clampToTimingWindow(timing, goal.updatedAt);
        const pausedBaseline = { ...baseline, pausedAtMs };
        this.baselines.set(timing.turnId, pausedBaseline);
        return this.effectiveElapsedSeconds(timing, pausedBaseline, pausedAtMs);
    }
    resume(timing, goal, baseline = this.baselines.get(timing.turnId)) {
        if (baseline?.sessionId !== timing.sessionId ||
            baseline.goalId !== goal.goalId ||
            baseline.pausedAtMs === undefined) {
            return baseline ?? this.resolveOrCreate(timing, goal);
        }
        const resumedAtMs = this.clampToTimingWindow(timing, goal.updatedAt);
        const resumedBaseline = {
            sessionId: baseline.sessionId,
            turnId: baseline.turnId,
            goalId: baseline.goalId,
            baselineTimeUsedSeconds: baseline.baselineTimeUsedSeconds,
            countingStartedAtMs: baseline.countingStartedAtMs,
            totalPausedDurationMs: baseline.totalPausedDurationMs + Math.max(0, resumedAtMs - baseline.pausedAtMs),
        };
        this.baselines.set(timing.turnId, resumedBaseline);
        return resumedBaseline;
    }
    finish(timing) {
        const baseline = this.baselines.get(timing.turnId);
        if (baseline?.sessionId === timing.sessionId)
            this.baselines.delete(timing.turnId);
    }
    clearSession(sessionId) {
        for (const [turnId, baseline] of this.baselines) {
            if (baseline.sessionId === sessionId)
                this.baselines.delete(turnId);
        }
    }
    resolveOrCreate(timing, persisted) {
        const current = this.baselines.get(timing.turnId);
        if (current?.sessionId === timing.sessionId && current.goalId === persisted.goalId) {
            return current;
        }
        const baseline = {
            sessionId: timing.sessionId,
            turnId: timing.turnId,
            goalId: persisted.goalId,
            baselineTimeUsedSeconds: persisted.timeUsedSeconds,
            countingStartedAtMs: this.resolveCountingStartedAtMs(timing, persisted.createdAt),
            totalPausedDurationMs: 0,
        };
        this.baselines.set(timing.turnId, baseline);
        return baseline;
    }
    effectiveElapsedSeconds(timing, baseline, endAtMs = timing.endedAtMs ?? this.nowMs()) {
        const elapsedMs = Math.max(0, this.clampToTimingWindow(timing, endAtMs) -
            baseline.countingStartedAtMs -
            baseline.totalPausedDurationMs);
        return elapsedMs === 0 ? 0 : Math.ceil(elapsedMs / 1_000);
    }
    resolveCountingStartedAtMs(timing, goalCreatedAtMs) {
        if (!Number.isFinite(goalCreatedAtMs))
            return timing.startedAtMs;
        const timingEndAtMs = timing.endedAtMs ?? this.nowMs();
        return Math.max(timing.startedAtMs, Math.min(goalCreatedAtMs, timingEndAtMs));
    }
    clampToTimingWindow(timing, timestampMs) {
        return Math.max(timing.startedAtMs, Math.min(timestampMs, timing.endedAtMs ?? timestampMs));
    }
}
//# sourceMappingURL=time-accounting.js.map