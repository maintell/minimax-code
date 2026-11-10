import { getContentRulesForTool } from './context.js';
import { extractFilePath, isFsTool, toolActionForFsTool } from './tools/fs-input.js';
import { FS_UMBRELLA_TOOL_NAME, matchPathRule, ruleSupportsPathAction, validatePath, } from './tools/fs-permission.js';
/** Shared by both policy owners; this matches rules, not the host's ASK/mode gate. */
export function matchesContentAskRule(toolName, input, context) {
    const inputContent = extractToolInputContent(toolName, input);
    if (!inputContent)
        return undefined;
    if (isFsTool(toolName)) {
        const action = toolActionForFsTool(toolName);
        const rules = context.rules.filter((rule) => {
            const { toolName: ruleTool, ruleContent } = rule.ruleValue;
            if (!ruleContent)
                return false;
            return (rule.ruleBehavior === 'ask' &&
                (ruleTool === toolName || ruleTool === FS_UMBRELLA_TOOL_NAME) &&
                ruleSupportsPathAction(rule, action));
        });
        if (rules.length === 0)
            return undefined;
        const path = validatePath(inputContent, context.workingDirectory, context.homeDir);
        if (!path.valid)
            return undefined;
        return rules.find((rule) => {
            const ruleContent = rule.ruleValue.ruleContent;
            return Boolean(ruleContent && matchPathRule(path.resolved, ruleContent));
        });
    }
    // Preserve existing command/URL matching; FS paths must not use substring matching.
    return getContentRulesForTool(context, toolName, 'ask').find((rule) => {
        const ruleContent = rule.ruleValue.ruleContent;
        return Boolean(ruleContent && inputContent.includes(ruleContent));
    });
}
export function extractToolInputContent(toolName, input) {
    if (isFsTool(toolName))
        return extractFilePath(toolName, input);
    if (typeof input.command === 'string')
        return input.command;
    return toolName !== 'bash' && typeof input.url === 'string' ? input.url : undefined;
}
//# sourceMappingURL=content-ask-rule.js.map