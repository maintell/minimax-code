/**
 * mavis tool 命令派发中心 ——
 *   1. 校验 `args` 形状(`COMMAND_SCHEMAS[command]` zod 校验)
 *   2. 命中后转给同名 handler
 *   3. handler 抛出的任何 Error 兜底成 `unknown` failure
 *
 * **未知 command** → validation failure,error.message 列出建议(模糊匹配)+
 * 完整可用命令清单的前缀。LLM 看到 message 后通常能自我纠正。
 */
import { normalizeMavisCommand } from '../../shared/mavis-operation-classifier.js';
import { CRON_CREATE_ME_REJECTED_MESSAGE, isMeSessionSentinel, } from '../../shared/cron-schedule-input.js';
import { AgentNameResolverError, createResolverCache, resolveAgentId, resolveAgentName, } from './agent-name-resolver.js';
import { handleAgentCreate, handleAgentDelete, handleAgentGet, handleAgentList, handleAgentUpdate, } from './commands/agent.js';
// Disabled: communication group is intentionally not registered. The
// standalone `communicate` LLM tool owns this surface in cloud-runtime
// (single source of truth). Handler files are kept in tree so re-enabling
// is just uncommenting the HANDLERS entries + the matching COMMAND_SCHEMAS
// rows in schemas.ts.
// import {
//   handleCommunicationMessages,
//   handleCommunicationPeers,
//   handleCommunicationSend,
// } from './commands/communication.js';
import { handleCronCreate, handleCronOnce, handleCronSelf, handleCronDelete, handleCronGet, handleCronList, handleCronSessions, handleCronTrigger, handleCronUpdate, } from './commands/cron.js';
import { handleDriveFilesDelete, handleDriveFilesDownload, handleDriveFilesGet, handleDriveFilesList, handleDriveFilesSearch, 
// Disabled: handleDriveFilesUpload — see HANDLERS entry below.
// handleDriveFilesUpload,
handleDriveNodesMove, handleDriveNodesRename, } from './commands/drive.js';
import { handleAgentHelp, handleCronHelp, handleDriveHelp, handleSessionHelp, HELP_GROUPS, } from './commands/help.js';
import { handleSessionDelete, handleSessionGet, handleSessionList, handleSessionMessages, handleSessionUpdate, } from './commands/session.js';
import { errorToFailure, failure } from './output.js';
import { COMMAND_SCHEMAS, KNOWN_COMMANDS } from './schemas.js';
/**
 * 命令名 → handler 表。新增 subcommand 时三处同步:
 *   1. schemas.ts `COMMAND_SCHEMAS`
 *   2. 本文件 `HANDLERS`
 *   3. mavis-tool-def.ts description
 *
 * 类型用 `Record<DofldCommandName, CommandHandler<...>>` —— TypeScript 检查
 * 漏配置的 command name,但 handler 的 schema 形态用 `any` 因为不同 handler
 * 的 args 类型不同。zod 在 dispatch 时已经精确校验 + 推导,所以 `any` 在这
 * 一层是安全的。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HANDLERS = {
    'agent list': handleAgentList,
    'agent get': handleAgentGet,
    'agent create': handleAgentCreate,
    'agent update': handleAgentUpdate,
    'agent delete': handleAgentDelete,
    'agent help': handleAgentHelp,
    'cron list': handleCronList,
    'cron get': handleCronGet,
    'cron create': handleCronCreate,
    'cron once': handleCronOnce,
    'cron self': handleCronSelf,
    'cron update': handleCronUpdate,
    'cron delete': handleCronDelete,
    'cron trigger': handleCronTrigger,
    'cron sessions': handleCronSessions,
    'cron help': handleCronHelp,
    'session list': handleSessionList,
    'session get': handleSessionGet,
    'session update': handleSessionUpdate,
    'session delete': handleSessionDelete,
    'session messages': handleSessionMessages,
    'session help': handleSessionHelp,
    // Disabled: communication group — see import comment above. Standalone
    // `communicate` LLM tool owns this surface in cloud-runtime.
    // 'communication peers': handleCommunicationPeers,
    // 'communication send': handleCommunicationSend,
    // 'communication messages': handleCommunicationMessages,
    'drive files list': handleDriveFilesList,
    'drive files get': handleDriveFilesGet,
    'drive files delete': handleDriveFilesDelete,
    'drive files search': handleDriveFilesSearch,
    'drive files download': handleDriveFilesDownload,
    // Disabled: 'drive files upload' is intentionally not registered. Keeps the
    // handler + upload-flow code in tree so re-enabling is just uncommenting
    // here and in `schemas.ts` COMMAND_SCHEMAS.
    // 'drive files upload': handleDriveFilesUpload,
    'drive nodes move': handleDriveNodesMove,
    'drive nodes rename': handleDriveNodesRename,
    'drive help': handleDriveHelp,
};
/**
 * 把 args 树里所有 `agent_id` / `session_id` / `parent_session_id` 字段中值为
 * `"me"`(大小写无关、前后空白容错)的占位替换成 CloudRuntimeContext 提供的
 * 当前 agent/session id。
 *
 * - `agent_id="me"` → `String(deps.agentId)`;缺 agentId 抛 MeSubstitutionError。
 * - `session_id="me"` / `parent_session_id="me"` → `deps.sessionId`(必然存在)。
 *
 * 递归走对象/数组,覆盖 `cron create` 的 `session: { session_id: "me" }` 等嵌套
 * 场景。Cron 创建入口在替换前单独拒绝 `me`(见 `dispatchDofld`),因为把定时任务
 * 绑定到创建它的当前会话会让后续执行写错对话;其余命令保留替换能力。
 * 非 string 或非 "me" 值原样保留。
 */
