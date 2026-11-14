import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { BUNNY_AGENT_NAME } from '../contracts.js';
export function createBunnyRememberTool(service, identity, 
/** A write finished: its action, and whether it wrote, found a duplicate or failed. */
written) {
    return defineRuntimeTool({
        name: 'remember',
        source: 'builtin',
        description: '写入或修改 Bunny 的主记忆，下一轮起生效。action：add 新增；update 改写；forget 删除，后台不再记回来。update/forget 必填 entry_id；add 必填 type；add/update 必填 content 和 basis。example 是真实场景，quote 是用户原话片段。出处由系统记录。返回条目 ID 和内容；同类条目存在时请改用 update。',
        schema: Type.Object({
            action: Type.Union([Type.Literal('add'), Type.Literal('update'), Type.Literal('forget')]),
            entry_id: Type.Optional(Type.String({ pattern: '^m-[0-9]+$' })),
            type: Type.Optional(Type.Union(['画像', '倾向', '做法', '去处'].map((type) => Type.Literal(type)))),
            content: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
            example: Type.Optional(Type.String({ maxLength: 2000 })),
            basis: Type.Optional(Type.Union([Type.Literal('用户原话'), Type.Literal('用户确认')])),
            quote: Type.Optional(Type.String({ maxLength: 2000 })),
        }, { additionalProperties: false }),
        async execute(context, args, signal) {
            signal?.throwIfAborted();
            if (identity.agentName !== BUNNY_AGENT_NAME ||
                context.sessionId !== identity.sessionId ||
                context.turnId !== identity.turnId)
                throw new Error('Wrong Bunny remember execution context');
            service.source.requireMain(context.sessionId);
            const message = service.source.latestUser(context.sessionId);
            if (!message)
                throw new Error('remember requires a user message');
            const input = args;
            let result;
            try {
                result = await service.store.remember(input, `${context.sessionId}/${message.messageId}`);
            }
            catch (error) {
                written?.({ op: input.action, outcome: 'failed' });
                throw error;
            }
            written?.({ op: input.action, outcome: result.duplicate ? 'duplicate' : 'ok' });
            const text = JSON.stringify(result);
            return { tool_name: 'remember', text, content: [{ type: 'text', text }] };
        },
    });
}
//# sourceMappingURL=remember.tool.js.map