export { AgentEventAssociationError, AgentEventIdentityError, AgentExecutionSnapshotNotFoundError, AgentCompactionAssociationError, AgentCompactionCloseError, AgentCompactionSnapshotError, AgentHostCompactionLeaseError, AgentHostTurnLeaseError, AgentHostTurnSequenceError, AgentHostSessionReadError, AgentHistoryOperationIdentityError, AgentTerminalConfirmationError, LocalAgentHost, } from './local-agent-host.js';
export { AgentHostAssemblyContextValidationError } from './assembly-context.js';
export { AgentHostTurnCapabilityLifecycle, } from './assembly/turn-capability-lifecycle.js';
export { ContextCompactionResultValidationError } from './compaction/context-compaction.js';
export { AgentHostDependencyUnavailableError, assertAgentHostCapabilityAvailable, assertAgentHostCompactionDependenciesReady, createEmptyAgentHostDependencies, } from './empty-dependencies.js';
export { combineAgentEventObservers } from './events/combined-event-observer.js';
export { AgentEventAcknowledgementError, AgentEventIdentityConflictError, AgentEventSequenceError, AgentEventValidationError, AgentHistoryFailureValidationError, RequiredAgentEventDelivery, } from './events/required-agent-event-delivery.js';
export { CanonicalHistoryValidationError, DurableCanonicalHistoryStore, } from './history/durable-canonical-history-store.js';
export { ADVISOR_TOOL_NAME, buildLocalTurnToolCatalog, createLocalAgentCapabilitySelector, filterLocalTurnCapabilityInventory, isAgentSelectorMcpToolName, isLocalTurnBuiltinToolAllowed, resolveToolsAllowlistScope, } from './assembly/local-turn-tool-catalog.js';
export { buildLocalRequestPayloadTransform, buildLocalTurnPayloadTransform, } from './assembly/payload/local-turn-payload-transform.js';
export { withUserQuestionTools } from './tools/user-question-tools.js';
// A Host wraps its own tool-result History finalizer around the harness one
// (`HarnessDependencies.toolResultHistoryFinalizer`); this is the product recorder it uses.
export { createAssetsUploadSyncRecorder, } from './tools/assets-upload-sync-recorder.js';
export { NativeLocalTurnExecutionPreparationSource, } from './assembly/local-turn-execution-preparation.js';
export { LocalTurnInputPreparer, } from './assembly/local-turn-input-preparation.js';
export * from './runner/index.js';
export { AgentHostTurnCloseError } from './runner/turn-close-error.js';
export { LocalRuntimeTurnExecutor, } from './execution/executor.js';
export { LocalRuntimeTerminalError, LocalRuntimeTerminalIdentityError, } from './events/turn-commit-pipeline.js';
export { AgentHostUserInputValidationError, captureAgentHostExecutionRequest, createCanonicalAgentHostUserInput, isUserAuthoredSource, isUserAuthoredTurnSource, } from './canonical-user-input.js';
export { WAKE_LINE_CUSTOM_TYPE, createWakeLineMessage, isSilentTurn, isUserSourcedWakeReason, renderWakeLine, resolveInputWakeReason, resolveTurnWakeReasons, wakeReasonsAllowSilence, } from './preparation/turn-wake-reasons.js';
export { createRecallPointersMessage, createStateDeltaMessage, RECALL_POINTERS_HEADER, STATE_DELTA_MESSAGE_ID_PREFIX, } from './execution/turn-state-layer/state-delta-message.js';
export { isRecallPointersMessage, isStateDeltaMessage, RECALL_POINTERS_CUSTOM_TYPE, STATE_DELTA_CUSTOM_TYPE, } from './execution/turn-state-layer/hidden-messages.js';
export { FrozenTurnPrefixes, MESSAGES_PROTOCOL_PROMPT_CACHE_TTL_MS, resolvePromptCacheTtlMs, } from './execution/turn-state-layer/prefix-freeze.js';
export { scopeAgentExtension } from './assembly/scoped-extension.js';
export { scopeSegmentCompaction } from './compaction/segment-turn.js';
export { SegmentPlanRefusedError } from './history/committed-history-writer.js';
export { projectTurnRequestContext } from './execution/ptc/compaction-reminder.js';
export { normalizeModelSelection, } from './preparation/config/model-selection-input.js';
// Re-exported for local-runtime-v2, which consumes these through the harness
// root entrypoint only (its own agent-host barrel no longer forwards them).
export { BunnyContextResetError } from './compaction/segment-turn.js';
export { continuationTailWait } from './history/continuation-history.js';
export { RECALL_POINTERS_HEADING } from './execution/turn-state-layer/state-delta-message.js';
export { report } from './runner/ptc/ptc-observability.js';
export { resolveChildBashSteeringContext, waitsForChildBash, withGenuineQueryProvenance, } from './execution/user-input-control.js';
export { coordinatorSteeringOptions } from './execution/turn-state-layer/turn-state.js';
export { STORE_HINT } from './execution/ptc/run-code-description.js';
export { PtcSessionStore, ptcStoredValuesBlock, } from './execution/ptc/session-store/index.js';
// Host-owned Turn reminders; local-runtime-v2 assembles them against its usage anchor.
export { createHostTurnReminders } from './runner/reminder/host-turn-reminders.js';
// PTC saved-script specifier normalization; the script loader moved into harness
// with the rest of runner/ptc/script, so the Host reaches it through the barrel.
export { normalizePtcScriptSpecifier } from './runner/ptc/script/loader.js';
//# sourceMappingURL=index.js.map