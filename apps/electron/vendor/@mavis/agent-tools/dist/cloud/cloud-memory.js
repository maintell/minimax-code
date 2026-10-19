/**
 * CloudMemoryTools —— 11 个 `memory_*` 工具的 cloud 实现(5 个主 memory +
 * 6 个 topic memory)。
 *
 * 主 memory 工具(scope: user | agent):
 *   - `memory_read`           → GetMemory
 *   - `memory_search`         → SearchMemory
 *   - `memory_append`         → AppendMemory(增量追加,默认推荐)
 *   - `memory_edit`           → EditMemory(find-and-replace)
 *   - `memory_summary_write`  → WriteMemorySummary(.summary.md INDEX,agent only)
 *
 * Topic memory 工具(全部 agent-scope only,daemon `memory/<topic>.md`):
 *   - `memory_topic_read`     → GetMemoryTopic
 *   - `memory_topic_create`   → WriteMemoryTopic(legacy RPC, create-only)
 *   - `memory_topic_delete`   → DeleteMemoryTopic
 *   - `memory_topic_append`   → AppendMemoryTopic
 *   - `memory_topic_edit`     → EditMemoryTopic
 *   - `memory_topic_search`   → SearchMemoryTopics
 *
 * 调用 archon-server 现有 memory RPC。caller identity 由 adapter 的
 * `X-Archon-*` headers 提供；body 继续携带 `harness_base_req {session_id, biz_id}`
 * 作为 harness/session 上下文载体。
 *
 * 工具 def 在本文件就近定义 —— 共享一份命名/scope/agent_id 规约,单独抽
 * helper 派生 agent_id。schema 字段名直接镜像 IDL wire
 * 字段(snake_case),透传到 callRpc 不做转换。
 *
 * **scope → agent_id 派生**:用户 prompt 不允许直接指定 agent_id(防止 agent
 * 自我冒充其他 agent 的 memory)。wrapper 根据 schema 中的 `scope` +
 * `ctx.agentId` 派生:
 *   - `scope='user'` → agent_id = 0(user-level cross-agent memory)
 *   - `scope='agent'` → agent_id = Number(ctx.agentId)(必须存在)
 * `ctx.agentId` 缺失时直接业务失败,不发 RPC。Topic 工具固定走
 * `deriveTopicAgentId` 强制 agent scope。
 *
 * **Wire 形态注**:archon-server IDL 把 `agent_id` 标注为 `int64` 默认 json tag
 * (没 `,string` flag),hertz hbinding 严格 reject 引号 string,所以所有
 * memory Req `agent_id` 必须 JSON number 上线。`ctx.agentId` 在运行时是
 * decimal string 形态(adapter 出口转换好的精度保护态),wrapper 这里
 * `Number(ctx.agentId)` 转回 number。当前 snowflake agent_id ≤ 49 bits 还在
 * JS Number safe range 之内;`safeAgentIdToNumber` 在 boundary fail-loud,防止
 * 未来 ID 增长悄悄丢精度。详见 `archon-rpc-types.ts` memory Req 的 inline doc。
 *
 * **Tool input schema 严格对齐真 IDL**:不暴露任何 server 不支持的字段。
 * archon-server 已经在 turn 启动时通过 `MemoryPolicy.daily_digest`(随
 * AgentConfig 下行)把"近 2 天 daily full + 8 天 brief" markdown 拼进 prompt
 * `<daily_digest>` 段位 —— agent 启动时已经被动看得到 daily window,所以不
 * 单独暴露 daily-window 主动查询入口。
 *
 * **User-scope reason gate(2026-06-03)**:user-scope append 工具要求非空
 * `reason`,跟 daemon `PATCH /api/memory` 的
 * `USER_MEMORY_REASON_REQUIRED` 校验对齐 —— 强制写入者一句话说明"这条
 * entry 为什么跨 project 还成立",并把 reason 以 HTML 注释行
 * (`<!-- mem-append-reason: ... -->\n`)前缀注入 content,字节级镜像
 * daemon `memoryStore.append({ scope: 'user' }, persisted)` 写入形态。
 * `memory_edit` 支持 user / agent 两种 scope,用于修正已有条目；user-scope
 * 新增条目仍必须走 append 并写 reason。详见 `applyReasonGate`。
 *
 * 失败语义:`base_resp.status_code != 0` 时返回业务失败的 ToolResult
 * (`details.ok = false`),避免抛异常打断 turn —— 跟 mavis / web_fetch 工具
 * 的 archon business failure 通道一致。本地校验失败(missing ctx.agentId /
 * missing reason)同样返业务失败,不 throw。
 */
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { Type } from '@sinclair/typebox';
import { createHash, randomBytes } from 'node:crypto';
import { bindTool, } from '@mavis/agent-core/tools';
// ─── shared schema fragments ────────────────────────────────────────────
const ScopeSchema = Type.Union([Type.Literal('user'), Type.Literal('agent')], {
    description: 'Memory scope. "user" for cross-agent user-level memory (shared across all your agents). "agent" for this agent\'s private memory.',
});
/**
 * Max length for the user-scope `reason` field. Aligned with daemon
 * `api/memory.ts` PATCH /api/memory which has no explicit max (just
 * non-empty), but on the cloud-runtime side we cap at 500 chars to keep
 * the audit comment terse — long rationale belongs in the memory body,
 * not the prefix.
 *
 * Exported so the test suite can pin the limit without re-deriving it.
 */
