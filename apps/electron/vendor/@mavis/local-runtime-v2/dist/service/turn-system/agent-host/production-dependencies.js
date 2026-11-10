import { assertAgentHostCapabilityAvailable } from './empty-dependencies.js';
import { RequiredAgentEventDelivery, } from './events/required-agent-event-delivery.js';
import { DurableCanonicalHistoryStore, } from './history/durable-canonical-history-store.js';
import { LocalRuntimeTurnExecutor, } from './execution/executor.js';
import { buildLocalRequestPayloadTransform } from './assembly/local-turn-payload-transform.js';
/**
 * Explicit composition seam for concrete AgentHost adapters.
 *
 * It intentionally does not attach the Host to services.ts, Dispatcher, HTTP,
 * or v1 compatibility. Those owners remain a later production wiring step.
 */
export function createAgentHostProductionDependencies(options) {
    validateBaseOwners(options);
    const history = new DurableCanonicalHistoryStore(options.canonicalHistory);
    assertAgentHostCapabilityAvailable('history-failure-projector', typeof options.events?.historyFailures?.projectHistoryFailure === 'function');
    const events = new RequiredAgentEventDelivery(options.events);
    validateUsageProjection(options.usage);
    return createDependencyRecord(options, history, events, 
    // The suggestion port is host-owned; the executor only forwards the
    // short-lived capture after a successful commit.
    new LocalRuntimeTurnExecutor(options.promptSuggestion
        ? { ...options.executor, promptSuggestion: options.promptSuggestion }
        : options.executor));
}
function validateUsageProjection(usage) {
    if (usage) {
        assertAgentHostCapabilityAvailable('usage-projector', typeof usage.projector?.record === 'function');
    }
}
function createDependencyRecord(options, history, events, executor) {
    return {
        sessions: options.sessions,
        ...(options.planDocuments ? { planDocuments: options.planDocuments } : {}),
        agentRuntimes: options.agentRuntimes,
        agents: options.agents,
        promptSnapshots: options.promptSnapshots,
        ...(options.internalTurnPromptReads
            ? { internalTurnPromptReads: options.internalTurnPromptReads }
            : {}),
        ...withTurnRuntimeFacts(options.turnRuntimeFacts),
        preparation: options.preparation,
        turnControl: options.turnControl,
        ...(options.executor.resolvePluginHookRuntimeContext
            ? { resolvePluginHookRuntimeContext: options.executor.resolvePluginHookRuntimeContext }
            : {}),
        ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
        ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
        promptSuggestion: options.promptSuggestion,
        history,
        events,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
        executor,
        buildRequestPayloadTransform: createRequestPayloadTransform(options.executor),
        compaction: {
            ...options.compaction,
            preparation: options.preparation,
        },
        historyFailure: events,
        ...(options.isRuntimeErrorRetryable
            ? { isRuntimeErrorRetryable: options.isRuntimeErrorRetryable }
            : {}),
    };
}
function createRequestPayloadTransform(executor) {
    const options = {
        ...(executor.fileApi ? { fileApi: executor.fileApi } : {}),
        ...(executor.nowMs ? { nowMs: executor.nowMs } : {}),
    };
    return (input) => buildLocalRequestPayloadTransform(input, options);
}
function withTurnRuntimeFacts(turnRuntimeFacts) {
    return turnRuntimeFacts ? { turnRuntimeFacts } : {};
}
function validateBaseOwners(options) {
    assertAgentHostCapabilityAvailable('session-system-read', typeof options.sessions?.get === 'function');
    assertAgentHostCapabilityAvailable('agent-runtime', typeof options.agentRuntimes?.normal?.assembleTurn === 'function' &&
        typeof options.agentRuntimes.normal.assembleModelContext === 'function');
    assertAgentHostCapabilityAvailable('agent-execution-source', typeof options.agents?.getExecutionSnapshot === 'function');
    assertAgentHostCapabilityAvailable('turn-preparation', typeof options.preparation?.prepare === 'function');
    assertAgentHostCapabilityAvailable('compaction-preparation', typeof options.preparation?.prepareCompaction === 'function');
    assertAgentHostCapabilityAvailable('context-compactor', typeof options.compaction?.automatic?.compactBeforeLlm === 'function' &&
        typeof options.compaction.manual?.compactManual === 'function');
    assertAgentHostCapabilityAvailable('compaction-control', typeof options.compaction?.control?.beginClose === 'function');
    assertAgentHostCapabilityAvailable('compaction-lifecycle', typeof options.compaction?.lifecycle?.completeCommittedHistory === 'function' &&
        typeof options.compaction.lifecycle.failCommittedHistory === 'function');
    const control = options.turnControl;
    assertAgentHostCapabilityAvailable('turn-control', typeof control?.scope === 'function');
}
//# sourceMappingURL=production-dependencies.js.map