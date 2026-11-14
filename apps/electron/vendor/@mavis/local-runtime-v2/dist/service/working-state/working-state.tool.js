import { defineRuntimeTool } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { WORKING_STATE_TOOL_NAME } from './contracts.js';
/** @internal Exported only for focused tests. */
export const WORKING_STATE_TOOL_DESCRIPTION = [
    '读写工作状态账本（近期约定）。什么时候写、什么不进账本，见系统提示的 <memory> 和 <ask_user>。',
    'action：add 新增，必填 kind、text；kind 取 correction（纠正）、constraint（约束）、open_question（待答问题）、context_gap（已说定、还没写进空间 context.md 的决定）；scope 默认 global，只有 context_gap 用 space:<空间 ID>；expires_at 可选，ISO 8601 时间，到期自动关闭。用户纠正时，text 写新做法，replaces 写被否定的做法。text 用用户原话的语言写，名字、编号、数字和带名字的说法照原文写，不要翻译（“Atlas board”不写成“Atlas 看板”）。',
    'update 改写一条现行条目，必填 entry_id、text：text 写完整的现行规则，例外也写进去（如“周报一律不抄送客户，只有季度总结可以抄送”）；旧条目变为已替代，返回新条目。close 关闭一条现行条目，必填 entry_id、reason（answered 已回答、done 已完成、withdrawn 撤回）；answered、withdrawn 还必填 note：answered 写用户的回答，withdrawn 写这条为什么不再适用。关闭的条目连同 note 在账本里再列 7 天。update 和 close 的 text、note 保留原条目里的名字和编号，之后按名字问起才对得上。',
    'context_gap 用 `space context write` 写进空间 context.md 的“已定事项”后，当轮用 close（done）关闭这条条目。',
    'list 只读，可按 kind、scope、status（active、superseded、done）过滤，返回条目和账本版本；注入因篇幅截掉的条目用它读全。',
].join('\n');
function entryView(entry) {
    return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        text: entry.text,
        ...(entry.replaces ? { replaces: entry.replaces } : {}),
        ...(entry.expiresAtMs === undefined
            ? {}
            : { expires_at: new Date(entry.expiresAtMs).toISOString() }),
        ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
        status: entry.status,
        ...(entry.closeReason ? { close_reason: entry.closeReason } : {}),
        ...(entry.closeNote ? { close_note: entry.closeNote } : {}),
        author: entry.author,
        ...(entry.inferred ? { inferred: true } : {}),
        ...(entry.source ? { source_message_id: entry.source.messageId } : {}),
    };
}
function expiresAt(value) {
    if (value === undefined || value === '')
        return undefined;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms))
        throw new Error('expires_at must be an ISO 8601 time');
    return ms;
}
function required(value, message) {
    if (value === undefined || value === '')
        throw new Error(message);
    return value;
}
const ACTIONS = {
    list: (service, args) => ({
        revision: service.revision(),
        entries: service
            .list({ kind: args.kind, scope: args.scope, status: args.status })
            .map(entryView),
    }),
    add: (service, args, source) => entryView(service.add({
        kind: required(args.kind, 'add requires kind and text'),
        text: required(args.text, 'add requires kind and text'),
        scope: args.scope,
        replaces: args.replaces,
        expiresAtMs: expiresAt(args.expires_at),
        source,
    }, 'front')),
    update: (service, args, source) => entryView(service.update({
        id: required(args.entry_id, 'update requires entry_id and text'),
        text: required(args.text, 'update requires entry_id and text'),
        ...(args.replaces === undefined ? {} : { replaces: args.replaces }),
        ...(args.expires_at === undefined
            ? {}
            : { expiresAtMs: expiresAt(args.expires_at) ?? null }),
        source,
    }, 'front')),
    close: (service, args) => {
        const reason = required(args.reason, 'close requires entry_id and reason');
        // The answer, or why a rule no longer applies, is lost unless it is written down here.
        const note = reason === 'done'
            ? args.note
            : required(args.note?.trim(), 'close with answered or withdrawn requires note: the answer, or why it no longer applies');
        return entryView(service.close(required(args.entry_id, 'close requires entry_id and reason'), reason, 'front', note));
    },
};
/** Bunny's front tool over the ledger; bound only to Bunny's main conversation. */
export function createWorkingStateTool(service, source, identity) {
    return defineRuntimeTool({
        name: WORKING_STATE_TOOL_NAME,
        source: 'builtin',
        description: WORKING_STATE_TOOL_DESCRIPTION,
        schema: Type.Object({
            action: Type.Union([
                Type.Literal('add'),
                Type.Literal('update'),
                Type.Literal('close'),
                Type.Literal('list'),
            ]),
            entry_id: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            kind: Type.Optional(Type.Union(['correction', 'constraint', 'open_question', 'context_gap'].map((kind) => Type.Literal(kind)))),
            text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
            replaces: Type.Optional(Type.String({ maxLength: 4000 })),
            scope: Type.Optional(Type.String({ maxLength: 200 })),
            expires_at: Type.Optional(Type.String({ maxLength: 64 })),
            reason: Type.Optional(Type.Union([Type.Literal('answered'), Type.Literal('done'), Type.Literal('withdrawn')])),
            note: Type.Optional(Type.String({ maxLength: 4000 })),
            status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('superseded'), Type.Literal('done')])),
        }, { additionalProperties: false }),
        async execute(context, rawArgs, signal) {
            signal?.throwIfAborted();
            if (context.sessionId !== identity.sessionId || context.turnId !== identity.turnId)
                throw new Error('Wrong Bunny working_state execution context');
            source.requireMain(context.sessionId);
            const message = source.latestUser(context.sessionId);
            const origin = message
                ? { sessionId: context.sessionId, messageId: message.messageId, atMs: message.atMs }
                : undefined;
            const args = rawArgs;
            const result = ACTIONS[args.action](service, args, origin);
            const text = JSON.stringify(result);
            return { tool_name: WORKING_STATE_TOOL_NAME, text, content: [{ type: 'text', text }] };
        },
    });
}
//# sourceMappingURL=working-state.tool.js.map