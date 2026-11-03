// Bash retains ordinary permission checks; Review adds no argument policy.
const REVIEW_ALLOWED_TOOLS = new Set(['read', 'grep', 'glob', 'skill', 'bash']);
// In a PTC-mode Session the allowed tools are run_code children. The trusted
// run_code is only the program; each child reaches this guard on its own name
// and source, so the allowlist above still decides every call it makes.
const REVIEW_PTC_PROGRAM_TOOL = 'run_code';
// Native controls enforce session ownership in the task service. Review must
// retain them when an allowed Bash call runs in the background.
const REVIEW_TASK_CONTROLS = new Set(['task_query', 'task_output', 'task_stop']);
export function createReviewToolGuard(state) {
    return {
        beforeToolCall(toolContext) {
            if (!state.isReviewActivated())
                return undefined;
            const toolName = toolContext.toolCall.name;
            if (toolName === 'code_review') {
                return {
                    block: true,
                    reason: buildRepeatedCodeReviewReason(state.prepared),
                };
            }
            if (toolName === 'skill' && readSkillName(toolContext.args) === 'code-review') {
                return {
                    block: true,
                    reason: buildRepeatedCodeReviewSkillReason(state.prepared),
                };
            }
            if (isReviewAllowedTool(toolName, readToolSource(toolContext.toolCall)))
                return undefined;
            return {
                block: true,
                reason: `Code Review tool policy denied "${toolName}".`,
            };
        },
    };
}
function isReviewAllowedTool(toolName, source) {
    if (source === 'builtin' && toolName === REVIEW_PTC_PROGRAM_TOOL)
        return true;
    if (source !== 'configured' && REVIEW_ALLOWED_TOOLS.has(toolName))
        return true;
    return (source === undefined || source === 'builtin') && REVIEW_TASK_CONTROLS.has(toolName);
}
function readSkillName(input) {
    if (!input || typeof input !== 'object')
        return undefined;
    const name = input.name;
    return typeof name === 'string' ? name.trim().toLowerCase() : undefined;
}
function buildRepeatedCodeReviewSkillReason(prepared) {
    if (prepared?.responseLanguage === 'zh-CN') {
        return '当前结构化 Review 已经激活，不要再读取 code-review Skill；请使用允许的只读工具继续审查。';
    }
    return 'Structured Review is already active. Do not load the code-review Skill; continue with the allowed read-only tools.';
}
function buildRepeatedCodeReviewReason(prepared) {
    const isSlash = prepared?.trigger === 'slash';
    if (prepared?.responseLanguage === 'zh-CN') {
        return isSlash
            ? '当前 Review 已由 Slash 请求激活，不能再次调用 code_review。请直接使用允许的只读工具检查当前改动，并返回 Review 结果。'
            : '当前 Turn 的 Review 已经激活，不能再次调用 code_review。请直接使用允许的只读工具继续检查，并返回 Review 结果。';
    }
    return isSlash
        ? 'Code Review is already active for this Slash request. Do not call code_review again. Inspect the current changes with the allowed read-only tools and return the Review result directly.'
        : 'Code Review is already active for this turn. Do not call code_review again. Continue with the allowed read-only tools and return the Review result directly.';
}
function readToolSource(toolCall) {
    if (!toolCall || typeof toolCall !== 'object')
        return undefined;
    return toolCall.source;
}
//# sourceMappingURL=tool-guard.js.map