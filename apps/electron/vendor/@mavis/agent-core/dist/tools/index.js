/**
 * `@mavis/agent-core/tools` —— tool protocol types, `defineRuntimeTool`, and
 * decorated-class `bindTool` / `toRuntimeTool` helpers.
 *
 * Usage:
 *
 * ```ts
 * import { defineRuntimeTool } from '@mavis/agent-core/tools';
 * import { Type } from '@sinclair/typebox';
 *
 * const CloudBashTool = defineRuntimeTool({
 *   name: 'bash',
 *   description: 'Execute a command in the cloud sandbox executor.',
 *   schema: Type.Object({ command: Type.String() }),
 *   async execute(ctx, input, signal) { ... },
 * });
 * ```
 */
export { attachProgrammaticErrorData, attachProgrammaticErrorRaw, readImageEncodedContent, readProgrammaticErrorData, readProgrammaticErrorRaw, recordImageEncodedContent, withProgrammaticResult, } from './programmatic.js';
export { createPtcToolFactCollector, PTC_DEFAULT_WALL_CLOCK_MS, PTC_MAX_WALL_CLOCK_MS, readPtcChildExecutionDetails, readPtcExecutionDetails, readPtcToolCallRecords, resolvePtcWallClock, } from './ptc.js';
export { defineRuntimeTool } from './define.js';
export { isToolSteerInterruption } from './steer-interruption.js';
export { bindTool, toRuntimeTool } from './bind.js';
export { prepareEditArguments } from './edit-prepare-arguments.js';
export { isRuntimeToolInputValid, repairRuntimeToolInput, validateRuntimeToolInput, } from './input-validation.js';
export { TURN_STOPPING_TOOL_RESULT_DETAIL, TURN_TERMINATING_TOOL_RESULT_DETAIL, isTurnClosedByTerminatingTools, isTurnClosedByTerminatingToolsAt, isTurnStoppingToolResultDetails, isTurnTerminatingToolResultDetails, } from './turn-termination.js';
export { toolResultIsError } from './result-error.js';
export { ReadToolDef, WriteToolDef, EditToolDef, BashToolDef, GrepToolDef, GlobToolDef, TodoWriteToolDef, TaskToolDef, } from './builtin-defs.js';
//# sourceMappingURL=index.js.map