class MeSubstitutionError extends Error {
    field;
    reason;
    constructor(field, reason) {
        super(`cannot resolve "me" placeholder for ${field}: ${reason}`);
        this.field = field;
        this.reason = reason;
        this.name = 'MeSubstitutionError';
    }
}
const ME_AWARE_KEYS = new Set(['agent_name', 'session_id', 'parent_session_id']);
function isMeSentinel(value) {
    return typeof value === 'string' && value.trim().toLowerCase() === 'me';
}
/** 读取创建入口的原始 `session.session_id`，供替换与校验之前的判定使用。 */
function cronCreationSessionId(rawArgs) {
    const session = rawArgs?.session;
    if (!session || typeof session !== 'object')
        return undefined;
    return session.session_id;
}
function substituteMe(value, deps, path) {
    if (Array.isArray(value)) {
        return value.map((item, idx) => substituteMe(item, deps, `${path}[${idx}]`));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, raw] of Object.entries(value)) {
            const childPath = path ? `${path}.${key}` : key;
            if (ME_AWARE_KEYS.has(key) && isMeSentinel(raw)) {
                if (key === 'agent_name') {
                    if (deps.agentDisplayName === undefined) {
                        throw new MeSubstitutionError(childPath, 'runtime context has no agentDisplayName');
                    }
                    out[key] = deps.agentDisplayName;
                }
                else {
                    // session_id / parent_session_id — sessionId is always present on DispatchDeps.
                    out[key] = deps.sessionId;
                }
                continue;
            }
            out[key] = substituteMe(raw, deps, childPath);
        }
        return out;
    }
    return value;
}
export async function dispatchDofld(deps, rawCommand, rawArgs, signal) {
    const command = normalizeCommand(rawCommand);
    if (!isKnownCommand(command)) {
        // Friendly fallback for help typos:
        //   - bare "help" / "-h"   → list the 4 group help entries
        //   - "<unknown> help"     → call out the bad group + list valid help targets
        if (command === 'help' || command.endsWith(' help')) {
            const validHelp = HELP_GROUPS.map((g) => `"${g} help"`).join(' / ');
            const detail = command === 'help'
                ? 'No top-level help — call one of the per-group helps instead.'
                : `Unknown help target: ${JSON.stringify(rawCommand)}.`;
            return failure(command, 'validation', `${detail} Valid help commands: ${validHelp}. ("-h" is also accepted as an alias for "help".)`, { valid_help_commands: HELP_GROUPS.map((g) => `${g} help`) });
        }
        return failure(command, 'validation', `unknown command: ${JSON.stringify(rawCommand)}. ` +
            `Did you mean one of: ${suggestCommands(command).join(', ')}? ` +
            `Or call \`<group> help\` (one of: ${HELP_GROUPS.map((g) => `${g} help`).join(' / ')}) for the full per-group spec.`, { known_commands: KNOWN_COMMANDS });
    }
    // Substitution below would turn `session_id: "me"` into the current session and
    // silently bind the task to the conversation creating it. The creation entry
    // rejects the old alias on the raw arguments, before any substitution happens.
    if ((command === 'cron create' || command === 'cron once') &&
        isMeSessionSentinel(cronCreationSessionId(rawArgs))) {
        return failure(command, 'validation', CRON_CREATE_ME_REJECTED_MESSAGE, {
            code: 'CRON_CREATE_ME_REJECTED',
        });
    }
    // Substitute the `"me"` sentinel on id-like keys before zod validation so
    // both validation and the handler see real ids. Failure to resolve "me"
    // (e.g. agent_id="me" when CloudRuntimeContext.agentId is missing) is a
    // validation-class failure surfaced back to the LLM with the offending path.
    let substitutedArgs;
    try {
        substitutedArgs =
            rawArgs === undefined
                ? undefined
                : substituteMe(rawArgs, deps, '');
    }
    catch (error) {
        if (error instanceof MeSubstitutionError) {
            return failure(command, 'validation', error.message, {
                field: error.field,
                reason: error.reason,
            });
        }
        throw error;
    }
    const schema = COMMAND_SCHEMAS[command];
    const parsed = schema.safeParse(substitutedArgs ?? {});
    if (!parsed.success) {
        return failure(command, 'validation', formatZodError(parsed.error), {
            issues: parsed.error.issues,
        });
    }
    // ── agent_name -> agent_id resolution ──────────────────────────────
    // Resolve LLM-facing agent_name (display_name) to the agent_id that
    // archon-server RPCs expect. Resolution happens before the handler is
    // called so every handler still receives agent_id -- zero handler changes.
    const resolverCache = createResolverCache();
    let resolvedArgs = parsed.data;
    try {
        resolvedArgs = await resolveAgentNames(deps.archonServer, parsed.data, resolverCache, signal);
    }
    catch (error) {
        if (error instanceof AgentNameResolverError) {
            return failure(command, 'validation', error.message, {
                agent_name: error.agentName,
                reason: error.reason,
            });
        }
        return errorToFailure(command, error);
    }
    const ctx = {
        command,
        archonServer: deps.archonServer,
        workspaceRoot: deps.workspaceRoot,
        sessionId: deps.sessionId,
        toolCallId: deps.toolCallId,
        ...(deps.turnId ? { turnId: deps.turnId } : {}),
        ...(deps.reporter ? { reporter: deps.reporter } : {}),
        ...(deps.currentModel ? { currentModel: deps.currentModel } : {}),
        ...(deps.timezone ? { timezone: deps.timezone } : {}),
        ...(deps.teamRuntime ? { teamRuntime: deps.teamRuntime } : {}),
    };
    try {
        const output = await HANDLERS[command](ctx, resolvedArgs, signal);
        if (output.ok) {
            output.response = await enrichResponse(output.response, resolverCache, deps.archonServer, signal);
        }
        return output;
    }
    catch (error) {
        return errorToFailure(command, error);
    }
}
/**
 * Walk the validated args object and resolve every `agent_name` field
 * (display_name string) to an `agent_id` (snowflake string).  The output
 * object replaces the key `agent_name` with `agent_id` so handlers
 * continue to receive `agent_id` with zero changes.
 */
