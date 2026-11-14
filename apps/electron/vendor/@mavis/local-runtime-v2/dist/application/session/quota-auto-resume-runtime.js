import { SESSION_KINDS } from '../../service/session-system/index.js';
import { TurnContinuationDeliveryService } from '../conversation/turn-continuation-delivery.js';
/**
 * The model a Turn of this Session would run, following the same priority Turn
 * preparation resolves: an explicit Session selection wins, and an ordinary
 * conversation that never touched the ModelSelector runs the delivered default
 * (`config.defaultModel`). Without that fallback a brand-new Session reads as
 * modelless, which the owner cannot tell apart from a BYOK key.
 *
 * Channel, task, cron and peek Sessions take their model from the bound Agent
 * or the task definition instead of the Session record, so they keep today's
 * "no model" answer rather than being attributed the conversation default.
 */
function sessionModelFacts(record, defaultModel) {
    // A record written before `sessionKind` existed is an ordinary conversation.
    if ((record.sessionKind ?? 'conversation') !== 'conversation')
        return {};
    const selected = record.effectiveModel?.trim();
    if (selected)
        return { modelName: selected, modelSource: 'session' };
    const fallback = defaultModel()?.trim();
    return fallback ? { modelName: fallback, modelSource: 'config-default' } : {};
}
/**
 * The auto-resume owner needs Session, Goal and Turn reads that only exist after
 * owner initialization, so its ports are bound here rather than at construction.
 * `open` is the same delivery the Retry action uses, so the client sees an
 * ordinary continuation stream and no user message is appended.
 */
export function bindQuotaAutoResumeRuntime(capability, host) {
    if (!capability)
        return;
    const openingControllers = new Map();
    capability.bindRuntime({
        sessions: {
            get: async (sessionId) => {
                const record = await host.sessionSystem.sessions.repository.get(sessionId);
                if (!record)
                    return undefined;
                return {
                    parentSessionId: record.parentSessionId ?? null,
                    archived: record.archived,
                    ...sessionModelFacts(record, host.defaultModel),
                };
            },
            latestTurnId: async (sessionId) => (await host.turnSystem.inspection?.latestTurnActivity?.(sessionId))?.turnId,
        },
        goals: {
            // Any Goal that is not finished owns its own quota recovery. Only
            // `complete` is final; every other status can still be resumed, so it
            // counts as unfinished (fail-closed towards today's behaviour).
            hasUnfinishedGoal: async (sessionId) => {
                const goal = await host.goalPort.getBySession(sessionId);
                return goal !== undefined && goal.status !== 'complete';
            },
        },
        continuation: {
            inspect: async (sessionId) => (await host.turnSystem.turns.inspectContinuation(sessionId)).state,
            open: async (sessionId) => {
                openingControllers.get(sessionId)?.abort();
                const controller = new AbortController();
                openingControllers.set(sessionId, controller);
                const delivery = new TurnContinuationDeliveryService({
                    turns: host.turnSystem.turns,
                    stream: host.sessionSystem.stream,
                    queryCollapse: {
                        resolve: (id, turnId) => host.queryKeyForContinuation(id, turnId),
                        start: (request) => host.sessionSystem.queryCollapse.state.start(request),
                    },
                });
                try {
                    const result = await delivery.open(sessionId, { signal: controller.signal });
                    return result.accepted ? { accepted: true, turnId: result.turnId } : { accepted: false };
                }
                finally {
                    if (openingControllers.get(sessionId) === controller) {
                        openingControllers.delete(sessionId);
                    }
                }
            },
            cancelOpening: (sessionId) => {
                const controller = openingControllers.get(sessionId);
                if (!controller)
                    return;
                openingControllers.delete(sessionId);
                controller.abort();
            },
        },
    });
}
/**
 * Runs the plan reconciliation right after Goal take-over, so a plan that came
 * due while the app was closed retries only once the Runtime can run a Turn.
 */
export function withQuotaAutoResumeStartupRecovery(quotaAutoResume, inputs) {
    if (!quotaAutoResume)
        return inputs;
    const takeOverGoals = inputs.takeOverGoals;
    return {
        ...inputs,
        takeOverGoals: async (signal) => {
            await takeOverGoals(signal);
            if (signal?.aborted)
                return;
            await quotaAutoResume.service.reconcile('startup');
        },
    };
}
/**
 * A message the user submitted means the user is attending the Session again, so
 * any pending plan goes — including when the message only joined a paused Queue
 * and started no Turn of its own.
 */
export function userMessageAcceptedWithQuotaAutoResume(quotaAutoResume) {
    return async (sessionId) => {
        await quotaAutoResume?.service.forgetSession(sessionId, 'user-took-over');
    };
}
/** A deleted Session's plan goes with it; Memory governance still runs first. */
export function sessionDeletionWithQuotaAutoResume(memoryDeletion, quotaAutoResume) {
    return {
        deleteSession: async (input) => {
            await quotaAutoResume?.service.forgetSession(input.sessionId, 'session-removed');
            if (memoryDeletion) {
                await memoryDeletion.deleteSession(input);
                return;
            }
            await input.deleteOwnedSession();
        },
    };
}
//# sourceMappingURL=quota-auto-resume-runtime.js.map