import { PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE, PLUGIN_HOOK_CODEX_TOOL_RESPONSE, readPluginHookCompatibleToolResponse, readPluginHookCodexToolResponse, withPluginHookCompatibleToolResponse, withPluginHookCompatibleToolResponseDetails, withPluginHookCodexToolResponse, withPluginHookCodexToolResponseDetails, } from '../plugin-hooks/vendor-tool-response.js';
/**
 * Private, non-serializable channel carrying the exact Compatible Code
 * `PostToolUse.tool_response` emitted by a Cloud tool implementation.
 *
 * Cloud's generic Pi ToolResult deliberately normalizes vendor-specific
 * results. Reconstructing Compatible's response later from visible text would be
 * lossy (and different tools use different response schemas), so only tools
 * that still own the exact response may attach one here. Unsupported tools
 * remain unmarked and their Compatible PostToolUse handlers are skipped by the
 * shared runner with a bounded diagnostic; Codex/MiniMax hooks still receive
 * the native ToolResult.
 */
export const CLOUD_COMPATIBLE_TOOL_RESPONSE = PLUGIN_HOOK_COMPATIBLE_TOOL_RESPONSE;
export const CLOUD_CODEX_TOOL_RESPONSE = PLUGIN_HOOK_CODEX_TOOL_RESPONSE;
/**
 * Classify the native result for Hook protocols. Cloud Bash reports command
 * failures as ordinary ToolResults, so Pi's transport-level `isError` alone
 * is insufficient for Compatible's PostToolUse success boundary.
 */
export function isCloudPluginHookToolFailure(toolName, result, isError) {
    if (isError)
        return true;
    if (!result.details || typeof result.details !== 'object')
        return false;
    const details = result.details;
    if (details.ok === false || details.is_error === true)
        return true;
    if (toolName !== 'bash')
        return false;
    const exitCode = details.exit_code;
    return details.timed_out === true || (typeof exitCode === 'number' && exitCode !== 0);
}
export function withCloudCompatibleToolResponse(result, response) {
    return withPluginHookCompatibleToolResponse(result, response);
}
export function withCloudCompatibleToolResponseDetails(details, response) {
    return withPluginHookCompatibleToolResponseDetails(details, response);
}
export function readCloudCompatibleToolResponse(result) {
    return readPluginHookCompatibleToolResponse(result);
}
/** Attach a source-native Codex response when the tool still owns it (MCP). */
export function withCloudCodexToolResponse(result, response) {
    return withPluginHookCodexToolResponse(result, response);
}
export function withCloudCodexToolResponseDetails(details, response) {
    return withPluginHookCodexToolResponseDetails(details, response);
}
/**
 * Return the exact Codex PostToolUse response. MCP tools attach their original
 * CallToolResult. Other Cloud tools use the same text-only FunctionCallOutput
 * body produced by pi's OpenAI Responses converter. Image-bearing results are
 * intentionally unsupported because the converter depends on model modality.
 */
export function readCloudCodexToolResponse(result) {
    const explicit = readExplicitCloudCodexToolResponse(result);
    if (explicit !== undefined)
        return explicit;
    const textParts = [];
    for (const part of result.content) {
        if (part.type !== 'text')
            return undefined;
        textParts.push(part.text);
    }
    return textParts.join('\n');
}
export function readExplicitCloudCodexToolResponse(result) {
    return readPluginHookCodexToolResponse(result);
}
//# sourceMappingURL=cloud-plugin-hook-response.js.map