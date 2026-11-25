import { z } from 'zod';
/**
 * PersistedMessage —— cloud-runtime 持久化层(OSS jsonl)的"一行"模型。
 *
 * 设计原则:
 *
 * 1. **不重定义消息结构** —— `message` 字段直接持有 pi-agent-core 的 `AgentMessage`
 *    (即 `pi-ai` 的 `Message` ∪ pi-coding-agent 注入的 4 种 custom message:
 *    `bashExecution / custom / branchSummary / compactionSummary`)。
 *    cloud-runtime 不在这一层引入并行类型,避免跟 pi 演进出现 schema 漂移。
 *
 * 2. **封套字段严校验,message 字段透传** —— zod schema 对外只保证:
 *    - `message_id` 是 `msg-<uuidv7>`(cloud-runtime 生成)、纯数字 wire id
 *      (archon-server 给 user 消息分配的 snowflake id,透传落盘),或 archon-server
 *      透传的其它投递 id(见 {@link MessageIdSchema})
 *    - `turn_id` 非空 string
 *    - `message` 是 object 且至少含 `role: string`(用来区分 7 种 union 成员)
 *    其余字段统一 `passthrough()`,pi-agent-core 后续增加新的 custom message
 *    role 时 cloud-runtime 零改动放行;反之我们也不会因为 pi 微调字段而 break。
 *
 * 3. **`message.timestamp` 是唯一时间戳** —— 不在封套上额外加 `created_at_ms`,
 *    pi-ai 的 `Message` 三件套以及 pi-coding-agent 的 4 种 custom message 都
 *    自带 `timestamp: number`(ms),封套再加一份只会出现两个时间字段对不齐
 *    的歧义。
 *
 * 4. **`turn_id` 在封套层** —— pi 的 `AgentMessage` 没有 turn 概念,cloud-runtime
 *    需要它来切 "本轮用户输入 vs 历史",所以放到封套。
 *
 * 5. **持久化是 append-only** —— 不存在"原地更新某条 PersistedMessage"。tool 调用
 *    在 Layer 2 模型里是两条独立消息(assistant 的 `ToolCall` content block + 单独
 *    一条 `ToolResultMessage`),不需要修改任何已落地消息。
 */
/**
 * v1 cloud-runtime 追加落盘时不校验 message_id，archon-server 给 user 消息的 id 原样写进
 * `messages.jsonl` 与快照。除 snowflake 数字外，cron 投递的消息带的是投递 key
 * `cron-run:<runId>`。读取侧必须接受 v1 实际写出的 id：快照严格解析遇到它会让整条谱系不可信
 * （压缩永久失败），`messages.jsonl` 宽松解析会静默丢掉这条 user 消息。第三种写法沿用
 * continuation `SafeIdSchema` 的字母表与 256 长度上限；前两种写法不变，只扩展不收紧。
 */
const MessageIdSchema = z
    .string()
    .regex(/^(?:msg-.+|\d+|[A-Za-z0-9._:-]{1,256})$/u, 'message_id must be "msg-<uuidv7>" (cloud-runtime), a numeric wire id or a safe archon-server delivery id');
/**
 * 对 `AgentMessage` 的最小校验:至少有 `role: string`,其余字段透传。
 *
 * 故意不枚举 7 种 role:
 * - pi-coding-agent 已经通过 `declare module` 注入 4 种 custom role
 *   (`bashExecution / custom / branchSummary / compactionSummary`),将来还可能加;
 * - cloud-runtime 不是 LLM 协议的真值源,这里硬编码枚举只会拖滞 pi 升级。
 */
const AgentMessageEnvelopeSchema = z
    .object({
    role: z.string().min(1),
})
    .passthrough();
/**
 * `turn_config` —— 仅在 `message.role === 'user'` 时由 SessionController 注入,
 * 记录"这一轮 LLM 实际看到的配置快照"。设计要点:
 *
 * - `system_prompt` 写**装配后的** `composed.systemPrompt`(含 SR / persona /
 *   behavior / Environment 段 / memory 等真实拼接结果),而不是原始 `agent_config.system_prompt`。
 *   这样审计回放时能看到当时模型真正接收到的 system 文本。
 * - `model` 是 `ModelRef`,但 **`api_key` 必须 strip 掉**(密钥不能落到 OSS jsonl)。
 *   其余字段(provider / model_id / thinking_level / base_url)保留。
 * - `tools` 是本轮 LLM 实际拿到的工具清单 —— SessionController 在 turn 启动时
 *   按 `agent_config.tools[]` 过滤进程级 RuntimeTool 注册表得到,每条记录工具的
 *   `tool_name / description / schema`(schema 是 typebox JSON-shape,passthrough
 *   保留所有字段)。审计回放可以据此知道当时模型可调用的能力集合。
 * - 字段是 optional:历史 jsonl 行没有这个字段,消费方按"未带 = 历史数据"处理。
 * - 非 user 角色的消息**不带** turn_config —— 一轮配置在 user message 这条上 anchor
 *   一次足够,assistant/tool 复制只会膨胀文件。
 *
 * model / tools[].schema 内部用 `passthrough()` 与 protocol/ModelRefSchema /
 * typebox 解耦:上游字段演进时 cloud-runtime 不必跟随改 schema,只在 SessionController
 * 注入处 strip 已知的敏感字段(目前是 model.api_key)。
 */
