import { NativeLocalTurnExecutionPreparationSource } from '../../agent-host/assembly/local-turn-execution-preparation.js';
import { LocalTurnInputPreparer } from '../../agent-host/assembly/local-turn-input-preparation.js';
import { LocalRuntimeTurnExecutor } from '../../agent-host/execution/executor.js';
import { createAlignedAssistantMessageIdAllocator } from '../../agent-host/history/canonical-user-message-identities.js';
import { LocalAgentTurnRunner } from '../../agent-host/runner/local-agent-turn-runner.js';
import { LocalTurnPermissionGate } from '../../agent-host/runner/policy/local-turn-permission-gate.js';
import { createHostTurnReminders } from '../../agent-host/runner/reminder/host-turn-reminders.js';
import { createSessionIdentityReminderHook } from '../../agent-host/runner/reminder/session-identity-reminder.js';
import { createTodoCadenceReminderHook } from '../../agent-host/runner/reminder/todo-cadence-reminder.js';
import { hasPtcTurnChildTodoWrite } from '../../agent-host/execution/ptc/catalog.js';
import { createToolContentReview } from '../../agent-host/safety/tool-stage-review.js';
import { createMcpToolResultHistoryExternalizer } from '../../agent-host/tools/mcp-tool-result-externalizer.js';
import { createRunMainRequestProjection } from './compaction.js';
/** The Turn executor of one run: Host ports bound to harness-built runner, gates and hooks. */
export function createTurnExecutor(dependencies, scope, state) {
    const { policy, observability } = dependencies;
    const { host } = scope;
    const { contextUsage, ...projection } = host.projection;
    const mutations = host.permissions.mutations;
    return new LocalRuntimeTurnExecutor({
        pluginHooks: state.pluginHooks,
        ptcPrefixBaselines: state.ptcPrefixBaselines,
        cliProductPolicy: policy.cliProductPolicy,
        tuiProductPolicy: policy.tuiProductPolicy,
        ptcSurface: policy.ptcSurface,
        // Both absent when their beta switch is off: the executor then reports no
        // store and no script support, exactly as it did before either existed.
        ...(dependencies.ptc?.sessionStore
            ? { ptcSessionStore: dependencies.ptc.sessionStore }
            : {}),
        ...(dependencies.ptc?.scripts ? { ptcScriptsEnabled: true } : {}),
        contentReviewEnabled: policy.contentReviewEnabled,
        nativeDelete: policy.nativeDelete,
        createTurnToolSafetyGuard: policy.createTurnToolSafetyGuard,
        toolPolicyGuard: policy.toolPolicyGuard,
        suppressExecutionReminders: policy.suppressExecutionReminders,
        toolContentReview: createToolContentReview({
            check: (input, signal) => host.safety.check(input, signal),
            safety: policy.safety,
            metrics: observability?.metricsClient,
        }),
        nowMs: policy.nowMs,
        ...projection,
        ...host.accounting,
        onInputReviewResolved: host.safety.onInputReviewResolved,
        // The user message reached history: the Skill bodies this Turn preloaded are
        // durable, so their provisional receipts settle as committed.
        onUserMessageSubmitted: (lease) => {
            policy.toolCatalog.skillReceipts.settlePreloadReceipts(lease.sessionId, lease.turnId, true);
        },
        fileApi: host.fileApi,
        fileChanges: scope.turnDiff,
        createChildBashLifecycle: host.tools.createChildBashLifecycle,
        prepareBashTools: host.tools.prepareBashTools,
        createPtcResultProjection: host.tools.createPtcResultProjection,
        // A Host opt-in: Desktop leaves it off and keeps every child's whole
        // display copy. The writer is the same one and the same Session directory
        // as the run_code return-value spill, so a shortened copy can name the file
        // holding the whole text.
        ...(policy.ptcChildDisplayPreview === true
            ? {
                ptcChildDisplayPreview: true,
                writePtcChildDisplayArtifact: async (input) => await scope.artifacts.write(input),
            }
            : {}),
        logger: observability?.logger,
        metricsClient: observability?.metricsClient,
        runtime: new LocalAgentTurnRunner({
            ...observability,
            reviewContent: host.safety.reviewContent,
            onSlowReview: host.safety.onSlowReview,
            reviewOfflineWait: host.safety.reviewOfflineWait,
            gatewayReviewEnabled: host.safety.gatewayReviewEnabled,
            contentSafety: policy.safety,
            contextUsage,
            ...(policy.alignAssistantMessageIds === true
                ? { messageIdAllocator: createAlignedAssistantMessageIdAllocator() }
                : {}),
        }),
        executionPreparation: createExecutionPreparation(dependencies, scope),
        ...reminderHooks(dependencies, scope, state),
        finalizeToolResultForHistory: hostToolResultHistoryFinalizer(dependencies, createMcpToolResultHistoryExternalizer({
            getMaxInlineBytes: () => dependencies.compaction.toolResults()?.mcpDetailsMaxInlineBytes,
            writeArtifact: (input) => scope.artifacts.write(input),
            logger: observability?.logger,
        }).finalize),
        resolvePluginHookRuntimeContext: host.hooks?.resolveRuntimeContext,
        preparePluginHookSessionOwnership: host.hooks?.prepareSessionOwnership,
        activatePluginHookSessionOwnership: host.hooks?.activateSessionOwnership,
        clearPluginHookSessionPermissions: mutations && ((sessionId) => mutations.clearSession(sessionId)),
        promptSuggestion: dependencies.promptSuggestion,
        onReplyCommitted: dependencies.onReplyCommitted,
        turnStateLayer: host.turnState,
        segmentPrefixLength: host.compaction.segmentPrefixLength,
        turnFaults: host.turnFaults,
    });
}
function createExecutionPreparation(dependencies, scope) {
    const { policy, observability } = dependencies;
    const { host } = scope;
    return new NativeLocalTurnExecutionPreparationSource(new LocalTurnInputPreparer({
        ...host.input,
        getImageEncoding: policy.getImageEncoding,
        persistComputerUseSelection: scope.agent.turnRuntimeFacts?.persistComputerUseSelection,
        computerUsePluginId: scope.agent.turnRuntimeFacts?.computerUsePluginId,
        fs: scope.compute.fs,
    }), new LocalTurnPermissionGate({
        ...host.permissions,
        logger: observability?.logger,
        // Counts run_code children's permission outcomes (ptc_child_permission_total).
        metricsClient: observability?.metricsClient,
        enforceBuiltinTools: policy.cliProductPolicy === true && policy.tuiProductPolicy !== true,
    }), policy.askUserPolicy, observability?.logger);
}
/**
 * Reminder admission and post-compaction request hooks share the instance usage
 * anchor. The generic reminders are left out of a Turn whose Agent profile
 * suppresses them.
 */
function reminderHooks(dependencies, scope, state) {
    const anchor = state.usageAnchor;
    return {
        // Both loaders are left out when `beta.ptcScripts` is off, which installs
        // the withdrawing reminder, as when Memory V2 is off.
        ...createHostTurnReminders(anchor, scope.host.memorySummary, dependencies.ptc?.scriptCatalog, dependencies.ptc?.scriptCatalogInjected),
        afterCompactionBeforeLlmCallHooks: [...createRunMainRequestProjection(scope).hooks],
        genericExecutionReminderHooks: [
            createSessionIdentityReminderHook(anchor),
            createTodoCadenceReminderHook(anchor, hasPtcTurnChildTodoWrite),
        ],
    };
}
/**
 * Host-owned work beside the harness finalizer. The Host wrapper receives the finalizer the
 * harness built from the live tool-result config and this run's artifact store, so it can
 * record a ToolResult before the harness externalizes it. Absent, the harness one is used.
 */
function hostToolResultHistoryFinalizer(dependencies, base) {
    const wrap = dependencies.toolResultHistoryFinalizer;
    return wrap ? wrap(base) : base;
}
//# sourceMappingURL=turn-executor.js.map