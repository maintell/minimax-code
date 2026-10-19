/**
 * `@mavis/agent-runtime` —— pluggable extension SPI + assembleTurn assembler.
 *
 * See design doc: 飞书 wiki《agent-runtime：agent-core 之上的可插拔扩展层》v1.0
 * (`.harness/docs/adr/agent-runtime-extension-layer.md` when ADR lands)
 *
 * Public surface:
 *   - `createAgentRuntime(opts)` —— host 入口
 *   - `AgentRuntime` interface
 *   - `AgentExtension / ExtensionAPI / TurnAssemblyCtx / AssemblyResult` SPI types
 *   - `resolveExtensions()` —— 单元测试可直接调；host 通常无需直接使用
 *
 * 内部实现 (`Registry`) 通过 named export 暴露给 test 使用，业务代码走 `createAgentRuntime`。
 */
export { createAgentRuntime } from './api.js';
export { createExtension, createHookExtension, createPromptExtension, createReminderExtension, createToolExtension, } from './factories.js';
export { Registry } from './registry.js';
export { resolveExtensions } from './resolve.js';
export { isPromptSnapshotInvalidError, PromptSnapshotInvalidError } from './prompt-read.js';
export { BoundedInternalTurnPromptReadRegistry } from './internal-turn-prompt-read.js';
export { defineRuntimeTool } from '@mavis/agent-core/tools';
export { buildToolCallCitationId, collapseAdjacentDuplicateFileCitations, collectFetchedWebSources, collectWebSourceCitations, collectUsedWebEvidenceIds, shellSourceStages, compactToolCallCitationKey, findUniqueSingleSubstitutionCitationAlias, resolveKnownCitationAlias, } from '@mavis/agent-core';
export * from './types.js';
//# sourceMappingURL=index.js.map