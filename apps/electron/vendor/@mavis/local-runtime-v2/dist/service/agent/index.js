/** Internal Agent composition gate. The package `./agent` export points at public.ts. */
export * from './public.js';
// Storage-level config parse failure. Exposed so aggregation consumers outside
// the Agent service (pin hydration, sidebar composition) can isolate one broken
// agent.md without deep-importing storage internals.
export { AgentConfigError } from './storage/canonical-agent-config.js';
export { createRuntimeAgentComposition, } from './composition.js';
export { LocalPromptSnapshotSource } from './prompt-snapshot-source.js';
export { redactedAgentRef, redactedErrorFacts } from './diagnostics.js';
export { readPromptWithBuiltinFallback } from './prompt-template.js';
export { AgentImportService, } from './application/agent-import.js';
export { emitSubagentTelemetry } from './runtime/subagent-telemetry.js';
export { roleClass } from './runtime/subagent-telemetry.js';
export { SUBAGENT_TELEMETRY_EVENT } from './runtime/subagent-telemetry.js';
export { resolveTaskTarget } from './runtime/port.js';
export { createFailClosedAgentRuntimePort } from './runtime/runtime-port.js';
export { createLocalMavisAgentAdapter } from './runtime/runtime-port.js';
export { isAgentNotFoundError } from './runtime/runtime-port.js';
export { createDeferredLocalAgentRuntimePort } from './runtime/runtime-port.js';
export { createSubagentFinishTelemetrySink } from './runtime/subagent-telemetry.js';
export { emitResourceAmbiguityTelemetry } from './runtime/subagent-telemetry.js';
export { inferNameResolutionSource } from './runtime/subagent-telemetry.js';
export { telemetryErrorCode } from './runtime/subagent-telemetry.js';
//# sourceMappingURL=index.js.map