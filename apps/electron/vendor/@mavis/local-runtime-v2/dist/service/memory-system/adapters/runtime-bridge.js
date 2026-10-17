/**
 * Memory V2 与 Agent 运行时之间的桥接。
 *
 * 设计契约（§5.14、§5.10）定义的是记忆内部的 port：`MemoryAgentContribution` 只知道
 * developer block 与工具，`MemoryTurnObserver` 只知道 Turn 的启动事实。运行时
 * 消费的却是自己的 `AgentExtension`。这一层做双向翻译，使两侧都不必知道对方的形状。
 */
import { defineRuntimeTool, } from '@mavis/agent-runtime';
import { Type } from '@sinclair/typebox';
import { MemoryAgentContributionAdapter } from './agent-contribution.js';
/**
 * 同一 Turn 内重复装配上下文时复用同一次 prepare，避免重复读取与重复注入。
 *
 * 唤醒（§5.10）与引用记账（§5.7）也在这里接线：
 * - `turn_start` 是运行时装配一个真实 Turn 的事实：steer 汇入在途 Turn 不触发，
 *   恢复重放由 turnId 去重挡住；Host 提供普通用户输入事实，自动续跑不触发唤醒。
 * - `after_llm_call` 在完成消息交付前解析并剥离 `<memory-used/>` 标记：下游（UI 与
 *   历史）只见净文本，来源会话交给 recordTurnUsage 记账。
 */
export function createMemoryAgentExtension(contribution, observer, nowMs = () => Date.now()) {
    const turns = new Map();
    const prepare = (context) => {
        const key = turnKey(context.sessionId, context.turnId);
        const existing = turns.get(key);
        if (existing)
            return existing;
        const created = contribution.prepare(context.sessionId);
        turns.set(key, created);
        return created;
    };
    return {
        id: 'memory-v2',
        description: 'Turn-scoped Memory V2 summary injection and layered read tools.',
        init(api) {
            api.contributeSystemPrompt(async (context) => (await prepare(context)).developerBlocks.join('\n\n'));
            api.registerTool(async (context) => (await prepare(context)).tools.map(toRuntimeTool));
            api.on('turn_start', async (event) => {
                // best-effort：记忆链路的失败不得影响 Turn 执行（§5.10）。
                try {
                    await observer?.observeTurnStart({
                        sessionId: event.sessionId,
                        turnId: event.turnId,
                        isOrdinaryInputTurn: event.isOrdinaryInputTurn === true,
                        startedAtMs: nowMs(),
                    });
                }
                catch {
                    // 忽略：唤醒丢失由下一轮 Turn 补上。
                }
            });
            api.on('after_llm_call', async (input) => {
                try {
                    const text = assistantText(input.message);
                    if (!text.includes('<memory-used'))
                        return undefined;
                    const { cleanText, sourceSessionIds } = MemoryAgentContributionAdapter.extractUsageMarker(text);
                    if (sourceSessionIds.length > 0) {
                        await contribution.recordTurnUsage({
                            sessionId: input.sessionId,
                            sourceSessionIds,
                            completedAtMs: nowMs(),
                        });
                    }
                    // 无论记账是否有内容，标记都不进入交付文本（§5.7 引用协议）。
                    return { type: 'replaceText', text: cleanText };
                }
                catch {
                    return undefined;
                }
            });
            api.on('turn_end', (event) => {
                // 只释放本 Turn 的缓存；§5.7 的读取不持有快照，无需额外 release。
                turns.delete(turnKey(event.sessionId, event.turnId));
            });
        },
    };
}
/** 拼接回答里的可见文本块；thinking 与 toolCall 不参与引用协议。 */
function assistantText(message) {
    return message.content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}
/**
 * Session 删除钩子。
 *
 * `onSessionDeleted` 只收 `requestSessionId` 并自行解析作用域，因此必须在会话行仍然
 * 存在时调用；解析完再执行真正的删除。记忆侧失败不阻断会话删除——用户的删除意图优先，
 * 残留状态由 Reconciler 收敛。
 */
export function createMemorySessionDeletionHook(governance) {
    return {
        async deleteSession(input) {
            try {
                await governance.onSessionDeleted({ requestSessionId: input.sessionId });
            }
            catch {
                // 忽略：记忆状态清理失败不应阻止用户删除会话。
            }
            await input.deleteOwnedSession();
            return undefined;
        },
    };
}
function toRuntimeTool(tool) {
    const schema = TOOL_SCHEMAS[tool.name];
    return defineRuntimeTool({
        name: tool.name,
        description: tool.description,
        schema,
        source: 'builtin',
        execute: async (context, input) => toToolResult(tool.name, await tool.execute({ ...input, tool: tool.name }, {
            requestSessionId: context.sessionId,
            toolCallId: context.toolCallId ?? '',
        })),
    });
}
/** 工具名固定枚举，schema 静态绑定，不开放动态注册（§5.14、§5.18）。 */
const TOOL_SCHEMAS = {
    memories_search: Type.Object({ query: Type.String(), path: Type.Optional(Type.String()) }, { additionalProperties: false }),
    memories_read: Type.Object({ path: Type.String(), line_offset: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
    memories_add_ad_hoc_note: Type.Object({ note: Type.String() }, { additionalProperties: false }),
};
function toToolResult(name, output) {
    const text = output.status === 'ok'
        ? JSON.stringify(output.result)
        : JSON.stringify({ code: output.code, message: output.message });
    return {
        tool_name: name,
        text,
        content: [{ type: 'text', text }],
        details: { ...output },
        ...(output.status === 'failed' ? { isError: true } : {}),
    };
}
function turnKey(sessionId, turnId) {
    return `${sessionId}\0${turnId}`;
}
//# sourceMappingURL=runtime-bridge.js.map