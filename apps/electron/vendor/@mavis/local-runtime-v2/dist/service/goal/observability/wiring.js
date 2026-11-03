/**
 * Thread Goal wiring helpers for {@link LocalApiHost}.
 *
 * Pulled out of `api/host.ts` to keep the host under the 2000-line
 * cap. The helpers here are deliberately tiny and stateless — they take
 * the bare minimum of dependencies (the SQLite-backed store + a
 * `GlobalEventPublisher`) so the host can keep its inline routing
 * branches short.
 */
import { GetGoalTool, isAwaitingUsageRecovery, UpdateGoalTool, } from '@mavis/goal';
import { toRuntimeTool, } from '@mavis/agent-core/tools';
/**
 * Translate a {@link ThreadGoalChangedEvent} from the REST router into one
 * of the two Global Events the UI consumes (`thread_goal.updated` /
 * `thread_goal.cleared`).
 *
 * Host-settled model proposals route through here only after their durable
 * state CAS succeeds, so the banner never renders an unaccepted proposal.
 */
export function publishThreadGoalEvent(publish, event) {
    if (event.type === 'deleted') {
        publish({
            type: 'thread_goal.cleared',
            payload: { goalId: event.goalId, sessionId: event.sessionId },
        });
        return;
    }
    publish({
        type: 'thread_goal.updated',
        payload: {
            goal: {
                goalId: event.goal.goalId,
                sessionId: event.goal.sessionId,
                objective: event.goal.objective,
                status: event.goal.status,
                createdAt: event.goal.createdAt,
                updatedAt: event.goal.updatedAt,
                ...(event.goal.dismissedAt !== undefined ? { dismissedAt: event.goal.dismissedAt } : {}),
                tokensUsed: event.goal.tokensUsed,
                turnsUsed: event.goal.turnsUsed,
                timeUsedSeconds: event.goal.timeUsedSeconds,
                tokenBudget: event.goal.tokenBudget,
                ...globalOwnLimits(event.goal),
                statusReason: event.goal.statusReason,
                executionWait: globalExecutionWait(event.goal.executionWait),
                ...(event.goal.lastVerification !== undefined
                    ? {
                        lastVerification: {
                            backend: event.goal.lastVerification.backend,
                            verdict: event.goal.lastVerification.verdict,
                            reason: event.goal.lastVerification.reason,
                            missing: [...event.goal.lastVerification.missing],
                            notMetStreak: event.goal.lastVerification.notMetStreak,
                            at: event.goal.lastVerification.at,
                        },
                    }
                    : {}),
                hasKickoffAttachments: event.goal.kickoffAttachments.length > 0,
                ...globalRequestAccounting(event.goal.accounting),
                ...globalTokenUsage(event.goal.tokenUsage),
                ...globalUsageRecovery(event.goal),
            },
        },
    });
}
/**
 * The Goal's own request and time caps in the shared event shape (the
 * generated `GoalState` field names); absent when the Goal has none.
 */
export function globalOwnLimits(goal) {
    return {
        ...(typeof goal.requestLimit === 'number' ? { requestLimit: goal.requestLimit } : {}),
        ...(typeof goal.activeSecondsLimit === 'number'
            ? { activeSecondsLimit: goal.activeSecondsLimit }
            : {}),
    };
}
/**
 * The limits in force in the shared event shape (`GoalState.effectiveLimits`):
 * present whenever the runtime resolved them, with a member only for a limited
 * dimension, so `{}` reads as "nothing is limited".
 */
export function globalEffectiveLimits(limits) {
    return {
        effectiveLimits: {
            ...(limits.tokens !== null ? { tokenLimit: limits.tokens } : {}),
            ...(limits.mainTurns !== null ? { requestLimit: limits.mainTurns } : {}),
            ...(limits.activeSeconds !== null ? { activeSecondsLimit: limits.activeSeconds } : {}),
        },
    };
}
/**
 * Stamp the limits in force onto every `thread_goal.updated` event. The Goal
 * owner wraps its publisher once, so every producer of a Goal snapshot (and
 * there are many) carries the same resolution the budget gates use, without
 * each one reading the config.
 */
