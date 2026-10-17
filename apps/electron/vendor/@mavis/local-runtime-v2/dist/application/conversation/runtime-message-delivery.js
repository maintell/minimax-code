import { UserMessageTurnDeliveryService, } from './index.js';
/** Wires the V2 conversation delivery use case to owned Session and Channel capabilities. */
export function createRuntimeMessageDelivery(sessionSystem, channelSystem, queryCollapseKeys, options = {}) {
    return new UserMessageTurnDeliveryService({
        messages: sessionSystem.messages.userMessages,
        stream: sessionSystem.stream,
        queryCollapse: {
            resolveQueryKey: (sessionId, turnId, input) => input?.reuseLatestVisibleQuery
                ? queryCollapseKeys.queryKeyForContinuation(sessionId, turnId)
                : queryCollapseKeys.queryKeyForTurn(sessionId, turnId),
            start: (input) => sessionSystem.queryCollapse.state.start(input),
        },
        ...(channelSystem
            ? {
                beforeExecution: (input) => channelSystem.turnLifecycle.beforeExecution(input),
            }
            : {}),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        ...(options.sessionClio ? { sessionClio: options.sessionClio } : {}),
    });
}
//# sourceMappingURL=runtime-message-delivery.js.map