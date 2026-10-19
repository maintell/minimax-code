/**
 * mavis tool `<group> help` handlers — surface the full per-command spec
 * (args + examples) for one group on demand.
 *
 * Why a help tier: the tool description in `mavis-tool-def.ts` only shows
 * high-frequency commands inline so the static prompt stays small. Low-
 * frequency commands (`agent update`, `cron trigger`, `session delete`,
 * `drive nodes move/rename`, ...) live here — the LLM pays the token cost
 * only when it explicitly calls `mavis({ command: "<group> help" })`.
 *
 * Help OUTPUT is a structured JSON object the LLM can parse field-by-field
 * (not a markdown blob), matching the rest of mavis's output convention.
 *
 * Source of truth: this file is the single place command-level docs live
 * for the help tier. When a new low-tier command is added, register both
 * the schema/handler (the usual three-place wiring) *and* an entry in the
 * corresponding `GROUP_SPECS` constant below.
 *
 * `-h` alias is resolved upstream in dispatcher normalization, so this
 * file only sees the canonical `<group> help` form.
 */
import { failure, success } from '../output.js';
// ─── agent ──────────────────────────────────────────────────────────────
const AGENT_GROUP = {
    group: 'agent',
    summary: 'CRUD for agent definitions you own (your roster).',
    commands: [
        {
            command: 'agent list',
            summary: 'List agents owned by the current user.',
            args: [
                {
                    name: 'cursor',
                    type: 'string',
                    required: false,
                    description: 'Pagination cursor from a previous response.',
                },
                {
                    name: 'limit',
                    type: 'number',
                    required: false,
                    description: 'Page size (server-defined default).',
                },
            ],
            examples: ['mavis({ command: "agent list", args: { limit: 20 } })'],
        },
        {
            command: 'agent get',
            summary: 'Fetch one agent by display name.',
            args: [
                {
                    name: 'agent_name',
                    type: 'string',
                    required: true,
                    description: 'Display name. Pass "me" for the current agent.',
                },
            ],
            examples: ['mavis({ command: "agent get", args: { agent_name: "me" } })'],
        },
        {
            command: 'agent create',
            summary: 'Create a new agent. Either supply `agent_data` JSON inline, or seed from `template_id`.',
            args: [
                {
                    name: 'name',
                    type: 'string',
                    required: true,
                    description: 'Display name shown to the user.',
                },
                {
                    name: 'agent_data',
                    type: 'string (JSON)',
                    required: false,
                    description: 'JSON-encoded AgentConfig body. Expanded fields: `persona` (string, agent voice), `system_prompt` (string, role/task instructions), `skills` (string[], skill names), `subagent_types` (object[], override built-in subagents). Mutually exclusive with `template_id`.',
                },
                {
                    name: 'template_id',
                    type: 'string',
                    required: false,
                    description: 'Server template id to clone from.',
                },
                {
                    name: 'description',
                    type: 'string',
                    required: false,
                    description: 'One-line description for the listing UI.',
                },
                { name: 'avatar', type: 'string', required: false, description: 'Avatar URL or emoji.' },
                {
                    name: 'creation_source',
                    type: '"Manual"|"Auto"|"Builtin"',
                    required: false,
                    description: 'How this agent was created. Defaults server-side.',
                },
            ],
            examples: [
                'mavis({ command: "agent create", args: { name: "report-writer", template_id: "tpl_xxx", description: "writes weekly reports" } })',
            ],
        },
        {
            command: 'agent update',
            summary: 'Patch one agent. Only supplied fields are updated; omitted fields keep their current value.',
            args: [
                {
                    name: 'agent_name',
                    type: 'string',
                    required: true,
                    description: 'Display name of the agent to update. Pass "me" for the current agent.',
                },
                {
                    name: 'new_name',
                    type: 'string',
                    required: false,
                    description: 'Rename the agent (new display name).',
                },
                {
                    name: 'agent_data_patch',
                    type: 'object {field: string}',
                    required: false,
                    description: 'Partial AgentConfig patch. Each entry is a field path -> new value (string). Common keys: "persona", "system_prompt", "skills" (JSON-encoded string array), "subagent_types" (JSON-encoded). Unsupplied fields are unchanged.',
                },
                {
                    name: 'description',
                    type: 'string',
                    required: false,
                    description: 'New one-line description.',
                },
                {
                    name: 'avatar',
                    type: 'string',
                    required: false,
                    description: 'New avatar URL or emoji.',
                },
            ],
            examples: [
                'mavis({ command: "agent update", args: { agent_name: "me", description: "updated weekly-report writer" } })',
                'mavis({ command: "agent update", args: { agent_name: "report-writer", agent_data_patch: { persona: "concise, data-driven" } } })',
            ],
        },
        {
            command: 'agent delete',
            summary: 'Delete one agent by display name. Sessions owned by the agent are NOT deleted automatically.',
            args: [
                {
                    name: 'agent_name',
                    type: 'string',
                    required: true,
                    description: 'Display name. Cannot use "me" — confirm the target name first.',
                },
            ],
            examples: ['mavis({ command: "agent delete", args: { agent_name: "report-writer" } })'],
        },
    ],
};
// ─── cron ───────────────────────────────────────────────────────────────
const CRON_PROJECT_DESCRIPTION = 'Project name or ID; defaults to current session project. If the specified project cannot be found, ask the user to confirm creating it in the UI, choosing an existing project, or changing the assignment. Wait for confirmation; never silently omit or replace project and retry.';
const CRON_GROUP = {
    group: 'cron',
    summary: 'Scheduled tasks (cron expressions in the user timezone). Each task can fire into a new or existing session.',
    commands: [
        {
            command: 'cron list',
            summary: 'List cron tasks, optionally filtered by agent.',
            args: [
                {
                    name: 'agent_name',
                    type: 'string',
                    required: false,
                    description: 'Filter by owning agent. "me" supported.',
                },
                { name: 'cursor', type: 'string', required: false, description: 'Pagination cursor.' },
                { name: 'limit', type: 'number', required: false, description: 'Page size.' },
            ],
            examples: ['mavis({ command: "cron list", args: { agent_name: "me" } })'],
        },
        {
            command: 'cron get',
            summary: 'Fetch one cron task by id.',
            args: [
                {
                    name: 'task_id',
                    type: 'string',
                    required: true,
                    description: 'Cron task id (JSON string to preserve int64 precision).',
                },
            ],
            examples: ['mavis({ command: "cron get", args: { task_id: "729..." } })'],
        },
        {
            command: 'cron create',
            summary: 'Create recurrence requested by the user; it remains active until disabled or deleted. It may periodically re-check external state with no completion signal; state when to report and delete it.',
            args: [
                {
                    name: 'agent_name',
                    type: 'string',
                    required: false,
                    description: 'Required for new sessions and for a dedicated conversation ("fixed"); omit for real sessionId targets, which determine the owner.',
                },
                {
                    name: 'cron_name',
                    type: 'string',
                    required: true,
                    description: "User-visible task title in natural language. Use spaces or the user's language; do not convert it to kebab-case or another identifier form.",
                },
                {
                    name: 'schedule',
                    type: 'string',
                    required: true,
                    description: 'Cron expression in user TZ, e.g. "0 9 * * *".',
                },
                {
                    name: 'prompt',
                    type: 'string',
                    required: true,
                    description: 'Prompt body delivered when the task fires.',
                },
                {
                    name: 'project',
                    type: 'string',
                    required: false,
                    description: CRON_PROJECT_DESCRIPTION,
                },
                {
                    name: 'model',
                    type: 'string',
                    required: false,
                    description: 'provider/model_id override. When omitted, persist the current turn model.',
                },
                {
                    name: 'timezone',
                    type: 'string',
                    required: false,
                    description: 'IANA timezone; defaults to the current turn.',
                },
                {
                    name: 'active_hours',
                    type: 'object { start, end }',
                    required: false,
                    description: 'Restrict fires to a daily window. Both `start` and `end` are "HH:MM" 24h strings.',
                },
                {
                    name: 'session',
                    type: 'object { mode, session_id?, keep_sessions? }',
                    required: false,
                    description: 'Where the prompt is delivered. Omitted defaults to "new" (always spawn a fresh session). "sessionId" with session_id "fixed" gives the task its own conversation that every run reuses and requires agent_name; "sessionId" with a real session ID binds an existing conversation and omits agent_name. "me" is rejected here. `keep_sessions` caps how many fired sessions are retained.',
                },
                {
                    name: 'enabled',
                    type: 'boolean',
                    required: false,
                    description: 'Default true. Set false to register but pause.',
                },
            ],
            examples: [
                'mavis({ command: "cron create", args: { agent_name: "me", cron_name: "Daily report", schedule: "0 9 * * *", prompt: "produce the daily report" } })',
            ],
        },
        {
            command: 'cron once',
            summary: 'Schedule one future Agent turn. Exactly one of after/at is required.',
            args: [
                {
                    name: 'after',
                    type: 'string',
                    required: false,
                    description: 'Relative delay, such as 10m.',
                },
                {
                    name: 'at',
                    type: 'string|number',
                    required: false,
                    description: 'Future Unix ms or date/time.',
                },
                {
                    name: 'agent_name',
                    type: 'string',
                    required: false,
                    description: 'Required for new sessions and for a dedicated conversation ("fixed"); omit for a real sessionId target, which determines the owner.',
                },
                {
                    name: 'session',
                    type: 'object',
                    required: false,
                    description: 'new (default), sessionId with "fixed" for a dedicated reused conversation, or sessionId with a real session ID.',
                },
                {
                    name: 'prompt',
                    type: 'string',
                    required: true,
                    description: 'Instructions for the future turn.',
                },
                {
                    name: 'cron_name',
                    type: 'string',
                    required: false,
                    description: 'Natural-language task title.',
                },
                {
                    name: 'timezone',
                    type: 'string',
                    required: false,
                    description: 'IANA timezone; defaults to current turn.',
                },
                {
                    name: 'model',
                    type: 'string',
                    required: false,
                    description: 'provider/model_id; defaults to current turn model.',
                },
                {
                    name: 'project',
                    type: 'string',
                    required: false,
                    description: CRON_PROJECT_DESCRIPTION,
                },
            ],
            examples: [],
        },
        {
            command: 'cron self',
            summary: 'Periodically re-check the current or specified session. State when to report and delete the task.',
            args: [
                {
                    name: 'every',
                    type: 'string',
                    required: true,
                    description: 'Interval such as 5m or cron expression.',
                },
                {
                    name: 'session_id',
                    type: 'string',
                    required: false,
                    description: 'Target session; defaults to current session.',
                },
                {
                    name: 'quiet_on_skip',
                    type: 'boolean',
                    required: false,
                    description: 'Keep skip ticks quiet; default true.',
                },
                {
                    name: 'prompt',
                    type: 'string',
                    required: true,
                    description: 'Instructions for the future turn.',
                },
                {
                    name: 'cron_name',
                    type: 'string',
                    required: false,
                    description: 'Natural-language task title.',
                },
                {
                    name: 'timezone',
                    type: 'string',
                    required: false,
                    description: 'IANA timezone; defaults to current turn.',
                },
                {
                    name: 'model',
                    type: 'string',
                    required: false,
                    description: 'provider/model_id; defaults to current turn model.',
                },
                {
                    name: 'project',
                    type: 'string',
                    required: false,
                    description: CRON_PROJECT_DESCRIPTION,
                },
            ],
            examples: [],
        },
        {
            command: 'cron update',
            summary: 'Patch a cron task. Only supplied fields change.',
            args: [
                { name: 'task_id', type: 'string', required: true, description: 'Cron task id.' },
                { name: 'schedule', type: 'string', required: false, description: 'New cron expression.' },
                { name: 'prompt', type: 'string', required: false, description: 'New prompt body.' },
                {
                    name: 'timezone',
                    type: 'string',
                    required: false,
                    description: 'IANA timezone; defaults to the current turn.',
                },
                {
                    name: 'active_hours',
                    type: 'object',
                    required: false,
                    description: 'See `cron create`.',
                },
                { name: 'session', type: 'object', required: false, description: 'See `cron create`.' },
                { name: 'enabled', type: 'boolean', required: false, description: 'Toggle on/off.' },
            ],
            examples: ['mavis({ command: "cron update", args: { task_id: "729...", enabled: false } })'],
        },
        {
            command: 'cron delete',
            summary: 'Delete one cron task. Already-fired sessions are not removed.',
            args: [{ name: 'task_id', type: 'string', required: true, description: 'Cron task id.' }],
            examples: ['mavis({ command: "cron delete", args: { task_id: "729..." } })'],
        },
        {
            command: 'cron trigger',
            summary: 'Create one persisted manual Run and return run_id.',
            args: [{ name: 'task_id', type: 'string', required: true, description: 'Cron task id.' }],
            examples: ['mavis({ command: "cron trigger", args: { task_id: "729..." } })'],
        },
        {
            command: 'cron sessions',
            summary: 'List persisted Runs and their status/session_id, including history after task deletion.',
            args: [
                { name: 'task_id', type: 'string', required: true, description: 'Cron task id.' },
                { name: 'cursor', type: 'string', required: false, description: 'Pagination cursor.' },
                { name: 'limit', type: 'number', required: false, description: 'Page size.' },
            ],
            examples: ['mavis({ command: "cron sessions", args: { task_id: "729...", limit: 10 } })'],
        },
    ],
};
// ─── session ────────────────────────────────────────────────────────────
const SESSION_GROUP = {
    group: 'session',
    summary: 'Sessions are conversations. CRUD + message history for sessions you own or are linked to.',
    commands: [
        {
            command: 'session list',
            summary: 'List sessions for an agent (default mode) or list reachable peers (`mode: "peers"`).',
            args: [
                {
                    name: 'mode',
                    type: '"peers"|"sessions"',
                    required: false,
                    description: 'Default "sessions". Use "peers" to discover reachable peer sessions for `communicate`.',
                },
                {
                    name: 'agent_name',
                    type: 'string',
                    required: false,
                    description: '(sessions mode) Filter by owning agent. "me" supported.',
                },
                {
                    name: 'parent_session_id',
                    type: 'string',
                    required: false,
                    description: '(sessions mode) Filter by parent session. "me" supported.',
                },
                {
                    name: 'archive_filter',
                    type: '"Unarchived"|"Archived"',
                    required: false,
                    description: '(sessions mode) Defaults to Unarchived.',
                },
                {
                    name: 'session_id',
                    type: 'string',
                    required: false,
                    description: '(peers mode) Required; use "me" for the current session.',
                },
                {
                    name: 'cursor',
                    type: 'string',
                    required: false,
                    description: '(sessions mode) Pagination cursor.',
                },
                {
                    name: 'limit',
                    type: 'number',
                    required: false,
                    description: '(sessions mode) Page size.',
                },
            ],
            examples: [
                'mavis({ command: "session list", args: { agent_name: "me" } })',
                'mavis({ command: "session list", args: { mode: "peers", session_id: "me" } })',
            ],
        },
        {
            command: 'session get',
            summary: 'Fetch one session by id.',
            args: [{ name: 'session_id', type: 'string', required: true, description: 'Session id.' }],
            examples: ['mavis({ command: "session get", args: { session_id: "mvs_..." } })'],
        },
        {
            command: 'session messages',
            summary: "Read recent messages of a session (history snapshot). Use this to inspect a peer's progress or to read your own past turns.",
            args: [
                {
                    name: 'session_id',
                    type: 'string',
                    required: true,
                    description: 'Session id. "me" supported.',
                },
                { name: 'limit', type: 'number', required: false, description: 'Default 20.' },
                {
                    name: 'before',
                    type: 'string',
                    required: false,
                    description: 'Opaque cursor — pass the value returned by the previous page.',
                },
            ],
            examples: ['mavis({ command: "session messages", args: { session_id: "me", limit: 50 } })'],
        },
        {
            command: 'session update',
            summary: 'Patch session metadata (rename, archive, re-home to another agent).',
            args: [
                { name: 'session_id', type: 'string', required: true, description: 'Session id.' },
                { name: 'title', type: 'string', required: false, description: 'New title.' },
                {
                    name: 'extra_data_json',
                    type: 'string (JSON)',
                    required: false,
                    description: 'Replace the metadata blob.',
                },
                {
                    name: 'agent_name',
                    type: 'string',
                    required: false,
                    description: 'Re-home the session to another agent (display name).',
                },
                { name: 'archived', type: 'boolean', required: false, description: 'Archive / unarchive.' },
            ],
            examples: [
                'mavis({ command: "session update", args: { session_id: "mvs_...", archived: true } })',
            ],
        },
        {
            command: 'session delete',
            summary: 'Delete a session. Irreversible — messages and metadata are removed.',
            args: [
                {
                    name: 'session_id',
                    type: 'string',
                    required: true,
                    description: 'Session id. Cannot use "me".',
                },
            ],
            examples: ['mavis({ command: "session delete", args: { session_id: "mvs_..." } })'],
        },
    ],
};
// ─── drive ──────────────────────────────────────────────────────────────
const DRIVE_GROUP = {
    group: 'drive',
    summary: 'User drive — files, folders, websites, quota.',
    commands: [
        {
            command: 'drive files list',
            summary: 'List files / folders under a parent (empty parent = root).',
            args: [
                {
                    name: 'parent_id',
                    type: 'string',
                    required: false,
                    description: 'Parent folder node_id. Empty / omitted = root.',
                },
                {
                    name: 'node_type',
                    type: '"Folder"|"File"',
                    required: false,
                    description: 'Filter by node type.',
                },
                {
                    name: 'offset',
                    type: 'number',
                    required: false,
                    description: 'Offset-based pagination.',
                },
                { name: 'limit', type: 'number', required: false, description: 'Page size.' },
            ],
            examples: ['mavis({ command: "drive files list", args: { parent_id: "" } })'],
        },
        {
            command: 'drive files get',
            summary: 'Fetch one drive node (file or folder) by id.',
            args: [{ name: 'node_id', type: 'string', required: true, description: 'Drive node id.' }],
            examples: ['mavis({ command: "drive files get", args: { node_id: "drv_..." } })'],
        },
        {
            command: 'drive files delete',
            summary: 'Delete one file or folder by id (recursive for folders).',
            args: [{ name: 'node_id', type: 'string', required: true, description: 'Drive node id.' }],
            examples: ['mavis({ command: "drive files delete", args: { node_id: "drv_..." } })'],
        },
        {
            command: 'drive files search',
            summary: 'Search drive by keyword, category, source, session, or favorite flag.',
            args: [
                {
                    name: 'keyword',
                    type: 'string',
                    required: false,
                    description: 'Substring match on file name.',
                },
                {
                    name: 'category',
                    type: '"documents"|"excel"|"ppt"|"images"|"videos"|"audio"|"other"',
                    required: false,
                    description: 'Coarse category filter.',
                },
                {
                    name: 'source',
                    type: '"UserUpload"|"AgentDeliverable"|"SystemGenerated"',
                    required: false,
                    description: 'Origin filter.',
                },
                {
                    name: 'session_id',
                    type: 'string',
                    required: false,
                    description: 'Limit to files associated with this session.',
                },
                { name: 'is_favorited', type: 'boolean', required: false, description: 'Only favorites.' },
                {
                    name: 'offset',
                    type: 'number',
                    required: false,
                    description: 'Offset-based pagination.',
                },
                { name: 'limit', type: 'number', required: false, description: 'Page size.' },
            ],
            examples: [
                'mavis({ command: "drive files search", args: { keyword: "weekly-report", category: "documents" } })',
            ],
        },
        {
            command: 'drive files download',
            summary: 'Get a download URL for one file. Returns `{ download_url }`.',
            args: [
                {
                    name: 'node_id',
                    type: 'string',
                    required: true,
                    description: 'Drive node id of a File.',
                },
            ],
            examples: ['mavis({ command: "drive files download", args: { node_id: "drv_..." } })'],
        },
        {
            command: 'drive nodes move',
            summary: 'Move one node to a new parent folder. Empty `new_parent_id` = root.',
            args: [
                { name: 'node_id', type: 'string', required: true, description: 'Node to move.' },
                {
                    name: 'new_parent_id',
                    type: 'string',
                    required: true,
                    description: 'Target parent folder id. Empty string = root.',
                },
            ],
            examples: [
                'mavis({ command: "drive nodes move", args: { node_id: "drv_...", new_parent_id: "" } })',
            ],
        },
        {
            command: 'drive nodes rename',
            summary: 'Rename a drive node.',
            args: [
                { name: 'node_id', type: 'string', required: true, description: 'Node to rename.' },
                { name: 'new_name', type: 'string', required: true, description: 'New display name.' },
            ],
            examples: [
                'mavis({ command: "drive nodes rename", args: { node_id: "drv_...", new_name: "report-v2.md" } })',
            ],
        },
    ],
};
const GROUPS = {
    agent: AGENT_GROUP,
    cron: CRON_GROUP,
    session: SESSION_GROUP,
    drive: DRIVE_GROUP,
};
export const HELP_GROUPS = ['agent', 'cron', 'session', 'drive'];
function makeHelpHandler(group) {
    return async (ctx) => success(ctx.command, GROUPS[group]);
}
export const handleAgentHelp = makeHelpHandler('agent');
export const handleCronHelp = makeHelpHandler('cron');
export const handleSessionHelp = makeHelpHandler('session');
export const handleDriveHelp = makeHelpHandler('drive');
/**
 * Builds a validation failure for `<unknown> help`-style typos. Surfaces the
 * full list of valid help targets so the LLM can self-correct in one turn.
 */
export function unknownHelpGroupFailure(command, attempted) {
    return failure(command, 'validation', `unknown help target: ${JSON.stringify(attempted)}. Valid help commands: ${HELP_GROUPS.map((g) => `"${g} help"`).join(' / ')}. ("-h" is also accepted as an alias for "help".)`, { attempted, valid_targets: HELP_GROUPS.map((g) => `${g} help`) });
}
//# sourceMappingURL=help.js.map