/**
 * mavis tool per-command zod schema —— LLM 调用时 dispatcher 拿命中 command
 * 对应的 schema 校验 args,失败时返 CLI 风格的错误对象。
 *
 * 这里只校验 LLM 看到的 args 形态;archon-server Req 的实际字段(`base_req` /
 * `harness_base_req` 等)由 commands/*.ts 内的 handler 装配。
 *
 * Enum 字段对 LLM 用字符串(`"Manual"` / `"Main"` / `"Folder"` 等),handler
 * 内通过 `archon-rpc-types` 里的常量映射到 IDL int 值再传给 adapter。
 *
 * 新增子命令需要:
 *   1. 本文件加 `xxxSchema = z.object({...})`
 *   2. 本文件 `COMMAND_SCHEMAS[<command-name>] = xxxSchema`
 *   3. commands/<group>.ts 加 handler
 *   4. dispatcher.ts 加 dispatch 行
 *   5. mavis-tool-def.ts description 列上该 subcommand 用法
 */
import { z } from 'zod';
import { isDefaultAgentAvatarMarker } from '@mavis/shared/agent-avatar';
import { CRON_FIXED_SESSION_ID, isCronDedicatedSessionTarget, isCronFixedSessionId, } from '../../shared/cron-schedule-input.js';
// ─── reusable ──────────────────────────────────────────────────────────
const idString = z.string().min(1, 'ID must be a non-empty string');
const optionalString = z.string().optional();
const optionalNumber = z.number().int().nonnegative().optional();
const optionalBoolean = z.boolean().optional();
const activeHoursSchema = z
    .object({
    start: z.string().regex(/^\d{2}:\d{2}$/, 'start must be HH:MM 24h'),
    end: z.string().regex(/^\d{2}:\d{2}$/, 'end must be HH:MM 24h'),
})
    .partial();
const cronSessionConfigSchema = z
    .object({
    mode: z.enum(['new', 'sessionId']),
    session_id: optionalString,
    keep_sessions: optionalNumber,
})
    .partial();
const pageParamSchema = z.object({
    cursor: optionalString,
    limit: optionalNumber,
});
// ─── agent ─────────────────────────────────────────────────────────────
export const agentListSchema = pageParamSchema;
export const agentGetSchema = z.object({ agent_name: z.string().min(1) });
// The server remains authoritative for legacy URL allowlisting. Reject emoji
// and invented asset IDs before RPC; the existing default library uses markers.
const agentAvatarSchema = z
    .string()
    .refine((value) => value === '' ||
    isDefaultAgentAvatarMarker(value) ||
    (/^https?:\/\//iu.test(value.trim()) && z.string().url().safeParse(value.trim()).success), 'Use mavis-agent-avatar://default/v1/<0-9> from the built-in avatar library, or an allowed legacy image URL. Omit avatar on create to select a default portrait; emoji are not supported.')
    .optional();
/**
 * `agent create` —— LLM 侧把 `agent_data` 拆成扁平字段(`system_prompt` /
 * `persona`),handler 内组装成 archon-biz `agent_data` JSON 信封再传给
 * archon-server。`template_id` / `creation_source` 不暴露给 LLM —— 前者非用户
 * 心智模型字段(由 LLM 自建场景没有模板),后者由 handler 固定写
 * `Manual`(LLM 调用 mavis 自然属于用户手动触发链路)。
 */
export const agentCreateSchema = z.object({
    name: z.string().min(1),
    system_prompt: optionalString,
    persona: optionalString,
    description: optionalString,
    avatar: agentAvatarSchema,
});
/**
 * `agent update` —— 与 `agent create` 同形:LLM 看到的是扁平
 * `system_prompt` / `persona`,handler 内拼成 archon-biz `agent_data_patch`
 * 信封字段。`new_name` 直接映射 archon-server `display_name` 字段。
 */
export const agentUpdateSchema = z.object({
    agent_name: z.string().min(1),
    new_name: optionalString,
    system_prompt: optionalString,
    persona: optionalString,
    description: optionalString,
    avatar: agentAvatarSchema,
});
export const agentDeleteSchema = z.object({ agent_name: z.string().min(1) });
// ─── cron ──────────────────────────────────────────────────────────────
export const cronListSchema = z.object({
    agent_name: optionalString,
    cursor: optionalString,
    limit: optionalNumber,
});
export const cronGetSchema = z.object({ task_id: idString });
const cronCreateObject = z.object({
    agent_name: z.string().min(1).optional(),
    cron_name: z.string().min(1),
    schedule: z.string().min(1),
    prompt: z.string().min(1),
    project: z.string().trim().min(1).optional(),
    model: z
        .string()
        .trim()
        .refine((value) => {
        const separator = value.indexOf('/');
        return separator > 0 && separator < value.length - 1;
    }, 'model must be provider/model_id')
        .optional(),
    timezone: optionalString,
    active_hours: activeHoursSchema.optional(),
    session: cronSessionConfigSchema.optional(),
    enabled: optionalBoolean,
});
function validateCronOwner(args, ctx) {
    if (args.session?.mode === 'sessionId' && !isCronDedicatedSessionTarget(args.session)) {
        if (!args.session.session_id?.trim())
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['session', 'session_id'],
                message: 'sessionId mode requires session_id',
            });
        if (args.agent_name !== undefined)
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['agent_name'],
                message: 'Omit agent_name in sessionId mode; the target session determines its owner',
            });
    }
    else if (!args.agent_name) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['agent_name'],
            message: 'new mode and a dedicated conversation both require agent_name',
        });
    }
}
export const cronCreateSchema = cronCreateObject.superRefine(validateCronOwner);
export const cronOnceSchema = cronCreateObject
    .omit({ schedule: true, active_hours: true, enabled: true })
    .extend({
    cron_name: optionalString,
    after: optionalString,
    at: z.union([z.string().min(1), z.number()]).optional(),
})
    .superRefine(validateCronOwner);