const TurnConfigToolSchema = z
    .object({
    tool_name: z.string().min(1),
    description: z.string(),
    schema: z.object({}).passthrough(),
})
    .passthrough();
const TurnConfigSchema = z
    .object({
    system_prompt: z.string(),
    model: z.object({}).passthrough(),
    tools: z.array(TurnConfigToolSchema).optional(),
})
    .passthrough();
const NonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/**
 * `history_artifact` —— cloud-harness-server 写在 active 与快照第一条记录上的代际标记，结构与
 * harness `HistoryGenerationMarker` 相同，校验同 lrv2：键精确，父快照代际恰好比本代小 1。
 * 只允许出现在第一条记录上：多行解析（{@link parsePersistedMessageLines} 与快照严格解析）遇到之后的
 * 记录带标记时去掉标记、保留消息。v1 不解释它。
 */
const HistoryArtifactSchema = z
    .object({
    schemaVersion: z.literal(1),
    generation: NonNegativeSafeIntegerSchema.min(1),
    producedBy: z.enum(['tool_archive', 'tool_trim', 'llm_checkpoint']),
    parentSnapshot: z
        .object({
        generation: NonNegativeSafeIntegerSchema,
        compactionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
        revision: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    })
        .strict(),
})
    .strict()
    .refine((marker) => marker.parentSnapshot.generation + 1 === marker.generation, {
    message: 'history_artifact parentSnapshot.generation must be generation - 1',
});
export const PersistedMessageSchema = z
    .object({
    message_id: MessageIdSchema,
    turn_id: z.string().min(1),
    message: AgentMessageEnvelopeSchema,
    turn_config: TurnConfigSchema.optional(),
    history_artifact: HistoryArtifactSchema.optional(),
})
    .strict();
/** 多行解析得到的第 `index` 条记录:`history_artifact` 只留在第一条上,之后的去掉并经 `report` 说明。 */
export function keepLeadingHistoryArtifact(message, index, report) {
    if (index === 0 || message.history_artifact === undefined)
        return message;
    report?.('history_artifact is only allowed on the first record; dropped');
    const rest = { ...message };
    delete rest.history_artifact;
    return rest;
}
/**
 * 宽松解析 `messages.jsonl` 全文:按 `\n` 分行,空白行跳过;JSON 解析失败或封套校验
 * 不通过的行报告后跳过,保证单条损坏不会让整个 session 不可用。不去重。第一条之后的记录带
 * `history_artifact` 时去掉标记并报告,消息照常保留。
 *
 * cloud-runtime 加载会话历史与 v2 把 `messages.jsonl` 当第 0 段读取共用这一份规则。
 */
export function parsePersistedMessageLines(text, onMalformed) {
    return parsePersistedMessageLineSequence(text.split('\n'), onMalformed);
}
/**
 * 按 {@link parsePersistedMessageLines} 的规则解析已按 `\n` 切开的各行，行号是行在序列中的位置（从 1
 * 开始）。调用方可以逐行解码对象字节，不必先拼出整份文本。
 */
export function parsePersistedMessageLineSequence(lines, onMalformed) {
    const messages = [];
    let count = 0;
    for (const raw of lines) {
        count += 1;
        const lineNo = count;
        const trimmed = raw.trim();
        if (trimmed === '')
            continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        }
        catch (err) {
            onMalformed?.(lineNo, `invalid JSON: ${err.message}`);
            continue;
        }
        const parsed = PersistedMessageSchema.safeParse(obj);
        if (!parsed.success) {
            onMalformed?.(lineNo, `schema rejected: ${parsed.error.message}`);
            continue;
        }
        messages.push(keepLeadingHistoryArtifact(parsed.data, messages.length, (reason) => onMalformed?.(lineNo, reason)));
    }
    return messages;
}
//# sourceMappingURL=persisted-message.js.map