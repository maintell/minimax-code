import { composePluginHookToolResultContent } from '@mavis/plugin-hooks';
/** Internal marker: eval/audit must retain the result returned by the real tool. */
export const CLOUD_PLUGIN_HOOK_RESULT_PATCH = Symbol('cloudPluginHookResultPatch');
// MiniMax/Compatible safety cap. Codex upstream has no equivalent cap, but Cloud
// must guarantee that a broken Stop Hook cannot keep one turn alive forever.
export const CLOUD_PLUGIN_STOP_CONTINUATION_LIMIT = 8;
/**
 * Converts a shared Plugin Hook decision into Pi's model-visible result patch.
 * Structured `{ content, isError }` replacements remain structured instead of
 * being flattened into JSON text. Codex feedback is appended as an error result
 * for the next model step, replaces the original model-visible result like
 * Codex does, and deliberately never becomes `terminateAgent`.
 */
export function buildCloudPluginHookAfterToolResult(input) {
    const structured = readStructuredResult(input.decision.updatedResult);
    const content = structured
        ? appendModelContext(structured.content ?? input.originalContent, input.additionalContext)
        : composePluginHookToolResultContent(input.originalContent ?? [], input.decision.updatedResult, input.additionalContext, {
            sourceFormat: input.decision.updatedResultFormat,
            toolName: input.toolName,
        });
    const postToolFeedback = input.decision.postToolFeedback?.trim();
    const contentWithFeedback = postToolFeedback
        ? [
            {
                type: 'text',
                text: `<plugin-hook-feedback>\n${postToolFeedback}\n</plugin-hook-feedback>`,
            },
        ]
        : content;
    const isError = postToolFeedback ? true : structured?.isError;
    const terminateAgent = input.decision.continue === false ? true : undefined;
    if (contentWithFeedback === undefined && isError === undefined && terminateAgent === undefined) {
        return undefined;
    }
    return {
        [CLOUD_PLUGIN_HOOK_RESULT_PATCH]: true,
        ...(contentWithFeedback ? { content: contentWithFeedback } : {}),
        ...(isError !== undefined ? { isError } : {}),
        ...(terminateAgent ? { terminateAgent: true } : {}),
    };
}
function readStructuredResult(value) {
    if (!isRecord(value))
        return undefined;
    const content = isToolResultContent(value.content) ? value.content : undefined;
    const isError = typeof value.isError === 'boolean'
        ? value.isError
        : typeof value.is_error === 'boolean'
            ? value.is_error
            : undefined;
    return content !== undefined || isError !== undefined ? { content, isError } : undefined;
}
function appendModelContext(content, context) {
    const text = context?.trim();
    if (!content && !text)
        return undefined;
    return [
        ...(content ?? []),
        ...(text
            ? [{ type: 'text', text: `<plugin-hook-context>\n${text}\n</plugin-hook-context>` }]
            : []),
    ];
}
function isToolResultContent(value) {
    return (Array.isArray(value) &&
        value.every((item) => isRecord(item) &&
            ((item.type === 'text' && typeof item.text === 'string') ||
                (item.type === 'image' &&
                    typeof item.data === 'string' &&
                    typeof item.mimeType === 'string'))));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=cloud-plugin-hook-result.js.map