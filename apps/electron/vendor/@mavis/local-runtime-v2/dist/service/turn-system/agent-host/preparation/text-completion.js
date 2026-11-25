import { streamSimple } from '@earendil-works/pi-ai';
import { withLLMRetry, } from '@mavis/agent-core/pi-turn-runner';
export function mutableTitleContext(context) {
    return {
        systemPrompt: context.systemPrompt,
        messages: context.messages.map((message) => ({ ...message })),
        ...(context.tools ? { tools: [...context.tools] } : {}),
    };
}
/** Auxiliary requests must open and settle the selected model's owned call. */
export function textCompletionStream(resolved, input) {
    const stream = resolved.streamFn ?? streamSimple;
    return resolved.callLifecycle
        ? withLLMRetry(stream, { ...input, lifecycle: resolved.callLifecycle })
        : stream;
}
//# sourceMappingURL=text-completion.js.map