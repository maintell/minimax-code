import { createUiRequestBroker } from './ui-request-broker.js';
/**
 * One broker per Runtime: the Agent tools raise requests through it and the
 * HTTP reply route settles them. It holds only in-memory pending state, so a
 * restart drops every outstanding request exactly like a closed window does.
 */
export function createRuntimeUiRequestBroker(input) {
    const broker = createUiRequestBroker({
        publishGlobalEvent: input.publishGlobalEvent,
        ...(input.metrics ? { metrics: input.metrics } : {}),
        ...(input.logger ? { logger: input.logger } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(input.newRequestId ? { newRequestId: input.newRequestId } : {}),
        ...(input.timeoutMsFor ? { timeoutMsFor: input.timeoutMsFor } : {}),
    });
    input.bind?.(broker);
    return broker;
}
//# sourceMappingURL=initialize.js.map