async function resolveAgentNames(archonServer, args, cache, signal) {
    const out = {};
    for (const [key, value] of Object.entries(args)) {
        if (key === 'agent_name' && typeof value === 'string') {
            const agentId = await resolveAgentName(archonServer, value, cache, signal);
            // Convert to number for JSON serialization — archon-server IDL defines
            // agent_id as i64 and some endpoints reject string-typed integers.
            // Current snowflake IDs are within Number.MAX_SAFE_INTEGER.
            const numId = Number(agentId);
            if (!Number.isSafeInteger(numId)) {
                // Fall back to string if the ID exceeds safe integer range — this
                // shouldn't happen with current ID ranges but guards against future
                // snowflake growth.
                out['agent_id'] = agentId;
            }
            else {
                out['agent_id'] = numId;
            }
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
/**
 * Post-process the handler response before returning to LLM:
 * - Replace `agent_id` with `agent_name` (human-readable display_name)
 * - Remove raw `display_name` from Agent objects (redundant with agent_name)
 *
 * For Agent objects (which have both `agent_id` and `display_name`):
 *   → set `agent_name = display_name`, delete `agent_id` and `display_name`
 *
 * For Session/CronTask objects (which have only `agent_id`):
 *   → reverse-resolve agent_id → display_name via resolver cache, set `agent_name`, delete `agent_id`
 */
async function enrichResponse(response, cache, archonServer, signal) {
    if (Array.isArray(response)) {
        const out = [];
        for (const item of response) {
            out.push(await enrichResponse(item, cache, archonServer, signal));
        }
        return out;
    }
    if (response && typeof response === 'object') {
        const obj = response;
        const out = {};
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'agent_id' && typeof value === 'string') {
                // Check if this is an Agent object (has display_name sibling)
                if ('display_name' in obj) {
                    out['agent_name'] = obj['display_name'] ?? value;
                    // display_name will be skipped in this loop iteration below
                }
                else {
                    // Session/CronTask — reverse-resolve
                    out['agent_name'] = await resolveAgentId(archonServer, value, cache, signal);
                }
                continue;
            }
            if (key === 'display_name' && 'agent_id' in obj) {
                // Already consumed by agent_id branch above — skip
                continue;
            }
            out[key] = await enrichResponse(value, cache, archonServer, signal);
        }
        return out;
    }
    return response;
}
/**
 * 把 LLM 给的 command 字符串归一化:trim、内部空白塌缩成单空格。
 * `"  agent   list  "` → `"agent list"`,容错 LLM 拼写习惯。
 *
 * 别名:
 *   - `-h` / `--help` → `help`  (e.g. `agent -h` ≡ `agent help`)
 *   - 单独输入 `help` → `mavis help` 占位,让 unknown-command 分支返回友好提示
 *     列出所有 `<group> help` 入口。
 */
function normalizeCommand(raw) {
    return normalizeMavisCommand(raw);
}
function isKnownCommand(command) {
    return KNOWN_COMMANDS.includes(command);
}
/**
 * 模糊建议:用 share prefix 长度排序,挑 top 5。完全匹配不上时(LLM 给了离谱
 * 输入)仍能给出方向感。
 */
function suggestCommands(unknown) {
    const scored = KNOWN_COMMANDS.map((c) => ({
        name: c,
        score: sharedPrefixLen(c, unknown),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5).map((s) => s.name);
}
function sharedPrefixLen(a, b) {
    const max = Math.min(a.length, b.length);
    let i = 0;
    while (i < max && a[i] === b[i])
        i += 1;
    return i;
}
function formatZodError(error) {
    return error.issues
        .map((issue) => {
        const path = issue.path.length ? issue.path.join('.') : '<root>';
        return `${path}: ${issue.message}`;
    })
        .join('; ');
}
//# sourceMappingURL=dispatcher.js.map