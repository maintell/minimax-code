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
//# sourceMappingURL=index.js.map