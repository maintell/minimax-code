import { projectRequestMedia, } from './request-media-projection.js';
/** The main-request prefix for a Host-selected `shared_prefix` request; otherwise none. */
export function resolveCheckpointSharedPrefix(input) {
    if (input.checkpointRequestShape !== 'shared_prefix' || input.systemPrompt === undefined) {
        return undefined;
    }
    const media = {
        model: input.model,
        ...(input.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
    };
    return {
        sessionId: input.sessionId,
        systemPrompt: input.systemPrompt,
        tools: input.tools ?? [],
        projectRequestMedia: (messages) => projectRequestMedia({ ...media, messages }).messages,
    };
}
/**
 * The main request's system prompt, tools, and projected history, followed by
 * the one control message that carries the checkpoint protocol.
 */
export function buildSharedPrefixCheckpointContext(prefix, projected, control) {
    return {
        systemPrompt: prefix.systemPrompt,
        messages: [...projected, control],
        tools: [...prefix.tools],
    };
}
/**
 * A shared-prefix response that called a tool says nothing about whether the
 * candidate fits; the same candidate is re-sent in the isolated shape.
 */
export function sharedPrefixToolCallFallback(generation) {
    return generation.responseContentKinds.includes('toolCall') || generation.stopReason === 'toolUse'
        ? 'tool_call'
        : undefined;
}
//# sourceMappingURL=checkpoint-shared-prefix.js.map