export const USER_MEMORY_REASON_MAX_LENGTH = 500;
/**
 * Required when `scope="user"` for write-type main-memory tools
 * (`memory_append`). Verbatim aligned with daemon
 * `PATCH /api/memory` `USER_MEMORY_REASON_REQUIRED` gate: the daemon
 * persists the reason as an HTML comment line
 * (`<!-- mem-append-reason: ... -->`) immediately above the appended
 * content, so future audits (`mavis memory audit`, or `grep`) can trace
 * intent. Cloud-runtime injects the same HTML comment client-side so the
 * resulting wire payload (and therefore the stored file shape) is
 * byte-for-byte identical regardless of which surface — desktop CLI or
 * cloud LLM tool — wrote the entry.
 *
 * Why required only for user scope: `user` is the most-misused memory
 * layer (agents tend to dump project methodology there by muscle memory),
 * and forcing a written cross-project justification is the gate that
 * catches that failure mode at write time rather than at audit time.
 * `agent` scope has no such friction — agent memory is private to the
 * current agent and routinely accumulates per-agent technique notes.
 *
 * Schema-level rules:
 *   - typebox declares it `Optional` (typebox does not natively support
 *     "required only when sibling field has value X")
 *   - runtime gate (`applyReasonGate`) enforces non-empty after trim when
 *     `scope === 'user'`, and the 500-char cap
 *   - schema `minLength: 1` still catches the blatant `reason: ""` LLM
 *     mistake at typebox-validation time before runtime
 */
const ReasonSchema = Type.Optional(Type.String({
    minLength: 1,
    maxLength: USER_MEMORY_REASON_MAX_LENGTH,
    description: 'Required when scope="user": one-sentence cross-project justification ' +
        'explaining why this entry holds across all your projects. Persisted as an ' +
        'HTML comment line (`<!-- mem-append-reason: ... -->`) above the content for ' +
        'audit. Ignored when scope="agent". If you cannot justify it cross-project, ' +
        'the entry likely belongs in agent memory (scope="agent") or project memory ' +
        '(edit AGENTS.md) instead. Max 500 chars — keep it terse, long rationale ' +
        'belongs in the memory body, not the audit prefix.',
}));
// ─── tool defs ──────────────────────────────────────────────────────────
export const MemoryReadToolDef = {
    name: 'memory_read',
    description: 'Read a main memory file containing durable markdown knowledge. Returns full content plus the brief summary and last-modified time. Recent daily memory is already injected into your system prompt automatically.',
    schema: Type.Object({
        scope: ScopeSchema,
    }),
};
export const MemorySearchToolDef = {
    name: 'memory_search',
    description: 'Search a main memory file for matching lines. Returns line numbers plus surrounding context.',
    schema: Type.Object({
        scope: ScopeSchema,
        query: Type.String({
            minLength: 1,
            description: 'Search term. Case-insensitive substring match.',
        }),
    }),
};
export const MemoryAppendToolDef = {
    name: 'memory_append',
    description: 'Append durable markdown knowledge to a memory file. Use sparingly for information worth re-reading across sessions. ' +
        'When scope="user", the `reason` parameter is required (one-sentence cross-project justification, persisted as an audit comment).',
    schema: Type.Object({
        scope: ScopeSchema,
        content: Type.String({
            minLength: 1,
            description: 'Markdown text to append. Will be added verbatim with a leading blank line.',
        }),
        reason: ReasonSchema,
    }),
};
// ─── topic memory tool defs ─────────────────────────────────────────────
//
// Topic memory is **agent-scope only** (there's no concept of a user-scope
// topic file in either daemon or archon-server today), so the tools below
// drop the `scope` field and hard-code agent-scope inside the wrapper.
// Topic names are constrained to kebab-case `[a-z0-9][a-z0-9-]{0,63}` —
// verbatim aligned with daemon `TOPIC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`
// (1..64 chars, must start with alphanumeric). Same shape daemon uses for
// its `~/.mavis/agents/<name>/memory/<topic>.md` filenames, and a
// defence-in-depth guard against path traversal even though the cloud
// server has no fs. Daemon equivalents (for LLM reference when explaining
// what these tools do): `mavis memory topic-read <name>` /
// `mavis memory topic-write <name>` / `mavis memory topic-delete <name>` /
// `mavis memory topic-append <name>` / etc.
/**
 * Topic name shape: lowercase alphanumeric start + lowercase letters /
 * digits / hyphens, 1..64 chars. Rejects `..`, `/`, `\`, capital letters,
 * dots, leading hyphen — keeps the name safe to interpolate into an fs
 * path (daemon side does this on its host) and unambiguous when surfaced
 * in the `<available_memory_topics>` prompt block. Verbatim aligned with
 * daemon `TOPIC_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`.
 */
const TopicNameSchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: '^[a-z0-9][a-z0-9-]{0,63}$',
    description: 'Topic name (kebab-case, no .md suffix). Lowercase alphanumeric start + lowercase letters, digits, and hyphens only; 1-64 chars.',
});
export const MemoryTopicReadToolDef = {
    name: 'memory_topic_read',
    description: 'Read the full body of one agent memory topic by name. Equivalent to the daemon CLI ' +
        '`mavis memory topic-read <name>`. The list of available topics (with descriptions and sizes) is ' +
        'injected into your system prompt as `<available_memory_topics>` — bodies are intentionally not ' +
        'inlined so you pull only what you need.',
    schema: Type.Object({
        topic_name: TopicNameSchema,
    }),
};
export const MemoryTopicCreateToolDef = {
    name: 'memory_topic_create',
    description: 'Create a new agent memory topic. This is create-only: if the topic already exists, the tool fails and you must use memory_topic_append or memory_topic_edit. ' +
        'Use this for topics that capture a single coherent area of knowledge (e.g. a workflow, a gotchas list). ' +
        'Do NOT use this to update existing topics; topic overwrite is intentionally unavailable.',
    schema: Type.Object({
        topic_name: TopicNameSchema,
        description: Type.String({
            minLength: 1,
            description: 'Short one-line description of what the topic covers — surfaced in `<available_memory_topics>` to help future you decide whether to read the body.',
        }),
        body: Type.String({
            minLength: 1,
            description: 'Initial markdown body of the new topic. Empty body is rejected; use memory_topic_append or memory_topic_edit for later changes.',
        }),
    }),
};
export const MemoryTopicDeleteToolDef = {
    name: 'memory_topic_delete',
    description: 'Delete an agent memory topic by name. Equivalent to the daemon CLI `mavis memory topic-delete <name>`. ' +
        "Removes the topic from the next turn's `<available_memory_topics>` block. No-op if the topic does not exist (returns deleted=false).",
    schema: Type.Object({
        topic_name: TopicNameSchema,
    }),
};
// ─── 5 new memory tool defs ─────────────────────────────────────────────
//
// These complete the daemon-fs ↔ cloud-db alignment. On daemon, agents
// edit memory via the generic Read/Edit/Write file tools + Bash; on cloud,
// agents have no fs and need dedicated wrappers around archon-server RPCs:
//
//   - `memory_summary_write` (Phase 1) — write the .summary.md INDEX after
//     a cleanup curator session compresses MEMORY.md.
//   - `memory_edit` (Phase 2) — find-and-replace edit on MEMORY.md (mirrors
//     opencode `Edit` tool), avoids any whole-file overwrite surface.
//   - `memory_topic_append` (Phase 3) — incremental append to an existing
//     topic body (mirrors daemon `cat >> memory/<topic>.md`).
//   - `memory_topic_edit` (Phase 4) — find-and-replace edit on a topic body
//     (mirrors daemon Read+Edit on `memory/<topic>.md`).
//   - `memory_topic_search` (Phase 5) — case-insensitive keyword search
//     across topic name + description + body (mirrors daemon
//     `grep -l "kw" memory/*.md`).
export const MemorySummaryWriteToolDef = {
    name: 'memory_summary_write',
    description: 'Write your agent memory summary (.summary.md equivalent) — the compressed INDEX of MEMORY.md. This is an overwrite and requires two calls: first call prepares and returns confirm_token/current content, second call with the same content + confirm_token commits. ' +
        'Format: per-`###` entry with one-line conclusion + `source: memory/MEMORY.md:<lineStart>-<lineEnd>` reference. ' +
        'Max 15 entries; total cap 4KB enforced server-side. Called by cleanup curator session Step 9.',
    schema: Type.Object({
        content: Type.String({ minLength: 1, maxLength: 4096 }),
        confirm_token: Type.Optional(Type.String()),
    }),
};
const SUMMARY_CONFIRM_TTL_MS = 10 * 60 * 1000;
const pendingSummaryWrites = new Map();
function sha256(input) {
    return createHash('sha256').update(input).digest('hex');
}
function summaryConfirmKey(ctx, agentId) {
    return `${ctx.sessionId}:${ctx.turnId}:${agentId}:${MemorySummaryWriteToolDef.name}`;
}
function previewText(s, limit = 4096) {
    if (s.length <= limit)
        return s;
    const half = Math.floor(limit / 2);
    return `${s.slice(0, half)}\n...<truncated ${s.length - limit} chars>...\n${s.slice(-half)}`;
}
export const MemoryEditToolDef = {
    name: 'memory_edit',
    description: 'Find-and-replace edit on your MEMORY.md for user or agent scope. Equivalent to opencode Edit tool. ' +
        '`old_string` must exist (errors OLD_STRING_NOT_FOUND if absent). ' +
        'If matched multiple times and `replace_all=false`, errors OLD_STRING_AMBIGUOUS — provide more surrounding context to disambiguate. ' +
        'Use this for targeted updates; use memory_append for new entries. Whole-file overwrite is intentionally unavailable for main memory. ' +
        'Supports scope="user" and scope="agent"; for user-scope new entries, use memory_append with the required reason audit comment.',
    schema: Type.Object({
        scope: ScopeSchema,
        old_string: Type.String({ minLength: 1 }),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean({ default: false })),
    }),
};
export const MemoryTopicAppendToolDef = {
    name: 'memory_topic_append',
    description: 'Append content to the end of an existing agent memory topic body. Equivalent to daemon `cat >> memory/<topic>.md`. ' +
        'Automatically adds "\\n" separator. 30KB total body cap enforced server-side — errors TOPIC_TOO_LARGE if exceeded. ' +
        'Use this for incremental additions. If the topic does not exist, create it first with memory_topic_create.',
    schema: Type.Object({
        topic_name: TopicNameSchema,
        content: Type.String({ minLength: 1 }),
    }),
};
export const MemoryTopicEditToolDef = {
    name: 'memory_topic_edit',
    description: 'Find-and-replace edit on an existing agent memory topic body. Same semantics as memory_edit. ' +
        'Equivalent to a targeted file edit on the topic body. ' +
        'Use for targeted edits; use memory_topic_append to add at end. If the topic does not exist, create it first with memory_topic_create. Whole-topic overwrite is intentionally unavailable.',
    schema: Type.Object({
        topic_name: TopicNameSchema,
        old_string: Type.String({ minLength: 1 }),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean({ default: false })),
    }),
};
export const MemoryTopicSearchToolDef = {
    name: 'memory_topic_search',
    description: 'Search your agent memory topics by case-insensitive keyword. LIKE-matches against topic name + description + body. ' +
        'Returns matching topics with name, description, size_bytes (NOT body — call memory_topic_read for body). ' +
        'Equivalent to daemon `grep -l "kw" memory/*.md`. Use this to find candidate topics before reading bodies — much cheaper than list+N reads.',
    schema: Type.Object({
        keyword: Type.String({ minLength: 1, maxLength: 200 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
};
/**
 * 把 ctx.agentId(decimal string)安全转为 number。当前 snowflake agent_id
 * ≤ 49 bits 在 JS Number.MAX_SAFE_INTEGER 内,转换无损。如果未来 agent_id
 * 增长到超 53 bits(Number.MAX_SAFE_INTEGER = 2^53 - 1),`Number()` 会悄悄
 * 丢精度;此时 `String(n) !== s` 命中,直接 fail-loud 让上游 surface,而不是
 * 把丢精度的 ID 发给 archon-server 撞 row-not-found。
 */
function safeAgentIdToNumber(s) {
    const n = Number(s);
    if (!Number.isFinite(n) || String(n) !== s) {
        return {
            ok: false,
            error: `memory tool: ctx.agentId="${s}" cannot be safely converted to JS Number (precision would be lost or input not a decimal i64). archon-server IDL requires JSON number wire shape; switch to bigint serialization if agent_id exceeds Number.MAX_SAFE_INTEGER.`,
        };
    }
    return { ok: true, n };
}
export function deriveMemoryAgentId(scope, ctx) {
    if (scope === 'user') {
        return { ok: true, agentId: 0 };
    }
    if (!ctx.agentId || ctx.agentId === '0') {
        return {
            ok: false,
            error: 'memory tool: scope="agent" requires the turn context to carry agentId, but it is missing (agent_config.agent_id likely unset). Use scope="user" or run inside an agent-bound session.',
        };
    }
    const conv = safeAgentIdToNumber(ctx.agentId);
    if (!conv.ok)
        return { ok: false, error: conv.error };
    return { ok: true, agentId: conv.n };
}
export function buildMemoryHarnessBaseReq(ctx) {
    const base = { session_id: ctx.sessionId };
    if (ctx.bizId)
        base.biz_id = ctx.bizId;
    return base;
}
/** archon-server `base_resp.status_code != 0` → 业务失败 ToolResult。 */
function businessFailureResult(toolName, resp) {
    const statusCode = resp.base_resp?.status_code ?? 0;
    const message = resp.base_resp?.status_msg ??
        `archon-server ${toolName} returned non-zero status_code=${statusCode}`;
    return {
        tool_name: toolName,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, status_code: statusCode },
    };
}
/** ctx 派生失败 → 业务失败 ToolResult,不发 RPC。 */
function ctxDerivationFailureResult(toolName, message) {
    return {
        tool_name: toolName,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, reason: 'ctx_derivation_failed' },
    };
}
/**
 * Apply the user-scope reason gate to a write-type main-memory tool input.
 *
 * For `scope='agent'`: pass-through — agent memory has no reason gate
 *   (private to the current agent, accumulates per-agent technique notes
 *   without friction).
 *
 * For `scope='user'`:
 *   - `reason` must be defined and non-empty after trim — empty / missing
 *     / whitespace-only is a business failure with `reason='user_memory_reason_required'`.
 *     Mirrors daemon `USER_MEMORY_REASON_REQUIRED` error code.
 *   - trimmed length must not exceed `USER_MEMORY_REASON_MAX_LENGTH`
 *     (500 chars) — long rationale belongs in the body, not the audit
 *     prefix. Business failure with `reason='user_memory_reason_too_long'`.
 *   - on success, prepends `<!-- mem-append-reason: ${escapedReason} -->\n`
 *     to `rawContent` (escape rule verbatim daemon).
 *
 * The helper does NOT perform schema-level validation (typebox already ran
 * by the time the executor calls this); it just enforces the cross-scope
 * runtime rule that typebox cannot express natively.
 */
export function applyReasonGate(toolName, scope, rawContent, reason) {
    if (scope !== 'user') {
        return { ok: true, content: rawContent };
    }
    const trimmed = reason?.trim() ?? '';
    if (trimmed === '') {
        const message = 'memory tool: scope="user" requires a non-empty "reason" parameter — ' +
            'one-sentence cross-project justification explaining why this entry holds ' +
            'across all your projects. If you cannot justify it cross-project, the entry ' +
            'likely belongs in agent memory (scope="agent") or project memory (edit ' +
            'AGENTS.md) instead. Aligned with daemon PATCH /api/memory ' +
            '`USER_MEMORY_REASON_REQUIRED` gate.';
        return {
            ok: false,
            result: reasonGateFailureResult(toolName, message, 'user_memory_reason_required'),
        };
    }
    if (trimmed.length > USER_MEMORY_REASON_MAX_LENGTH) {
        const message = `memory tool: scope="user" "reason" length ${trimmed.length} exceeds the ` +
            `${USER_MEMORY_REASON_MAX_LENGTH}-char cap. Tighten to one short sentence — ` +
            'long rationale belongs in the memory body, not the audit prefix.';
        return {
            ok: false,
            result: reasonGateFailureResult(toolName, message, 'user_memory_reason_too_long'),
        };
    }
    // Escape `-->` so an accidental or malicious sequence cannot break out
    // of the HTML comment. Verbatim aligned with daemon api/memory.ts:
    //   `<!-- mem-append-reason: ${reason.replace(/-->/g, '--&gt;')} -->\n${content}`
    const escaped = trimmed.replace(/-->/g, '--&gt;');
    const comment = `<!-- mem-append-reason: ${escaped} -->\n`;
    return { ok: true, content: `${comment}${rawContent}` };
}
function reasonGateFailureResult(toolName, message, reasonCode) {
    return {
        tool_name: toolName,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, reason: reasonCode },
    };
}
/**
 * Legacy helper kept for older tests / direct imports. The current LLM-facing
 * MEMORY capability no longer rejects `memory_edit` for user scope: user and
 * agent main memory both expose append + edit only, with whole-file overwrite
 * intentionally unavailable.
 */
export function rejectUserScopeEdit(toolName) {
    const message = 'memory tool: scope="user" edit rejection is deprecated; memory_edit now supports user scope. This helper should not be called by the registered executor.';
    return {
        tool_name: toolName,
        text: message,
        content: [{ type: 'text', text: message }],
        details: { ok: false, reason: 'user_scope_edit_disallowed' },
    };
}
// ─── tool impls ─────────────────────────────────────────────────────────
let CloudMemoryReadTool = (() => {
    let _classDecorators = [bindTool(MemoryReadToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryReadTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryReadTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveMemoryAgentId(input.scope, ctx);
            if (!derive.ok)
                return ctxDerivationFailureResult(MemoryReadToolDef.name, derive.error);
            const resp = await this.archonServer.callRpc('GetMemory', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryReadToolDef.name, resp);
            }
            const text = formatReadResp(resp);
            return {
                tool_name: MemoryReadToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    scope: input.scope,
                    size_bytes: resp.size_bytes ?? 0,
                    updated_at: resp.updated_at ?? '',
                },
            };
        }
    };
    return CloudMemoryReadTool = _classThis;
})();
export { CloudMemoryReadTool };
let CloudMemorySearchTool = (() => {
    let _classDecorators = [bindTool(MemorySearchToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemorySearchTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemorySearchTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveMemoryAgentId(input.scope, ctx);
            if (!derive.ok)
                return ctxDerivationFailureResult(MemorySearchToolDef.name, derive.error);
            const resp = await this.archonServer.callRpc('SearchMemory', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                query: input.query,
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemorySearchToolDef.name, resp);
            }
            const text = formatSearchResp(resp, input.query);
            return {
                tool_name: MemorySearchToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    scope: input.scope,
                    query: input.query,
                    result_count: resp.results?.length ?? 0,
                },
            };
        }
    };
    return CloudMemorySearchTool = _classThis;
})();
export { CloudMemorySearchTool };
let CloudMemoryAppendTool = (() => {
    let _classDecorators = [bindTool(MemoryAppendToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryAppendTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryAppendTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveMemoryAgentId(input.scope, ctx);
            if (!derive.ok)
                return ctxDerivationFailureResult(MemoryAppendToolDef.name, derive.error);
            // User-scope reason gate: rewrites `content` with `<!-- mem-append-reason: ... -->\n`
            // prefix when scope='user'; pass-through for scope='agent'. Returns business
            // failure (no RPC) on missing/empty/over-cap reason.
            const gated = applyReasonGate(MemoryAppendToolDef.name, input.scope, input.content, input.reason);
            if (!gated.ok)
                return gated.result;
            const resp = await this.archonServer.callRpc('AppendMemory', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                content: gated.content,
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryAppendToolDef.name, resp);
            }
            const newSize = resp.new_size_bytes ?? 0;
            // Report the gated payload length so the LLM sees the actual bytes
            // sent (HTML reason comment prefix included for user scope).
            const text = `Appended ${gated.content.length} chars to ${input.scope} memory (new total: ${newSize} bytes).`;
            return {
                tool_name: MemoryAppendToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, scope: input.scope, new_size_bytes: newSize },
            };
        }
    };
    return CloudMemoryAppendTool = _classThis;
})();
export { CloudMemoryAppendTool };
// ─── response formatters ────────────────────────────────────────────────
function formatReadResp(resp) {
    const parts = [];
    if (resp.content !== undefined)
        parts.push(resp.content);
    if (resp.brief)
        parts.push(`\n--- brief ---\n${resp.brief}`);
    return parts.join('\n');
}
function formatSearchResp(resp, query) {
    const results = resp.results ?? [];
    if (results.length === 0)
        return `No matches for "${query}".`;
    const lines = [`${results.length} match(es) for "${query}":`];
    for (const r of results) {
        lines.push(`L${r.line_number}: ${r.line}`);
        if (r.context && r.context.length > 0) {
            for (const c of r.context)
                lines.push(`    ${c}`);
        }
    }
    return lines.join('\n');
}
// ─── topic memory tool impls ────────────────────────────────────────────
//
// All three tools hard-code `scope='agent'` for agent_id derivation —
// topic memory lives under the agent (mirrors daemon
// `~/.mavis/agents/<name>/memory/<topic>.md`). The wrapper still goes
// through `deriveMemoryAgentId('agent', ctx)` instead of inlining the
// agentId pull, so the same fail-loud paths (missing agentId / unsafe
// i64 string) are exercised here as in the other memory tools.
/** Force scope='agent' for topic tools and turn ctx mishaps into business failures. */
function deriveTopicAgentId(toolName, ctx) {
    const derive = deriveMemoryAgentId('agent', ctx);
    if (!derive.ok) {
        return { ok: false, result: ctxDerivationFailureResult(toolName, derive.error) };
    }
    return { ok: true, agentId: derive.agentId };
}
let CloudMemoryTopicReadTool = (() => {
    let _classDecorators = [bindTool(MemoryTopicReadToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryTopicReadTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryTopicReadTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveTopicAgentId(MemoryTopicReadToolDef.name, ctx);
            if (!derive.ok)
                return derive.result;
            const resp = await this.archonServer.callRpc('GetMemoryTopic', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                topic_name: input.topic_name,
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryTopicReadToolDef.name, resp);
            }
            const body = resp.body ?? '';
            const description = resp.description ?? '';
            const sizeBytes = resp.size_bytes ?? 0;
            const header = `# ${input.topic_name}\n> ${description}\n> size: ${sizeBytes} bytes\n\n`;
            const text = body ? `${header}${body}` : `${header}(empty body)`;
            return {
                tool_name: MemoryTopicReadToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    name: resp.name ?? input.topic_name,
                    description,
                    body,
                    size_bytes: sizeBytes,
                },
            };
        }
    };
    return CloudMemoryTopicReadTool = _classThis;
})();
export { CloudMemoryTopicReadTool };
let CloudMemoryTopicCreateTool = (() => {
    let _classDecorators = [bindTool(MemoryTopicCreateToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryTopicCreateTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryTopicCreateTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveTopicAgentId(MemoryTopicCreateToolDef.name, ctx);
            if (!derive.ok)
                return derive.result;
            // IDL `WriteMemoryTopicReq.content` (field 4) carries the body; the LLM-facing
            // schema names it `body` to match the daemon CLI vocabulary, and we rename
            // here in a single place rather than leaking IDL field naming into the
            // tool surface.
            const resp = await this.archonServer.callRpc('WriteMemoryTopic', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                topic_name: input.topic_name,
                description: input.description,
                content: input.body,
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryTopicCreateToolDef.name, resp);
            }
            const sizeBytes = Buffer.byteLength(input.body, 'utf8');
            const text = `Created topic "${input.topic_name}" (${sizeBytes} bytes).`;
            return {
                tool_name: MemoryTopicCreateToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    topic_name: input.topic_name,
                    size_bytes: sizeBytes,
                },
            };
        }
    };
    return CloudMemoryTopicCreateTool = _classThis;
})();
export { CloudMemoryTopicCreateTool };
let CloudMemoryTopicDeleteTool = (() => {
    let _classDecorators = [bindTool(MemoryTopicDeleteToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryTopicDeleteTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryTopicDeleteTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveTopicAgentId(MemoryTopicDeleteToolDef.name, ctx);
            if (!derive.ok)
                return derive.result;
            const resp = await this.archonServer.callRpc('DeleteMemoryTopic', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                topic_name: input.topic_name,
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryTopicDeleteToolDef.name, resp);
            }
            // Server returns `deleted: false` for "topic did not exist" — surface it
            // verbatim so the LLM can distinguish "I removed something" from
            // "nothing to remove".
            const deleted = resp.deleted ?? false;
            const text = deleted
                ? `Deleted topic "${input.topic_name}".`
                : `Topic "${input.topic_name}" did not exist (no-op).`;
            return {
                tool_name: MemoryTopicDeleteToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, deleted, topic_name: input.topic_name },
            };
        }
    };
    return CloudMemoryTopicDeleteTool = _classThis;
})();
export { CloudMemoryTopicDeleteTool };
// ─── 5 new memory tool impls (memory_summary_write, memory_edit,
// memory_topic_append, memory_topic_edit, memory_topic_search) ──────────
//
// Wrappers follow the same pattern as the existing main + topic memory
// tools: derive agent_id from ctx (scope-aware where applicable), call
// RPC, translate `base_resp.status_code != 0` into a business-failure
// `details.ok=false` ToolResult.
let CloudMemorySummaryWriteTool = (() => {
    let _classDecorators = [bindTool(MemorySummaryWriteToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemorySummaryWriteTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemorySummaryWriteTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Summary is always agent-scope (it's the .summary.md INDEX of an
            // agent's MEMORY.md). Hard-code 'agent' like the topic tools.
            const derive = deriveTopicAgentId(MemorySummaryWriteToolDef.name, ctx);
            if (!derive.ok)
                return derive.result;
            const key = summaryConfirmKey(ctx, derive.agentId);
            const contentHash = sha256(input.content);
            const now = Date.now();
            const token = input.confirm_token;
            if (!token) {
                const readResp = await this.archonServer.callRpc('GetMemory', {
                    agent_id: derive.agentId,
                    harness_base_req: buildMemoryHarnessBaseReq(ctx),
                }, signal);
                if ((readResp.base_resp?.status_code ?? 0) !== 0) {
                    return businessFailureResult(MemorySummaryWriteToolDef.name, readResp);
                }
                const current = readResp.brief ?? '';
                const confirmToken = `memsum_${randomBytes(12).toString('hex')}`;
                pendingSummaryWrites.set(key, {
                    token: confirmToken,
                    sessionId: ctx.sessionId,
                    turnId: ctx.turnId,
                    agentId: derive.agentId,
                    contentHash,
                    createdAt: now,
                    expiresAt: now + SUMMARY_CONFIRM_TTL_MS,
                });
                const currentBytes = Buffer.byteLength(current, 'utf8');
                const newBytes = Buffer.byteLength(input.content, 'utf8');
                const preview = previewText(current);
                const expiresInSec = Math.floor(SUMMARY_CONFIRM_TTL_MS / 1000);
                // `details` is NOT visible to the model (see ToolResult docs in
                // agent-core/tools/types.ts). The confirm_token + preview + sizes must
                // also appear in `text` so the LLM can echo the token in its second
                // memory_summary_write call. Keep `details` for programmatic callers.
                const text = 'memory_summary_write requires confirmation before overwriting the existing summary.\n' +
                    `confirm_token: ${confirmToken}\n` +
                    `current_size_bytes: ${currentBytes}\n` +
                    `new_size_bytes: ${newBytes}\n` +
                    `expires_in_sec: ${expiresInSec}\n` +
                    'Review current_summary_preview below, then call memory_summary_write again with the SAME content and the confirm_token above to commit.\n' +
                    '--- current_summary_preview ---\n' +
                    `${preview}\n` +
                    '--- end current_summary_preview ---';
                return {
                    tool_name: MemorySummaryWriteToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        ok: false,
                        requires_confirmation: true,
                        confirm_token: confirmToken,
                        current_summary_preview: preview,
                        current_size_bytes: currentBytes,
                        new_size_bytes: newBytes,
                        expires_in_ms: SUMMARY_CONFIRM_TTL_MS,
                    },
                };
            }
            const pending = pendingSummaryWrites.get(key);
            if (!pending ||
                pending.token !== token ||
                pending.contentHash !== contentHash ||
                pending.expiresAt < now) {
                pendingSummaryWrites.delete(key);
                const text = 'memory_summary_write confirmation failed or expired. Call memory_summary_write without confirm_token again to prepare a fresh confirmation.';
                return {
                    tool_name: MemorySummaryWriteToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: { ok: false, reason: 'confirmation_failed' },
                };
            }
            const resp = await this.archonServer.callRpc('WriteMemorySummary', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                content: input.content,
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemorySummaryWriteToolDef.name, resp);
            }
            pendingSummaryWrites.delete(key);
            const sizeBytes = Buffer.byteLength(input.content, 'utf8');
            const text = `Wrote memory summary (${sizeBytes} bytes / ${input.content.length} chars).`;
            return {
                tool_name: MemorySummaryWriteToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, size_bytes: sizeBytes },
            };
        }
    };
    return CloudMemorySummaryWriteTool = _classThis;
})();
export { CloudMemorySummaryWriteTool };
let CloudMemoryEditTool = (() => {
    let _classDecorators = [bindTool(MemoryEditToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryEditTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryEditTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveMemoryAgentId(input.scope, ctx);
            if (!derive.ok)
                return ctxDerivationFailureResult(MemoryEditToolDef.name, derive.error);
            const reqBody = {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                old_string: input.old_string,
                new_string: input.new_string,
            };
            if (input.replace_all !== undefined)
                reqBody.replace_all = input.replace_all;
            const resp = await this.archonServer.callRpc('EditMemory', reqBody, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryEditToolDef.name, resp);
            }
            const replacements = resp.replacements ?? 0;
            const newSize = resp.new_size_bytes ?? 0;
            const text = `Edited ${input.scope} memory: ${replacements} replacement(s). New size: ${newSize} bytes.`;
            return {
                tool_name: MemoryEditToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    scope: input.scope,
                    replacements,
                    new_size_bytes: newSize,
                },
            };
        }
    };
    return CloudMemoryEditTool = _classThis;
})();
export { CloudMemoryEditTool };
let CloudMemoryTopicAppendTool = (() => {
    let _classDecorators = [bindTool(MemoryTopicAppendToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryTopicAppendTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryTopicAppendTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveTopicAgentId(MemoryTopicAppendToolDef.name, ctx);
            if (!derive.ok)
                return derive.result;
            const resp = await this.archonServer.callRpc('AppendMemoryTopic', {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                topic_name: input.topic_name,
                content: input.content,
            }, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryTopicAppendToolDef.name, resp);
            }
            const newSize = resp.new_size_bytes ?? 0;
            const text = `Appended ${input.content.length} chars to topic "${input.topic_name}" (new total: ${newSize} bytes).`;
            return {
                tool_name: MemoryTopicAppendToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    topic_name: input.topic_name,
                    new_size_bytes: newSize,
                },
            };
        }
    };
    return CloudMemoryTopicAppendTool = _classThis;
})();
export { CloudMemoryTopicAppendTool };
let CloudMemoryTopicEditTool = (() => {
    let _classDecorators = [bindTool(MemoryTopicEditToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryTopicEditTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryTopicEditTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveTopicAgentId(MemoryTopicEditToolDef.name, ctx);
            if (!derive.ok)
                return derive.result;
            const reqBody = {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                topic_name: input.topic_name,
                old_string: input.old_string,
                new_string: input.new_string,
            };
            if (input.replace_all !== undefined)
                reqBody.replace_all = input.replace_all;
            const resp = await this.archonServer.callRpc('EditMemoryTopic', reqBody, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryTopicEditToolDef.name, resp);
            }
            const replacements = resp.replacements ?? 0;
            const newSize = resp.new_size_bytes ?? 0;
            const text = `Edited topic "${input.topic_name}": ${replacements} replacement(s). New size: ${newSize} bytes.`;
            return {
                tool_name: MemoryTopicEditToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    topic_name: input.topic_name,
                    replacements,
                    new_size_bytes: newSize,
                },
            };
        }
    };
    return CloudMemoryTopicEditTool = _classThis;
})();
export { CloudMemoryTopicEditTool };
let CloudMemoryTopicSearchTool = (() => {
    let _classDecorators = [bindTool(MemoryTopicSearchToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudMemoryTopicSearchTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudMemoryTopicSearchTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const derive = deriveTopicAgentId(MemoryTopicSearchToolDef.name, ctx);
            if (!derive.ok)
                return derive.result;
            const reqBody = {
                agent_id: derive.agentId,
                harness_base_req: buildMemoryHarnessBaseReq(ctx),
                keyword: input.keyword,
            };
            if (input.limit !== undefined)
                reqBody.limit = input.limit;
            const resp = await this.archonServer.callRpc('SearchMemoryTopics', reqBody, signal);
            if ((resp.base_resp?.status_code ?? 0) !== 0) {
                return businessFailureResult(MemoryTopicSearchToolDef.name, resp);
            }
            const topics = resp.topics ?? [];
            const text = formatTopicSearchResp(topics, input.keyword);
            return {
                tool_name: MemoryTopicSearchToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    keyword: input.keyword,
                    result_count: topics.length,
                    topics,
                },
            };
        }
    };
    return CloudMemoryTopicSearchTool = _classThis;
})();
export { CloudMemoryTopicSearchTool };
function formatTopicSearchResp(topics, keyword) {
    if (topics.length === 0)
        return `No topics matching "${keyword}".`;
    const lines = [`${topics.length} topic(s) matching "${keyword}":`];
    for (const t of topics) {
        lines.push(`- ${t.name} (${t.size_bytes} bytes) — ${t.description}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=cloud-memory.js.map