export const cronSelfSchema = z.object({
    cron_name: optionalString,
    every: z.string().min(1),
    prompt: z.string().min(1),
    session_id: optionalString,
    quiet_on_skip: optionalBoolean,
    timezone: optionalString,
    project: cronCreateObject.shape.project,
    model: cronCreateObject.shape.model,
});
export const cronUpdateSchema = z
    .object({
    task_id: idString,
    schedule: optionalString,
    prompt: optionalString,
    timezone: optionalString,
    active_hours: activeHoursSchema.optional(),
    session: cronSessionConfigSchema.optional(),
    enabled: optionalBoolean,
})
    .superRefine((args, ctx) => {
    // `fixed` only means "create a dedicated conversation". Re-pointing an
    // existing task never creates one, so it stays a creation-only value.
    if (args.session?.mode === 'sessionId' && isCronFixedSessionId(args.session.session_id)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['session', 'session_id'],
            message: `${CRON_FIXED_SESSION_ID} is only accepted when creating a task; updating re-points the target to a real session ID`,
        });
    }
});
export const cronDeleteSchema = z.object({ task_id: idString });
export const cronTriggerSchema = z.object({ task_id: idString });
export const cronSessionsSchema = z.object({
    task_id: idString,
    cursor: optionalString,
    limit: optionalNumber,
});
// ─── session ───────────────────────────────────────────────────────────
export const sessionListSchema = z.union([
    z.object({
        mode: z.literal('peers'),
        session_id: idString,
    }),
    z.object({
        mode: z.literal('sessions').optional(),
        agent_name: optionalString,
        parent_session_id: optionalString,
        archive_filter: z.enum(['Unarchived', 'Archived']).optional(),
        cursor: optionalString,
        limit: optionalNumber,
    }),
]);
export const sessionGetSchema = z.object({ session_id: idString });
/**
 * `session update` 只允许改标题、`extra_data_json` 与归档状态。
 *
 * 早期版本还接受 `agent_name`,用来把会话改挂到另一个 Agent。该能力已下线:
 * 改挂只动 Session 的 `agent_id`,渠道侧(如飞书)的绑定仍指向原 Agent,之后的
 * 入站消息会被丢弃。
 *
 * `z.object` 默认静默丢弃未知字段,直接删掉 `agent_name` 会让模型拿到"成功但
 * 什么也没改"的假成功,所以这里把两个改挂字段声明成"必须缺省",让调用方拿到明确
 * 的 validation 失败。其余未知字段保持原有的静默丢弃行为,不做 `.strict()`。
 */
