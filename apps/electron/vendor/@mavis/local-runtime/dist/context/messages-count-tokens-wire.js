export const NON_VISION_USER_IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';
export const NON_VISION_TOOL_IMAGE_PLACEHOLDER = '(tool image omitted: model does not support images)';
export const PRIOR_THINKING_OPEN = '<|prior-thinking|>';
export const PRIOR_THINKING_CLOSE = '<|/prior-thinking|>';
export const SIBLING_NATIVE_THINKING_APIS = new Set([
    'anthropic-messages',
    'bedrock-converse-stream',
]);
const REFERENCE_CLI_TOOLS = [
    'Read',
    'Write',
    'Edit',
    'Bash',
    'Grep',
    'Glob',
    'AskUserQuestion',
    'EnterPlanMode',
    'ExitPlanMode',
    'KillShell',
    'NotebookEdit',
    'Skill',
    'Task',
    'TaskOutput',
    'TodoWrite',
    'WebFetch',
    'WebSearch',
];
const REFERENCE_CLI_TOOL_LOOKUP = new Map(REFERENCE_CLI_TOOLS.map((name) => [name.toLowerCase(), name]));
export function isMessagesOAuthToken(apiKey) {
    return apiKey.includes('sk-ant-oat');
}
export function toReferenceToolName(name) {
    return REFERENCE_CLI_TOOL_LOOKUP.get(name.toLowerCase()) ?? name;
}
export function normalizeToolCallId(id) {
    return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
export function sanitizeSurrogates(text) {
    return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
//# sourceMappingURL=messages-count-tokens-wire.js.map