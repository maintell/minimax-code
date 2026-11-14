import { isSameResolvedPath } from '@mavis/permission';
import { SAVE_PTC_SCRIPT_NAME } from '@mavis/agent-tools/desktop';
/**
 * Tools that write a file the Agent chose, and so cannot run in Plan Mode.
 * `save_run_code_script` belongs here because it writes `.minimax/ptc/*.mjs` and
 * `<dataDir>/ptc/*.mjs` directly, with no permission or approval code of its
 * own: without this entry a PTC Turn could create or replace a saved script
 * through a run_code child call while Plan Mode promised that only the
 * canonical Plan file was writable. PTC child calls do reach this guard; see
 * `plugin-hook-tool-lifecycle.ts` and agent-core's `ptc-tool-executor.ts`.
 *
 * The Plan state is this Session's own `interactionMode` and nothing else
 * (`turn-preflight.ts`), and a Task child Session does not inherit it, so a
 * subagent dispatched under Plan Mode is not bound by this guard. That includes
 * explore and verifier, which can call `save_run_code_script`, and it matches what
 * worker subagents already do.
 */
const FILE_MUTATION_TOOLS = new Set([
    'write',
    'edit',
    'append',
    'apply_patch',
    'multiedit',
    'notebook_edit',
    SAVE_PTC_SCRIPT_NAME,
]);
class LocalPlanPolicyGuard {
    platform;
    constructor(platform) {
        this.platform = platform;
    }
    async beforeToolCall(input) {
        const plan = input.plan;
        if (!plan)
            return undefined;
        const toolName = input.toolContext.toolCall.name;
        const args = readRecord(input.toolContext.args);
        const denial = planPolicyDenial(plan, toolName, args, this.platform);
        return denial ? blocked(toolName, denial) : undefined;
    }
}
export function createPlanPolicyGuard(options = {}) {
    return new LocalPlanPolicyGuard(options.platform ?? process.platform);
}
function exactPlanWriteAllowed(plan, toolName, args, platform) {
    const target = toolName === 'write' ? args.path : args.file_path;
    return (typeof target === 'string' &&
        target.length > 0 &&
        isSameResolvedPath(target, plan.canonicalPath, platform));
}
function planPolicyDenial(plan, toolName, args, platform) {
    if (FILE_MUTATION_TOOLS.has(toolName)) {
        const canonicalPlanWriteTool = toolName === 'write' || toolName === 'edit';
        if (canonicalPlanWriteTool && exactPlanWriteAllowed(plan, toolName, args, platform)) {
            return undefined;
        }
        if (toolName === SAVE_PTC_SCRIPT_NAME) {
            // The write/edit hint would send the model to paste the script into the
            // Plan file, which is not what a save is; the only real recovery is to
            // leave Plan Mode and save then.
            return 'saving run_code scripts is not available in Plan Mode. Continue planning, and save the script after ExitPlanMode';
        }
        return canonicalPlanWriteTool
            ? `the only writable file in Plan Mode is the canonical Plan file at ${plan.canonicalPath}. Retry targeting exactly that path, or continue investigating`
            : `this tool cannot be limited to the canonical Plan file. Use write or edit on exactly ${plan.canonicalPath} instead`;
    }
    if (toolName === 'EnterPlanMode') {
        return 'Plan Mode is already active. Continue planning and call ExitPlanMode when the canonical Plan file is ready for review';
    }
    return undefined;
}
function blocked(toolName, detail) {
    return {
        block: true,
        reason: `Plan Mode policy denied ${toolName}: ${detail}.`,
    };
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=tool-guard.js.map