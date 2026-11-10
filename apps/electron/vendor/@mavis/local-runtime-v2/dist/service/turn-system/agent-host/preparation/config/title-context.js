export function mutableTitleContext(context) {
    return {
        systemPrompt: context.systemPrompt,
        messages: context.messages.map((message) => ({ ...message })),
        ...(context.tools ? { tools: [...context.tools] } : {}),
    };
}
//# sourceMappingURL=title-context.js.map