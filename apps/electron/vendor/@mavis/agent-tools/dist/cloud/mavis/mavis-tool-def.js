/**
 * MavisBaseToolDef —— cloud-runtime `mavis` LLM tool 的 ToolDefinition。
 *
 * 形态:单一 LLM 工具,内部按 `command` 字符串(`"<group> <action>"`)派发到
 * 个 archon-server 管理 RPC。设计意图见 `tools/mavis/dispatcher.ts` 开头注释。
 *
 * description 是 LLM 唯一的 reference —— 全列子命令清单 + args schema +
 * 输出形态 + 示例。新增 / 修改 subcommand 时同步更新本文件 + dispatcher。
 *
 * Note: tool schema 用 typebox(沿用 `@mavis/agent-core/tools` 的 ToolDefinition
 * 约定),但 per-command args 校验在 dispatcher 里走 zod —— typebox 表达不出
 * "based on command 字段决定 args 字段集" 的 discriminated union,所以 tool
 * schema 只列出所有已知 args 字段的 superset,真正的强约束在 zod。
 */
import { Type } from '@sinclair/typebox';
import { createMavisOperationClassifier } from '../../shared/mavis-operation-classifier.js';
import { KNOWN_COMMANDS } from './schemas.js';
export const CLOUD_MAVIS_COMMANDS = Object.freeze(KNOWN_COMMANDS.filter((command) => !command.startsWith('cron ')));
const MavisArgsSchema = Type.Object({
    // paging
    cursor: Type.Optional(Type.String({ description: 'Opaque pagination cursor.' })),
    limit: Type.Optional(Type.Number({ description: 'Non-negative integer page size.' })),
    offset: Type.Optional(Type.Number({ description: 'Non-negative integer offset.' })),
    // agent
    agent_name: Type.Optional(Type.String({ description: 'Agent display name, or "me".' })),
    name: Type.Optional(Type.String({ description: 'New agent display name.' })),
    new_name: Type.Optional(Type.String({ description: 'Replacement name/title for rename.' })),
    system_prompt: Type.Optional(Type.String({ description: 'Agent system prompt.' })),
    persona: Type.Optional(Type.String({ description: 'Agent persona.' })),
    description: Type.Optional(Type.String({ description: 'Human-readable description.' })),
    avatar: Type.Optional(Type.String({ description: 'Avatar URL or asset id.' })),
    // session
    mode: Type.Optional(Type.Union([Type.Literal('sessions'), Type.Literal('peers')], {
        description: 'session_list mode. sessions is the default; peers lists reachable peers.',
    })),
    session_id: Type.Optional(Type.String({ description: 'Session id, or "me".' })),
    parent_session_id: Type.Optional(Type.String({ description: 'Parent session id, or "me".' })),
    archive_filter: Type.Optional(Type.Union([Type.Literal('Unarchived'), Type.Literal('Archived')])),
    title: Type.Optional(Type.String({ description: 'Session title.' })),
    extra_data_json: Type.Optional(Type.String({ description: 'Opaque extra JSON string.' })),
    archived: Type.Optional(Type.Boolean({ description: 'Whether a session is archived.' })),
    before: Type.Optional(Type.String({ description: 'Message pagination cursor.' })),
    // drive
    parent_id: Type.Optional(Type.String({ description: 'Drive parent node id; empty string means root.' })),
    node_type: Type.Optional(Type.Union([Type.Literal('Folder'), Type.Literal('File')])),
    node_id: Type.Optional(Type.String({ description: 'Drive node id.' })),
    keyword: Type.Optional(Type.String({ description: 'Search keyword.' })),
    category: Type.Optional(Type.String({ description: 'Drive file category filter.' })),
    source: Type.Optional(Type.Union([
        Type.Literal('UserUpload'),
        Type.Literal('AgentDeliverable'),
        Type.Literal('SystemGenerated'),
    ])),
    is_favorited: Type.Optional(Type.Boolean({ description: 'Favorite filter.' })),
    new_parent_id: Type.Optional(Type.String({ description: 'New drive parent node id.' })),
}, {
    additionalProperties: true,
    description: 'Subcommand-specific arguments object. This schema lists the known field superset; dispatcher validates exact fields for the selected command.',
});
export const MavisBaseToolDef = {
    name: 'mavis',
    operationClassifier: createMavisOperationClassifier(CLOUD_MAVIS_COMMANDS),
    description: `CLI-style management tool for Mavis Agent. Run agent / drive CRUD on behalf of the current user. Session list, get, update, and messages are standalone on-demand tools: search for session_* with tool_search, then call mcp_invoke. For sending messages to peer sessions use the standalone \`communicate\` tool; for team plans use the standalone \`team\` tool.

USAGE
  mavis({ command: "<group> <action> [subaction]", args: { ... } })

  Each group exposes a small set of high-frequency commands inline below.
  Less-used commands (update / delete / trigger / sessions / rename / move, ...)
  are NOT listed inline — call \`mavis({ command: "<group> help" })\` to get
  the full per-group spec (args + examples) on demand. \`-h\` is accepted as
  an alias for \`help\` (e.g. \`agent -h\` ≡ \`agent help\`).

GROUPS (high-frequency commands shown; call \`<group> help\` for the rest)

agent — your roster
  agent list      args: { cursor?: string, limit?: number }
  agent get       args: { agent_name: string }
  agent create    args: { name: string, system_prompt?: string, persona?: string, description?: string, avatar?: string }
  agent update    args: { agent_name: string, new_name?: string, system_prompt?: string, persona?: string, description?: string, avatar?: string }
  agent delete    args: { agent_name: string }

session — conversations
  Moved to on-demand tools session_list, session_get, session_update, session_messages.
  Search for session_* with tool_search, then call mcp_invoke.
  session help      → same migration note

drive — files, folders, websites, quota
  drive files list         args: { parent_id?: string (empty=root), node_type?: "Folder"|"File", offset?: number, limit?: number }
  drive files get          args: { node_id: string }
  drive files delete       args: { node_id: string }
  drive files search       args: { keyword?: string, category?: "documents"|"excel"|"ppt"|"images"|"videos"|"audio"|"other", source?: "UserUpload"|"AgentDeliverable"|"SystemGenerated", session_id?: string, offset?: number, limit?: number, is_favorited?: boolean }
  drive files download     args: { node_id: string }              → returns { download_url }
  drive help               → list nodes move / nodes rename and their args

OUTPUT
  Success: { ok: true, command, response: <archon-server response object> }
  Failure: { ok: false, command, error: { kind: "validation"|"archon_server"|"oss_upload"|"workspace"|"unknown", message: string, ...details } }
  Help:    { ok: true, command, response: { group, summary, commands: [{ command, summary, args: [...], examples: [...] }] } }

ID fields (task_id, template_id, plan_id, node_id, ...) are always JSON strings to preserve snowflake int64 precision — never pass them as numbers.

"me" SHORTHAND
  For self-referential calls you can pass the literal string "me" instead of looking up your own ids:
    - agent_name: "me"                        → current agent's display_name
    - session_id / parent_session_id: "me"    → current session
  Other id fields (task_id, node_id, plan_id, template_id, ...) do NOT accept "me".

EXAMPLES
  mavis({ command: "agent list", args: { limit: 20 } })
  mavis({ command: "agent get", args: { agent_name: "me" } })
  mavis({ command: "drive files list", args: { parent_id: "" } })
  mavis({ command: "agent help" })                  // expand agent update / delete spec`,
    schema: Type.Object({
        command: Type.String({
            description: 'Subcommand in "<group> <action> [subaction]" form, e.g. "agent list", "drive files list", "agent help". Call "<group> help" (or "<group> -h") for less-used commands not listed inline. Session tools are session_list, session_get, session_update, and session_messages. Team plans use the standalone `team` tool; sending messages to peers uses the standalone `communicate` tool.',
        }),
        args: Type.Optional(MavisArgsSchema),
    }),
};
//# sourceMappingURL=mavis-tool-def.js.map