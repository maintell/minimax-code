import { createGoalNotActiveReminderExtension, } from '../../service/goal/index.js';
/**
 * Connects the single Goal owner to Turn execution: Goal tools in the tool
 * catalog, the request barrier and step stop of Goal Turns, per-Turn
 * observation and settlement, the before-tool budget guard, the reminder that
 * keeps ordinary Turns off a stopped Goal, and the raw LLM failure feed that
 * schedules account-quota recovery.
 */
export function withGoalAgentProduct(product, goal) {
    const baseFailureHook = product.runner.onLLMRequestFailure;
    return {
        ...product,
        toolSources: {
            resolve: async (input) => {
                const base = await product.toolSources.resolve(input);
                return {
                    ...base,
                    threadGoalTools: input.toolsDisabled
                        ? []
                        : await goal.service.runtimeToolsFor(false, input.session.sessionId),
                };
            },
        },
        turnRequestControl: (turn) => {
            const requestLifecycle = goal.service.requestLifecycleFor(turn);
            return requestLifecycle
                ? {
                    requestLifecycle,
                    shouldStopAfterStep: () => goal.service.shouldStopAfterStep(turn),
                    isWorkClosed: () => goal.service.isWorkClosed(turn),
                }
                : undefined;
        },
        turnUsageRecorder: (turn) => goal.service.usageRecorderFor(turn),
        eventObserver: goal.turnLifecycle.observer,
        turnSettlement: goal.turnLifecycle.settlement,
        normalExtensions: [
            goal.turnLifecycle.budgetGuard,
            createGoalNotActiveReminderExtension(goal.service),
            ...(product.normalExtensions ?? []),
        ],
        runner: {
            ...product.runner,
            onLLMRequestFailure: (info) => {
                goal.observeLLMRequestFailure(info);
                baseFailureHook?.(info);
            },
        },
    };
}
//# sourceMappingURL=goal-agent-product.js.map