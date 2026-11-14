import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { BUNNY_AGENT_NAME } from '../contracts.js';
const CONVERSATION_SEARCH_TOOL_NAME = 'conversation_search';
const CONVERSATION_READ_TOOL_NAME = 'conversation_read';
const SEARCH_DESCRIPTION = '检索 Bunny 主对话更早的原话：你和用户的可见文字、问卷回答、任务回传的目标与卡片结论、附件文件名与描述。什么时候查，见系统提示的 <continuity>。query 写 2–3 个有区分度的词：文件名、数字或版本号、人名、仓库名、空间名、报错原文，不要用泛词，词越少命中越稳；用对话里实际出现过的说法，不要换成自己的概括；“检索线索”里的关键词挑最有区分度的两三个，不要整条写进来；同一件事可能有另一种说法时，用 OR 把两种都写上。空格分隔的词默认都要出现，写 OR 表示任一出现，引号内算一个词。“上周”“上个月”先换算成 since/until（YYYY-MM-DD）。返回命中总数、按月分布和前 8 条片段，next_cursor 翻页；排序和总结类的问题从对话早期查起再往后翻，核对是否被推翻时正反两面都查。`relaxed: true` 是返回字段，表示没有同时含全部词的消息、结果只含其中部分词，不要作为入参传。';
const READ_DESCRIPTION = '按 message_id（来自 conversation_search 或差量块的“可能相关的早前对话”）读取主对话原文，连同前后各最多 3 条消息；放不下的邻近消息只给省略条数。带附件的消息列出资产 ID、文件名和描述，要看原件按资产 ID 读取。消息太长时只返回一段并给出 next_offset，用 offset 接着读到读完。';
const searchSchema = Type.Object({
    query: Type.String({ minLength: 1, maxLength: 200 }),
    since: Type.Optional(Type.String({ description: '起始时间，YYYY-MM-DD 或 ISO 时间' })),
    until: Type.Optional(Type.String({ description: '截止时间（含），YYYY-MM-DD 或 ISO 时间' })),
    space: Type.Optional(Type.String({ description: '任务空间 ID' })),
    task: Type.Optional(Type.String({ description: '任务会话 ID' })),
    role: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('report')], {
        description: 'user 用户；assistant 你自己；report 任务回传',
    })),
    cursor: Type.Optional(Type.String()),
}, { additionalProperties: false });
const readSchema = Type.Object({
    message_id: Type.String({ minLength: 1 }),
    around: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
/** Bound per turn, only in Bunny's current main conversation; forks get neither tool. */
export function createConversationSearchTools(search, identity, 
/**
 * One search or read finished, called directly or from `run_code`: its tool, how long it
 * took (spec 18.1's latency budget) and the Turn it ran in.
 */
finished) {
    if (identity.agentName !== BUNNY_AGENT_NAME || !search.isMainSession(identity.sessionId))
        return [];
    const requireIdentity = (context) => {
        if (context.sessionId !== identity.sessionId || context.turnId !== identity.turnId)
            throw new Error('Wrong Bunny conversation search execution context');
        return identity.sessionId;
    };
    const measured = (tool, run) => {
        const startedAt = performance.now();
        try {
            return run();
        }
        finally {
            finished?.(tool, performance.now() - startedAt, identity);
        }
    };
    return [
        defineRuntimeTool({
            name: CONVERSATION_SEARCH_TOOL_NAME,
            source: 'builtin',
            description: SEARCH_DESCRIPTION,
            schema: searchSchema,
            async execute(context, args, signal) {
                signal?.throwIfAborted();
                const sessionId = requireIdentity(context);
                const result = measured(CONVERSATION_SEARCH_TOOL_NAME, () => search.search(sessionId, {
                    query: args.query,
                    ...(args.since ? { since: args.since } : {}),
                    ...(args.until ? { until: args.until } : {}),
                    ...(args.space ? { spaceId: args.space } : {}),
                    ...(args.task ? { taskId: args.task } : {}),
                    ...(args.role ? { role: args.role } : {}),
                    ...(args.cursor ? { cursor: args.cursor } : {}),
                }));
                return textResult(CONVERSATION_SEARCH_TOOL_NAME, result);
            },
        }),
        defineRuntimeTool({
            name: CONVERSATION_READ_TOOL_NAME,
            source: 'builtin',
            description: READ_DESCRIPTION,
            schema: readSchema,
            async execute(context, args, signal) {
                signal?.throwIfAborted();
                const sessionId = requireIdentity(context);
                const result = measured(CONVERSATION_READ_TOOL_NAME, () => search.read(sessionId, {
                    messageId: args.message_id,
                    ...(args.around !== undefined ? { around: args.around } : {}),
                    ...(args.offset !== undefined ? { offset: args.offset } : {}),
                }));
                return textResult(CONVERSATION_READ_TOOL_NAME, result);
            },
        }),
    ];
}
function textResult(toolName, value) {
    const text = JSON.stringify(value);
    return { tool_name: toolName, text, content: [{ type: 'text', text }] };
}
//# sourceMappingURL=tools.js.map