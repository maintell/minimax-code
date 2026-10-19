/**
 * Extension factory helpers —— 让 host 用一句话把普通对象装成 `AgentExtension`
 * 而不用每次都写 `{ id, description, init(pi) { pi.registerXxx(...) } }` boilerplate。
 *
 * 设计文档 §4.3 表列出了 8 个 extension（`permission / context-manager / memory /
 * system-reminder / mcp-disclosure / desktop-tools / skills / internal-tool-handlers`）；其中
 * `context-manager / system-reminder / permission / skills` 的 module-to-SPI
 * adapters 集中由 `@mavis/agent-extension` 导出。`mcp-disclosure / desktop-tools /
 * internal-tool-handlers / memory / output-review-preface` 等 host-only
 * behavior 的薄封装——host 自己已有 `hookService.beforeToolCall` /
 * `mcpDisclosureOptions` 等 helper，只需要用本文件里的通用 factory 把它们装成 SPI
 * extension 即可，无需给每个 host-only module 都造一个 module 级 factory。
 *
 * 使用示例（local-runtime host 装配）：
 *
 *   const userHooksExtension = createHookExtension({
 *     id: 'internal-tool-handlers',
 *     description: 'Product-internal tool handlers (before/after tool)',
 *     handlers: {
 *       before_tool_call: (toolContext) => hookService.beforeToolCall({ toolContext }),
 *       after_tool_call: (toolContext) => hookService.afterToolCall({ toolContext }),
 *     },
 *   });
 *
 *   const mcpDisclosureExtension = createToolExtension({
 *     id: 'mcp-disclosure',
 *     description: 'Per-turn dynamic MCP tool exposure via progressive disclosure',
 *     tools: [(ctx) => resolveMcpDisclosureTool(ctx, mcpDisclosureOptions)],
 *   });
 *
 * Factories 都是 pure：闭包 host state 时的 lifecycle 由 host 管。
 */
import { HOOK_NAMES } from './types.js';
export function createToolExtension(options) {
    const { id, description, tools, onInit } = options;
    return {
        id,
        description,
        async init(pi) {
            if (onInit)
                await onInit(pi);
            for (const tool of tools) {
                pi.registerTool(tool);
            }
        },
    };
}
/**
 * Wire every non-empty handler bucket onto `pi.on(event, handler)`. Iterates
 * `HOOK_NAMES` so adding a new SPI event only requires extending that array
 * plus `HookHandlerMap` in `types.ts`—no per-factory shotgun edit. Uses the
 * generic `ExtensionAPI.on<K>` overload so the per-event handler type stays
 * type-safe at every call site.
 */
function wireHandlers(pi, handlers) {
    for (const name of HOOK_NAMES) {
        const bucket = handlers[name];
        if (bucket === undefined)
            continue;
        const list = Array.isArray(bucket) ? bucket : [bucket];
        for (const h of list)
            pi.on(name, h);
    }
}
export function createHookExtension(options) {
    const { id, description, handlers } = options;
    return {
        id,
        description,
        init(pi) {
            if (handlers)
                wireHandlers(pi, handlers);
        },
    };
}
function toContributor(v) {
    if (v === undefined)
        return undefined;
    return typeof v === 'string' ? () => v : v;
}
export function createPromptExtension(options) {
    const { id, description, systemPrompt, userPromptPrefix } = options;
    const systemFn = toContributor(systemPrompt);
    const userFn = toContributor(userPromptPrefix);
    return {
        id,
        description,
        init(pi) {
            if (systemFn)
                pi.contributeSystemPrompt(systemFn);
            if (userFn)
                pi.contributeUserPromptPrefix(userFn);
        },
    };
}
export function createReminderExtension(options) {
    const { id, description, providers } = options;
    return {
        id,
        description,
        init(pi) {
            for (const provider of providers) {
                pi.registerReminderProvider(provider);
            }
        },
    };
}
export function createExtension(options) {
    const { id, description, tools = [], systemPrompt, userPromptPrefix, reminderProviders = [], handlers, onInit, } = options;
    const systemFn = toContributor(systemPrompt);
    const userFn = toContributor(userPromptPrefix);
    return {
        id,
        description,
        async init(pi) {
            if (onInit)
                await onInit(pi);
            for (const tool of tools)
                pi.registerTool(tool);
            if (systemFn)
                pi.contributeSystemPrompt(systemFn);
            if (userFn)
                pi.contributeUserPromptPrefix(userFn);
            for (const provider of reminderProviders)
                pi.registerReminderProvider(provider);
            if (handlers)
                wireHandlers(pi, handlers);
        },
    };
}
//# sourceMappingURL=factories.js.map