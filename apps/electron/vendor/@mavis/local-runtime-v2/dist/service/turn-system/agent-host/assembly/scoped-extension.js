/**
 * Mounts an extension for the Turns `appliesTo` accepts. The judgement runs
 * once per contribution from the assembly context, so it must not read
 * anything. Every other Turn never reaches the extension: its tools, prompt
 * contributions, reminders and hooks are left out as if it were not loaded,
 * and the reminders of the other extensions keep their content and order.
 */
export function scopeAgentExtension(extension, appliesTo) {
    return {
        id: extension.id,
        ...(extension.description !== undefined ? { description: extension.description } : {}),
        init: (pi) => extension.init(scopedApi(pi, appliesTo)),
    };
}
function scopedApi(pi, appliesTo) {
    const on = (event, handler) => {
        switch (event) {
            case 'before_tool_call':
                return pi.on(event, scopeToolHook(handler, appliesTo));
            case 'after_tool_call':
                return pi.on(event, scopeToolHook(handler, appliesTo));
            case 'turn_start':
                return pi.on(event, scopeHook(handler, appliesTo));
            case 'turn_end':
                return pi.on(event, scopeHook(handler, appliesTo));
            case 'on_history_changed':
                return pi.on(event, scopeHook(handler, appliesTo));
            case 'before_llm_call':
                return pi.on(event, scopeHook(handler, appliesTo));
            case 'on_llm_call_prepared':
                return pi.on(event, scopeHook(handler, appliesTo));
            case 'after_llm_call':
                return pi.on(event, scopeHook(handler, appliesTo));
            case 'on_step_end':
                return pi.on(event, scopeHook(handler, appliesTo));
        }
    };
    return {
        params: pi.params,
        registerTool: (contribution) => pi.registerTool(scopedTool(contribution, appliesTo)),
        contributeSystemPrompt: (contribute) => pi.contributeSystemPrompt((ctx) => (appliesTo(ctx) ? contribute(ctx) : undefined)),
        contributeUserPromptPrefix: (contribute) => pi.contributeUserPromptPrefix((ctx) => (appliesTo(ctx) ? contribute(ctx) : undefined)),
        registerReminderProvider: (provider) => pi.registerReminderProvider({
            name: provider.name,
            compute: (ctx) => (appliesTo(ctx) ? provider.compute(ctx) : null),
        }),
        on,
    };
}
function scopedTool(contribution, appliesTo) {
    return (ctx) => {
        if (!appliesTo(ctx))
            return null;
        return typeof contribution === 'function' ? contribution(ctx) : contribution;
    };
}
function scopeHook(handler, appliesTo) {
    return (event, ctx) => (appliesTo(ctx) ? handler(event, ctx) : undefined);
}
function scopeToolHook(handler, appliesTo) {
    return (input, signal, ctx) => (appliesTo(ctx) ? handler(input, signal, ctx) : undefined);
}
//# sourceMappingURL=scoped-extension.js.map