import { ContextUsageTurnTracker, withContextUsageEventWriter, } from './context-usage.js';
import { createContextUsageRuntime } from '../runtime/context-usage-runtime.js';
export function createHostedAgentContextUsageCapabilities(host) {
    const contextUsageRuntime = createContextUsageRuntime({
        ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
    });
    return {
        contextUsage: {
            isEnabled: host.isContextWindowUsageEnabled,
            prepareAttempt: (input) => {
                const tracker = new ContextUsageTurnTracker(input.llm.model.contextWindow, input.promptRanges, undefined, contextUsageRuntime.calibrationCoordinator, contextUsageRuntime.providerDiagnosticCounter, input.requiresProviderAnchor);
                return {
                    llm: {
                        ...input.llm,
                        streamFn: tracker.wrapStreamFn(input.llm.streamFn),
                    },
                    eventWriter: withContextUsageEventWriter(input.eventWriter, tracker),
                };
            },
        },
    };
}
//# sourceMappingURL=hosted-agent-context-usage-capabilities.js.map