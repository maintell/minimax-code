const ASK_USER_TOOL_NAME = 'ask_user';
const SKILL_TOOL_NAME = 'skill';
export function isBrowserUseToolingAvailable(filePanelBrowserEnabled, browserUseToolingEnabled, provider) {
    if (browserUseToolingEnabled !== true)
        return false;
    const normalizedProvider = provider?.trim();
    return normalizedProvider && normalizedProvider !== 'electron-file-panel'
        ? true
        : filePanelBrowserEnabled === true;
}
function createBrowserSkillExclusiveStepHook(options) {
    return async (input) => {
        const requiredSkillName = options.requiredSkillName(input.sessionId, input.turnId);
        if (!requiredSkillName)
            return undefined;
        const toolCalls = input.message.content.filter((block) => block.type === 'toolCall');
        if (toolCalls.length < 2)
            return undefined;
        const loadsBrowserSkill = toolCalls.some((toolCall) => toolCall.name === SKILL_TOOL_NAME &&
            readSkillName(toolCall.arguments) === requiredSkillName);
        if (!loadsBrowserSkill)
            return undefined;
        return {
            type: 'retry',
            reason: 'browser_skill_must_be_loaded_alone',
            prompt: `Load ${requiredSkillName} in an assistant step containing only the ` +
                '`skill` tool call. Do not call Browser, shell, file, or any other tool in the same ' +
                'assistant response. After the Skill result returns, decide the next Browser action in ' +
                'a new assistant response.',
        };
    };
}
export function createBrowserUseExtension(options) {
    const exclusiveSkillStep = createBrowserSkillExclusiveStepHook(options);
    return {
        id: 'browser-use-policy',
        description: 'Enforces Browser Skill ordering before Browser tool execution.',
        init(api) {
            api.on('after_llm_call', (input) => exclusiveSkillStep(input));
            api.on('turn_end', (event) => options.clearTurn(event.sessionId, event.turnId));
        },
    };
}
export function createBrowserUseTurnToolSafetyGuard(options) {
    let requiredTool;
    return {
        beforeToolCall(input) {
            if (options.rejectLegacyFeatureEnable && isLegacyBrowserFeatureEnable(input)) {
                return {
                    block: true,
                    reason: 'BROWSER_PLUGIN_MANAGED: Desktop Browser control is managed by the Browser Use Plugin; the legacy request_feature_enable card is not accepted.',
                };
            }
            if (!requiredTool || input.toolCall.name === requiredTool)
                return undefined;
            return {
                block: true,
                reason: `REQUIRED_NEXT_TOOL: Browser requires an actual ${requiredTool} tool call before ` +
                    `any other tool; blocked ${input.toolCall.name}.`,
            };
        },
        afterToolCall(input) {
            // A trusted Browser result can be marked as an error after compact
            // result bounding while still carrying a binding takeover marker.
            if (!isTrustedBrowserToolCall(input.toolCall))
                return;
            if (readRequiredNextTool(input.result?.details) === ASK_USER_TOOL_NAME) {
                requiredTool = ASK_USER_TOOL_NAME;
            }
        },
    };
}
function isLegacyBrowserFeatureEnable(input) {
    if (input.toolCall.name !== 'request_feature_enable')
        return false;
    const source = input.toolCall.source;
    if (source !== undefined && source !== 'builtin')
        return false;
    return isRecord(input.args) && input.args.featureKey === 'browser-use';
}
function isTrustedBrowserToolCall(toolCall) {
    const name = toolCall.name;
    if (name !== 'browser' && !name.startsWith('browser_'))
        return false;
    // Runtime-native tools historically had no source marker. When a marker is
    // present, reject configured/MCP tools that merely imitate a Browser name.
    const source = toolCall.source;
    return source === undefined || source === 'builtin';
}
function readRequiredNextTool(details) {
    if (!isRecord(details))
        return undefined;
    const result = details.result;
    if (!isRecord(result))
        return undefined;
    const safety = result.safety;
    if (!isRecord(safety))
        return undefined;
    return typeof safety.requiredNextTool === 'string' ? safety.requiredNextTool : undefined;
}
function readSkillName(value) {
    if (!isRecord(value))
        return undefined;
    const name = Reflect.get(value, 'name');
    return typeof name === 'string' ? name : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=policy.js.map