export function withThreadGoalEffectiveLimits(publish, resolve) {
    return (event) => {
        if (event.type !== 'thread_goal.updated') {
            publish(event);
            return;
        }
        const goal = event.payload.goal;
        publish({
            ...event,
            payload: { ...event.payload, goal: { ...goal, ...globalEffectiveLimits(resolve(goal)) } },
        });
    };
}
/**
 * A Goal's execution wait in the shared event shape. The background wait
 * details (spec G2-07) appear only when the owner attached them.
 */
export function globalExecutionWait(wait) {
    if (!wait)
        return null;
    return {
        reason: wait.reason,
        sinceMs: wait.sinceMs,
        ...(wait.waitedTasks
            ? {
                waitedTasks: wait.waitedTasks.map((task) => ({
                    taskId: task.taskId,
                    name: task.name,
                    startedAt: task.startedAt,
                })),
            }
            : {}),
        ...(wait.finishedTaskCount !== undefined ? { finishedTaskCount: wait.finishedTaskCount } : {}),
        ...(wait.backgroundTasksUnreadable ? { backgroundTasksUnreadable: true } : {}),
    };
}
/**
 * The four token parts in the shared event shape (the generated `GoalState`
 * field names); absent for a legacy Goal, whose usage is not split. A cache
 * write that was never reported is left out rather than sent as 0.
 */
export function globalTokenUsage(usage) {
    if (!usage)
        return {};
    return {
        tokenUsage: {
            inputTokens: usage.input,
            ...(usage.cacheWriteUnreported ? {} : { cacheWriteTokens: usage.cacheWrite }),
            cacheReadTokens: usage.cacheRead,
            outputTokens: usage.output,
        },
    };
}
/**
 * The Goal's request ledger in the shared event shape (the generated
 * `GoalState` field names). Every consumer of a Goal snapshot reads these
 * same values; absent when the Goal is not counted in requests.
 */
export function globalRequestAccounting(accounting) {
    if (!accounting)
        return {};
    return {
        accountingVersion: accounting.version,
        requestsUsed: accounting.requestsUsed,
        workRequests: accounting.workRequests,
        graceRequests: accounting.graceRequests,
        legacyTurns: accounting.legacyTurns,
        reservedRequests: accounting.reservedRequests,
        unknownRequests: accounting.unknownRequests,
        usageIncomplete: accounting.usageIncomplete,
    };
}
/**
 * Whether a quota-stopped Goal resumes by itself (spec §7), in the shared event
 * shape (the generated `GoalState` field). Only the fact leaves the runtime,
 * never the reset time; absent whenever no automatic recovery is scheduled.
 */
export function globalUsageRecovery(goal) {
    return isAwaitingUsageRecovery(goal) ? { usageRecoveryScheduled: true } : {};
}
/**
 * Build the model-facing Thread Goal lifecycle tools (`update_goal` /
 * `get_goal`) bound to the shared `ThreadGoalStore`. Goal creation is a
 * user-owned product action and is intentionally not exposed to the
 * local-runtime model.
 *
 * Returns an empty array when the host has disabled built-in tools for
 * the turn (e.g. the agent config opts out). The 2 impls deliberately
 * share the same store so the orchestrator's between-turn status check
 * sees the model's writes immediately.
 *
 * `update_goal` records terminal proposals through the host collector and
 * delegates limit edits to the supplied host mutation port.
 */
export function buildThreadGoalRuntimeTools(store, disabled, signalCollector, host = {}) {
    if (disabled)
        return [];
    return [
        toRuntimeTool(new UpdateGoalTool(store, signalCollector, host.budgetMutation, host.limitsOf)),
        toRuntimeTool(new GetGoalTool(store, host.limitsOf)),
    ];
}
//# sourceMappingURL=wiring.js.map