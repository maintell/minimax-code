import { isSameResolvedPath } from '@mavis/permission';
const FILE_MUTATION_TOOLS = new Set([
    'write',
    'edit',
    'append',
    'apply_patch',
    'multiedit',
    'notebook_edit',
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