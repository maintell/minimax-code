import { contextUsageDiagnostics } from './context-usage-diagnostics.js';
import { ContextUsageTurnTracker, withContextUsageEventWriter, } from './context-usage-turn-tracker.js';
import { createContextUsageRuntime } from './runtime.js';
/**
 * Provider diagnostics are the only way to tell a remote count from a BPE
 * fallback once a turn is over, and nothing else reads them. They are emitted
 * solely when the tracker produced them, which already carries the non-prod
 * build gate plus MAVIS_CONTEXT_USAGE_PROVIDER_DIAGNOSTICS=1 from the runtime.
 */
function reportProviderDiagnostics(measurement) {
    const diagnostics = measurement.providerDiagnostics;
    if (!diagnostics)
        return;
    contextUsageDiagnostics.info({
        status: diagnostics.status,
        method: diagnostics.method,
        fullCountBasis: diagnostics.fullCountBasis,
        providerFullTokens: diagnostics.providerFullTokens,
        providerFullVsInputAnchorTokens: diagnostics.providerFullVsInputAnchorTokens,
        reconstructedFullTokens: diagnostics.reconstructedFullTokens,
        reconstructedFullVsExactTokens: diagnostics.reconstructedFullVsExactTokens,
        rawPreparedMinusProviderTokens: diagnostics.rawPreparedMinusProviderTokens,
        closureTokens: diagnostics.closureTokens,
        ...(diagnostics.error === undefined ? {} : { error: diagnostics.error }),
        stages: diagnostics.components.map((component) => ({
            kind: component.kind,
            source: component.source,
            providerTokens: component.providerTokens,
            rawPreparedTokens: component.rawPreparedTokens,
            estimatorMinusProviderTokens: component.estimatorMinusProviderTokens,
            ...(component.fallbackReason === undefined
                ? {}
                : { fallbackReason: component.fallbackReason }),
            ...(component.retryRecovered === undefined
                ? {}
                : { retryRecovered: component.retryRecovered }),
        })),
    }, '[context-usage] provider diagnostics');
}
/**
 * Builds the Host-neutral Context Usage capability the Turn runner consumes:
 * each attempt gets a tracker that wraps the model stream and decorates the
 * completed assistant frame with the current-context snapshot.
 */
export function createContextUsageCapabilities(host) {
    const contextUsageRuntime = createContextUsageRuntime({
        ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
    });
    return {
        isEnabled: host.isEnabled,
        prepareAttempt: (input) => {
            const tracker = new ContextUsageTurnTracker(input.llm.model.contextWindow, input.promptRanges, reportProviderDiagnostics, contextUsageRuntime.calibrationCoordinator, contextUsageRuntime.providerDiagnosticCounter, input.requiresProviderAnchor);
            return {
                llm: {
                    ...input.llm,
                    streamFn: tracker.wrapStreamFn(input.llm.streamFn),
                },
                eventWriter: withContextUsageEventWriter(input.eventWriter, tracker),
            };
        },
    };
}
//# sourceMappingURL=capabilities.js.map