/**
 * Kernel internals exposed only to Host-side tests. Production Host code must import `@mavis/harness`.
 */
export { LocalPluginHooks } from '../agent-host/assembly/local-turn-plugin-hooks.js';
export { buildLocalRequestPayloadTransform } from '../agent-host/assembly/payload/local-turn-payload-transform.js';
export { buildMessagesFileApiPatcher } from '../agent-host/assembly/payload/messages-file-api-patcher.js';
export { ContextCompactionAttemptFactory, createAutomaticContextCompactionHook, createCompactionReplaceMetadata, } from '../agent-host/compaction/context-compaction.js';
export {} from '../agent-host/compaction/contracts.js';
export { beginSegmentCompactionTurn, segmentCompactionRoute, } from '../agent-host/compaction/segment-turn.js';
export { TurnCommitPipeline } from '../agent-host/events/turn-commit-pipeline.js';
export { createControlledToolHooks } from '../agent-host/execution/plugin-hook-tool-lifecycle.js';
export { renderAgentRuntimeReminders } from '../agent-host/execution/prompt.js';
export { createContinuationControl } from '../agent-host/execution/user-input-control.js';
export { startUserSteeringPreemption, USER_STEERING_QUEUED_CODE, } from '../agent-host/execution/user-steering-preemption.js';
export {} from '../agent-host/execution/ptc/contracts.js';
export { readPtcChildTools } from '../agent-host/execution/ptc/catalog.js';
export { createBackgroundTaskReadSettlement } from '../agent-host/history/background/task-read-settlement.js';
export { copyCanonicalHistoryForPiCompatibility } from '../agent-host/history/canonical-history-validation.js';
export { AgentHostCommittedHistoryWriter } from '../agent-host/history/committed-history-writer.js';
export { continuationRunnerHistory } from '../agent-host/history/continuation-history.js';
export {} from '../agent-host/history/contracts.js';
export { IncrementalSha256 } from '../agent-host/history/incremental-sha256.js';
export { captureSemanticSnapshot, estimateSemanticValueSize, } from '../agent-host/history/semantic-identity.js';
export { projectLocalAgentReferencesForModel } from '../agent-host/preparation/agent-prompt-surface.js';
export { TurnPreflight } from '../agent-host/preparation/turn-preflight.js';
export { createExecutionBudgetReminder } from '../agent-host/runner/reminder/execution-budget-reminder.js';
export { fingerprintPtcPrefix, PtcPrefixBaselines, } from '../agent-host/runner/observability/ptc-prefix-fingerprint.js';
export { renderDirectCallReminder } from '../agent-host/runner/ptc/direct-call-reminder.js';
export { executePtcQuickJs } from '../agent-host/runner/ptc/quickjs-executor.js';
export { createPtcRunCodeTool } from '../agent-host/runner/ptc/run-code-tool.js';
export { SendToUserDisplayProjectionWriter } from '../agent-host/runner/output/send-to-user-display-projection.js';
export { buildCheckpointMessage } from '../compaction/algorithm/checkpoint-format.js';
export { CHECKPOINT_SYSTEM_PROMPT } from '../compaction/algorithm/checkpoint-protocol.js';
export { buildAllToolResultsCandidate } from '../compaction/algorithm/history-reduction.js';
export { createLocalContextFootprintMeasurer } from '../compaction/execution/local-context-footprint.js';
export { createHarnessHistory } from '../engine/history.js';
export { withDefaultExtensions } from '../engine/kernel/default-extensions.js';
export * from '../engine/reference/index.js';
//# sourceMappingURL=index.js.map