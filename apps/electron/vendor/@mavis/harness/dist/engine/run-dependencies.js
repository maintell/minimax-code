import { buildLocalRequestPayloadTransform } from '../agent-host/assembly/payload/local-turn-payload-transform.js';
import { assertAgentHostCapabilityAvailable, } from '../agent-host/empty-dependencies.js';
import { fenceForceReleasedTurns } from '../agent-host/events/released-turn-fence.js';
import { clearCompactedSkillReceipts } from '../agent-host/tools/agent-skill-preload.js';
import { createCompactionDependencies } from './kernel/compaction.js';
import { withModelCredentials } from './kernel/model-credential.js';
import { createTurnExecutor } from './kernel/turn-executor.js';
import { createNormalRuntimeProfile } from './kernel/turn-runtime.js';
import { bindScopedTurnControl, COMPACTION_TURN_CONTROL } from './turn-control.js';
/** Kernel dependency bag for one run: harness-built kernel parts bound to the lease-bound scope. */
export function agentHostRunDependencies(dependencies, scope, state) {
    // A Turn ended by force never writes again (context reset spec 3.2).
    return fenceForceReleasedTurns({
        ...agentHostScopedDependencies(dependencies, scope, state),
        turnControl: withForceReleaseProbe(bindScopedTurnControl(scope.host.control), scope.host.control.isForceReleased),
    });
}
/**
 * `bindScopedTurnControl` lifts only the lease-scoped callbacks; the force-release probe is
 * lease-independent, so the run fence reads it from the Host control. Absent, the control and
 * therefore the fence stay exactly as they were.
 */
function withForceReleaseProbe(control, isForceReleased) {
    return isForceReleased ? { ...control, isForceReleased } : control;
}
/** Kernel dependency bag for one compaction; it carries no Turn control. */
export function agentHostCompactionDependencies(dependencies, scope, state) {
    return {
        ...agentHostScopedDependencies(dependencies, scope, state),
        turnControl: COMPACTION_TURN_CONTROL,
    };
}
function agentHostScopedDependencies(dependencies, scope, state) {
    assertScopeOwners(scope);
    const { agent, host, telemetry } = scope;
    const logger = dependencies.observability?.logger;
    // One receipt store for the whole Runtime: the gate, the first-Turn preload,
    // the committed-compaction clear and the Host's own rewind / session-deleted
    // clears all read the instance the composition root injected.
    const skillReceipts = dependencies.policy.toolCatalog.skillReceipts;
    const events = state.events(host.events);
    const payload = { fileApi: host.fileApi, nowMs: dependencies.policy.nowMs };
    return {
        agentRuntimes: {
            normal: createNormalRuntimeProfile(() => state.agentRuntime(), {
                tools: host.tools,
                policy: dependencies.policy.toolCatalog,
                logger,
                ptc: dependencies.ptc,
                // run_code saves a return value over 64 KiB where oversized results are externalized.
                writePtcReturnArtifact: async (input) => await scope.artifacts.write(input),
            }),
        },
        executor: createTurnExecutor(dependencies, scope, state),
        compaction: createCompactionDependencies(dependencies, scope, state),
        // A committed compaction rewrote the history, so the model lost every Skill
        // body it carried: the receipts for bodies that history no longer holds go
        // with them, and the next prompted Turn preloads those Skills again.
        onCompactionCommitted: (sessionId, messages) => {
            clearCompactedSkillReceipts({
                receipts: skillReceipts,
                sessionId,
                messages,
                ...(logger ? { logger } : {}),
            });
        },
        // A Turn that ends before its user message reaches history never carries the
        // Skill bodies it preloaded, so its provisional receipts go with it and the
        // next prompted Turn preloads them again.
        onTurnSettled: (sessionId, turnId) => {
            skillReceipts.settlePreloadReceipts(sessionId, turnId, false);
        },
        isRuntimeErrorRetryable: dependencies.isRuntimeErrorRetryable,
        ...(dependencies.policy.alignAssistantMessageIds === true
            ? { alignAssistantMessageIds: true }
            : {}),
        buildRequestPayloadTransform: (input) => buildLocalRequestPayloadTransform(input, payload),
        promptSuggestion: dependencies.promptSuggestion,
        agents: agent.source,
        preparation: withModelCredentials(agent.preparation, scope.model),
        promptSnapshots: agent.promptSnapshots,
        internalTurnPromptReads: agent.internalTurnPromptReads,
        turnRuntimeFacts: agent.turnRuntimeFacts,
        pluginHooks: state.pluginHooks,
        ptcPrefixBaselines: state.ptcPrefixBaselines,
        sessions: host.session,
        planDocuments: host.session.planDocuments,
        history: state.history(host.history),
        events,
        historyFailure: events,
        backgroundTaskReads: host.backgroundTasks,
        turnCapabilities: host.hooks?.capabilities,
        resolvePluginHookRuntimeContext: host.hooks?.resolveRuntimeContext,
        logger,
        usage: telemetry?.usage,
        assemblyObserver: telemetry?.assemblyObserver,
        turnTiming: telemetry?.turnTiming,
    };
}
/** Fails closed before any kernel part runs when a required Host owner is missing. */
function assertScopeOwners(scope) {
    const { agent, host, telemetry } = scope;
    const owners = [
        ['session-system-read', typeof host?.session?.get === 'function'],
        ['agent-execution-source', typeof agent?.source?.getExecutionSnapshot === 'function'],
        ['turn-preparation', typeof agent?.preparation?.prepare === 'function'],
        ['compaction-preparation', typeof agent?.preparation?.prepareCompaction === 'function'],
        ['model-access', typeof scope.model?.credential === 'function'],
        ['compaction-control', typeof host?.compaction?.control?.beginClose === 'function'],
        [
            'compaction-lifecycle',
            typeof host?.compaction?.lifecycle?.completeCommittedHistory === 'function' &&
                typeof host.compaction.lifecycle.failCommittedHistory === 'function',
        ],
        [
            'usage-projector',
            !telemetry?.usage || typeof telemetry.usage.projector?.record === 'function',
        ],
    ];
    for (const [capability, available] of owners) {
        assertAgentHostCapabilityAvailable(capability, available);
    }
}
//# sourceMappingURL=run-dependencies.js.map