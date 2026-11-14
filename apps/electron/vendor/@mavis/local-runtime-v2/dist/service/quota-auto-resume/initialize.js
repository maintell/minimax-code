import { QuotaAutoResumeTurnObserver } from './observer.js';
import { QuotaAutoResumePlanStore } from './plan-store.js';
import { QuotaAutoResumeServiceImpl } from './service.js';
export function initializeQuotaAutoResume(input) {
    let runtime;
    const ports = {
        nowMs: input.nowMs,
        enabled: input.enabled,
        desktopHost: input.desktopHost,
        quota: input.quota,
        usesBuiltinAccountModel: input.usesBuiltinAccountModel,
        ...(input.logger ? { logger: input.logger } : {}),
        ...(input.timers ? { timers: input.timers } : {}),
        ...(input.random ? { random: input.random } : {}),
        // Before the owners exist, every read answers "nothing to do", so no plan
        // can be recorded and no retry can be submitted.
        sessions: {
            get: async (sessionId) => runtime?.sessions.get(sessionId),
            latestTurnId: async (sessionId) => runtime?.sessions.latestTurnId(sessionId),
        },
        goals: {
            hasUnfinishedGoal: async (sessionId) => (await runtime?.goals.hasUnfinishedGoal(sessionId)) ?? true,
        },
        continuation: {
            inspect: async (sessionId) => (await runtime?.continuation.inspect(sessionId)) ?? 'unavailable',
            open: async (sessionId) => (await runtime?.continuation.open(sessionId)) ?? { accepted: false },
            cancelOpening: (sessionId) => {
                runtime?.continuation.cancelOpening?.(sessionId);
            },
        },
    };
    const service = new QuotaAutoResumeServiceImpl(ports, new QuotaAutoResumePlanStore(input.db));
    return {
        service,
        turnObserver: new QuotaAutoResumeTurnObserver(service),
        bindRuntime: (runtimePorts) => {
            runtime = runtimePorts;
        },
    };
}
//# sourceMappingURL=initialize.js.map