function removedSessionUpdateField(field) {
    return z.undefined({
        errorMap: () => ({
            message: `session update no longer supports ${field}: a session cannot be moved to another agent`,
        }),
    });
}
export const sessionUpdateSchema = z.object({
    session_id: idString,
    title: optionalString,
    extra_data_json: optionalString,
    archived: optionalBoolean,
    agent_name: removedSessionUpdateField('agent_name'),
    agent_id: removedSessionUpdateField('agent_id'),
});
/**
 * `session messages` —— read recent messages of a session. Implementation
 * lives in Track B (`commands/session.ts handleSessionMessages`).
 *
 * `limit` defaults to 20 in the handler (mirrors daemon CLI default);
 * `before` is an opaque cursor archon-server defines.
 */
export const sessionMessagesSchema = z.object({
    session_id: idString,
    limit: optionalNumber,
    before: optionalString,
});
// ─── communication (Track D — real archon-server RPC) ────────────────
/**
 * Three schemas for the `mavis communication` group, kept in tree but
 * intentionally NOT registered in `COMMAND_SCHEMAS` below. The standalone
 * `communicate` LLM tool now owns this surface in cloud-runtime — the
 * mavis subcommand was a transition-period shim that risked dual entry
 * points + drift. Re-enabling is one line in `COMMAND_SCHEMAS` if needed.
 */
export const communicationPeersSchema = z
    .object({
    session_id: optionalString,
})
    .partial();
export const communicationSendSchema = z.object({
    to: z.string().min(1, 'to is required (target peer session_id)'),
    command: z.string().min(1).default('prompt'),
    content: z.string().min(1, 'content is required and must be non-empty'),
});
export const communicationMessagesSchema = z
    .object({
    to: optionalString,
    from: optionalString,
    limit: optionalNumber,
})
    .partial()
    .refine((v) => Boolean(v.to) || Boolean(v.from), {
    message: 'communication messages requires either `to` or `from`',
});
// ─── help ──────────────────────────────────────────────────────────────
/**
 * Each `<group> help` accepts no args. Dispatcher normalizes `-h` aliases
 * (e.g. `agent -h`) to the canonical `agent help` before schema lookup.
 */
export const helpSchema = z.object({});
// ─── command → schema map ──────────────────────────────────────────────
/**
 * 命令字符串 → zod schema 的统一表。dispatcher 用 command key 查 schema,
 * 一次校验,然后把已校验的 args 传给同名 handler。
 *
 * key 形态固定为 "<group> <action> [<subaction>]",**与 mavis-tool-def
 * description 列出的形态完全一致**(空格分隔,不用 dot 或 dash)—— LLM 直接
 * 复制 description 里的字面值即可触发。
 */
export const COMMAND_SCHEMAS = {
    'agent list': agentListSchema,
    'agent get': agentGetSchema,
    'agent create': agentCreateSchema,
    'agent update': agentUpdateSchema,
    'agent delete': agentDeleteSchema,
    'agent help': helpSchema,
    'cron list': cronListSchema,
    'cron get': cronGetSchema,
    'cron create': cronCreateSchema,
    'cron once': cronOnceSchema,
    'cron self': cronSelfSchema,
    'cron update': cronUpdateSchema,
    'cron delete': cronDeleteSchema,
    'cron trigger': cronTriggerSchema,
    'cron sessions': cronSessionsSchema,
    'cron help': helpSchema,
    'session list': sessionListSchema,
    'session get': sessionGetSchema,
    'session update': sessionUpdateSchema,
    'session messages': sessionMessagesSchema,
    'session help': helpSchema,
    // Disabled: the `mavis communication peers/send/messages` subcommands have
    // been retired in favour of the standalone `communicate` LLM tool. Schemas
    // are kept in tree so re-enabling is just uncommenting these three lines +
    // the matching HANDLERS entries in dispatcher.ts.
    // 'communication peers': communicationPeersSchema,
    // 'communication send': communicationSendSchema,
    // 'communication messages': communicationMessagesSchema,
};
export const KNOWN_COMMANDS = Object.keys(COMMAND_SCHEMAS);
//# sourceMappingURL=schemas.js.map