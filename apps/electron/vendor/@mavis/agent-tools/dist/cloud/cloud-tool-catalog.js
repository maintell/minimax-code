/**
 * Cloud 工具目录的纯函数：capability → 工具名、权限策略解析、按 agent_config 过滤。
 *
 * 从 cloud-runtime `tools/index.ts`、`session/tool-catalog.ts`、
 * `session/background-task-gate.ts`(含 task 家族闸门)原样搬来，cloud-runtime 原路径改为 re-export；
 * cloud-harness-server 的宿主工具注册表复用同一套逻辑。过滤函数对工具元素只要求
 * `def.name`，两边各自的 RuntimeTool 形态都能直接传入。
 */
import { HostToolCapability } from '@mavis/protocol';
import { SPACE_TOOL_NAMES } from '../space/tool-names.js';
import { CloudBashToolDef, CloudEditToolDef, CloudGlobToolDef, CloudGrepToolDef, CloudReadToolDef, CloudTaskToolDef, CloudTodoWriteToolDef, CloudWriteToolDef, } from './builtin-defs.js';
import { CloudAskUserToolDef } from './cloud-ask-user.js';
import { CommunicateToolDef } from './cloud-communicate.js';
import { MemoryAppendToolDef, MemoryEditToolDef, MemoryReadToolDef, MemorySearchToolDef, MemorySummaryWriteToolDef, MemoryTopicAppendToolDef, MemoryTopicCreateToolDef, MemoryTopicDeleteToolDef, MemoryTopicEditToolDef, MemoryTopicReadToolDef, MemoryTopicSearchToolDef, } from './cloud-memory.js';
import { SecretToolDef } from './cloud-secret.js';
import { CLOUD_SESSION_TOOL_NAMES } from './cloud-session-tools.js';
import { SkillReadToolDef } from './cloud-skill.js';
import { GatedSyncTaskToolDef, TaskOutputToolDef, TaskQueryToolDef, TaskStopToolDef, } from './cloud-task-control.js';
import { TeamToolDef } from './cloud-team.js';
import { CloudAgentNameSyncTaskToolDef, CloudAgentNameTaskToolDef, } from './task-agent-name-defs.js';
import { WebFetchToolDef } from './cloud-webfetch.js';
import { WebsiteDeployToolDef } from './cloud-website-deploy.js';
import { MATRIX_TOOL_NAMES, getSuppressedToolNamesForModelCapabilities, } from './matrix-tools/index.js';
import { MatrixWebSearchToolDef } from './matrix-tools/tool-defs.js';
import { MavisBaseToolDef } from './mavis/mavis-tool-def.js';
// Cloud Runtime 与 Compute Sandbox 已同步启用 mcode-tools：原生 Matrix 后端只保留
// web_search，媒体 / 生成 / 理解工具统一由预装 CLI 的 Connector 提供。
const ENABLE_MCODE_TOOLS_CLOUD_TOOL_REPLACEMENT = true;
const MCODE_TOOLS_CLOUD_MATRIX_COMPAT_NAMES = new Set([MatrixWebSearchToolDef.name]);
const MCODE_TOOLS_CLOUD_OTHER_COMPAT_NAMES = [];
function getOtherCapabilityToolNames() {
    if (ENABLE_MCODE_TOOLS_CLOUD_TOOL_REPLACEMENT) {
        return MCODE_TOOLS_CLOUD_OTHER_COMPAT_NAMES;
    }
    return [...MATRIX_TOOL_NAMES];
}
/** buildMatrixTools 产出的工具中，哪些进入 Cloud 工具清单（mcode-tools 接管后只剩 web_search）。 */
export function isCloudInventoryMatrixTool(name) {
    if (!ENABLE_MCODE_TOOLS_CLOUD_TOOL_REPLACEMENT)
        return true;
    return MCODE_TOOLS_CLOUD_MATRIX_COMPAT_NAMES.has(name);
}
/**
 * Capability → 该 capability 下的 toolName 列表(单一真值)。
 *
 * Shell capability 含 `bash`(sandbox shell 执行通道) + `grep` / `glob`
 * (rg / find 走 sandbox shell,执行通道与 bash 同源)。
 * File capability 含 read / write / edit 3 个 workspace 文件读写工具;
 * `find` / `ls` 整体下线。
 * MavisBase capability 含 `mavis`(archon-server 管理 RPC)、`team`
 * (cloud team plan,archon-server `/api/v1/team/*`)、`communicate`
 * (跨 session 通讯,archon-server CommunicateRPC)三件后端服务调用入口。
 * 2026-05-28 拆分:Skill / TodoWrite / Task / Secret 4 件"基础工具"
 * 上移到 BASE capability,MAVIS_BASE 现在专门聚合 archon-server 后端 RPC 类。
 * BASE capability 含 `skill`(skill read)、`todowrite`(任务列表;同 legacy local runtime
 * `todowrite` 同名同形,调用时除走标准 `tool_execution_*` RuntimeEvent 外,
 * `CloudTodoWriteTool` 还会通过 `ctx.reporter` 注入一条 `stream.resp`
 * (内含 `MsgType.SystemEvent` + `eventType:'todo_updated'`),跟 daemon
 * 链路的 `buildTodoUpdatedEvent` 形态一致,共用 `packages/ui` 的 SystemEvent
 * 渲染分支)、`task`(sub-agent delegation,F-variant)、以及 `secret`
 * (用户级 secret CRUD,subcommand 形式 list/create/update/delete,后端调
 * archon-server `/api/v1/secrets/*` 同一组路由跟前端 UI 共用;成功后就地
 * patch turn-scoped SecretStore + 重建 SecretMasker 以挡 outbound 回显)。
 * Web capability 含 `web_fetch`(走 archon-server `/api/v1/web-fetch`,
 * 服务端抓取 URL + 按 prompt 抽取)和 `web_search`(matrix-tools 走
 * `/matrix/api/v1/mcp/web_search` 走通用搜索引擎)。`web_search` 实现
 * 仍在 `tools/matrix-tools/`,只是 capability 归属归 web 一类。
 * Other capability 不再包含 matrix-tools 媒体 / 生成 / 理解类工具，这些能力由
 * mcode-tools(Connector)接管；`ENABLE_MCODE_TOOLS_CLOUD_TOOL_REPLACEMENT=true`
 * 与 Compute Sandbox 预装保持同步。
 *
 * Memory capability 含 11 个 `memory_*` 工具 —— 5 个主 memory(read /
 * search / append / edit / summary_write)+ 6 个 topic memory
 * (topic_read / topic_create / topic_delete / topic_append / topic_edit /
 * topic_search)。底层走 archon-server `/api/v1/memory/*` RPC
 * (`GetMemory` / `SearchMemory` / `AppendMemory` / `EditMemory` /
 * `WriteMemorySummary` / `GetMemoryTopic` / `WriteMemoryTopic`(legacy RPC,
 * create-only) / `DeleteMemoryTopic` / `AppendMemoryTopic` / `EditMemoryTopic` /
 * `SearchMemoryTopics`),identity 走 `X-Archon-*` header 派生的 `base_req`。
 * `agent_id` 由 wrapper 从 ctx.agentId 派生,LLM
 * 不能直接指定(防 agent 自我冒充其他 agent 的 memory)。主 memory 工具
 * 暴露 `scope: user | agent`(write 型 user scope 强制 `reason`,daemon
 * `USER_MEMORY_REASON_REQUIRED` 对齐);topic 工具 agent-scope only。详见
 * `cloud-memory.ts` 头部 docstring。`task` delegates only to fixed system
 * subagent types advertised through `agent_config.subagent_types`.
 */
export const CAPABILITY_TO_TOOL_NAMES = {
    [HostToolCapability.SHELL]: [CloudBashToolDef.name, CloudGrepToolDef.name, CloudGlobToolDef.name],
    [HostToolCapability.FILE]: [CloudReadToolDef.name, CloudWriteToolDef.name, CloudEditToolDef.name],
    // MAVIS_BASE 现在只留 MavisBase / Team / Communicate(三件 archon-server 后端
    // 服务调用入口),其他原本挂在这里的"基础工具"已经迁到 BASE。
    [HostToolCapability.MAVIS_BASE]: [
        'self_reminder',
        'cron_create',
        'cron_read',
        'cron_update',
        'cron_delete',
        ...CLOUD_SESSION_TOOL_NAMES,
        ...SPACE_TOOL_NAMES,
        MavisBaseToolDef.name,
        TeamToolDef.name,
        CommunicateToolDef.name,
    ],
    [HostToolCapability.MEMORY]: [
        MemoryReadToolDef.name,
        MemorySearchToolDef.name,
        MemoryAppendToolDef.name,
        MemoryEditToolDef.name,
        MemorySummaryWriteToolDef.name,
        MemoryTopicReadToolDef.name,
        MemoryTopicCreateToolDef.name,
        MemoryTopicDeleteToolDef.name,
        MemoryTopicAppendToolDef.name,
        MemoryTopicEditToolDef.name,
        MemoryTopicSearchToolDef.name,
    ],
    [HostToolCapability.WEB]: [WebFetchToolDef.name, MatrixWebSearchToolDef.name],
    [HostToolCapability.OTHER]: getOtherCapabilityToolNames(),
    // BASE(IDL 2026-05-28 新增)聚合 agent 通用基础工具:Skill / TodoWrite /
    // Task(subagent 委派)/ Secret / WebsiteDeploy。这些工具不依赖
    // archon-server 后端 RPC(WebsiteDeploy 例外:它要 PublishWebsite RPC 完成
    // stage→正式 prefix rename;归 BASE 是按"agent 通用部署能力"语义归类,
    // 跟 Skill / Task / Secret 都属于"agent 自助操作 drive / 配置"一类,
    // 而不是 MAVIS_BASE 那种"调 archon-server 后端 RPC"的纯远程操作)。
    [HostToolCapability.BASE]: [
        CloudAskUserToolDef.name,
        SkillReadToolDef.name,
        CloudTodoWriteToolDef.name,
        CloudTaskToolDef.name,
        // Phase 5 background-subagent control plane — registered alongside `task`
        // so an agent with the BASE capability can query / read / stop the
        // background tasks it launched via task(run_in_background=true).
        TaskQueryToolDef.name,
        TaskOutputToolDef.name,
        TaskStopToolDef.name,
        SecretToolDef.name,
        WebsiteDeployToolDef.name,
    ],
    [HostToolCapability.CONNECTOR]: [],
};
/** Resolve a concrete runtime tool's policy; matching tool config beats global. */
export function resolveToolPermissionPolicy(agentConfig, toolName, input) {
    const effectiveToolName = toolName === 'mcp_invoke' && typeof input?.tool_name === 'string' ? input.tool_name : toolName;
    for (const entry of agentConfig.tools ?? []) {
        if (entry.enabled === false || !entry.permission_policy)
            continue;
        const matches = entry.capability === HostToolCapability.CONNECTOR
            ? (entry.connector_tools ?? []).some((tool) => tool.runtime_tool_name === effectiveToolName)
            : (CAPABILITY_TO_TOOL_NAMES[entry.capability] ?? []).includes(effectiveToolName);
        if (matches)
            return entry.permission_policy.type;
    }
    return agentConfig.permission_policy?.type;
}
/**
 * Filter the process-wide tool registry down to the RuntimeTools enabled
 * for this turn. `agent_config.tools[]` lists wire-level capability
 * entries; we walk each entry's capability through `CAPABILITY_TO_TOOL_NAMES`
 * to find the concrete tool names, then look those up in the registry.
 *
 * Empty legacy lists still fall back to the full registry. An explicit
 * `tool_list_authoritative=true` makes an empty list authoritative: zero
 * user-configurable tools, including Plugin MCP tools.
 */
export function filterToolsByConfig(registry, agentConfig) {
    const wireTools = agentConfig.tools;
    const applyModelCapabilityGate = (tools) => {
        const suppressed = getSuppressedToolNamesForModelCapabilities(agentConfig.model?.capabilities);
        if (suppressed.size === 0)
            return [...tools];
        return tools.filter((t) => !suppressed.has(t.def.name));
    };
    if (!wireTools || wireTools.length === 0) {
        if (isAuthoritativeEmptyToolList(agentConfig))
            return [];
        return applyBackgroundTaskGate(applyMemoryPolicyGate(applyModelCapabilityGate([...registry.values()]), agentConfig), agentConfig);
    }
    const enabled = [];
    const seen = new Set();
    for (const entry of wireTools) {
        if (entry.enabled === false)
            continue;
        // Apps are discovered and called through mcode-tools. Accept old backend/historical
        // configs without constructing any App tools; keep filtering the original nonempty list,
        // so CONNECTOR-only never grants Bash.
        if (entry.capability === HostToolCapability.CONNECTOR)
            continue;
        for (const name of CAPABILITY_TO_TOOL_NAMES[entry.capability] ?? []) {
            if (seen.has(name))
                continue;
            const bound = registry.get(name);
            if (!bound)
                continue;
            seen.add(name);
            enabled.push(bound);
        }
    }
    return applyBackgroundTaskGate(applyMemoryPolicyGate(applyModelCapabilityGate(enabled), agentConfig), agentConfig);
}
/**
 * 本 agent_config 保留的 core tools(SHELL 的 bash / grep / glob 与 FILE 的 read / write / edit)。
 * 与云端宿主过滤 compute core tools 走同一个 {@link filterToolsByConfig},v2 PTC 段据此逐行渲染,
 * 不会写到本轮没有的 core tool。
 */
export function enabledCloudCoreToolNames(agentConfig) {
    const names = [
        ...CAPABILITY_TO_TOOL_NAMES[HostToolCapability.SHELL],
        ...CAPABILITY_TO_TOOL_NAMES[HostToolCapability.FILE],
    ];
    const registry = new Map(names.map((name) => [name, { def: { name } }]));
    return new Set(filterToolsByConfig(registry, agentConfig).map(({ def }) => def.name));
}
export function isAuthoritativeEmptyToolList(agentConfig) {
    return agentConfig.tool_list_authoritative === true && (agentConfig.tools?.length ?? 0) === 0;
}
/** Memory tools that change memory; the rest of the MEMORY capability only reads. */
const MEMORY_WRITE_TOOL_NAMES = new Set([
    MemoryAppendToolDef.name,
    MemoryEditToolDef.name,
    MemorySummaryWriteToolDef.name,
    MemoryTopicCreateToolDef.name,
    MemoryTopicDeleteToolDef.name,
    MemoryTopicAppendToolDef.name,
    MemoryTopicEditToolDef.name,
]);
const MEMORY_TOOL_NAMES = new Set(CAPABILITY_TO_TOOL_NAMES[HostToolCapability.MEMORY]);
/**
 * Memory gate, driven by `agent_config.memories[]` (cloud memory retirement):
 * - no `enabled=true` policy (absent or empty list): drop every memory tool;
 * - every enabled policy is `read_only=true`: keep only the read tools;
 * - otherwise (at least one enabled policy is writable): keep the catalog as is.
 */
export function applyMemoryPolicyGate(tools, agentConfig) {
    const enabled = (agentConfig.memories ?? []).filter((memory) => memory.enabled === true);
    const hidden = enabled.length === 0
        ? MEMORY_TOOL_NAMES
        : enabled.every((memory) => memory.read_only === true)
            ? MEMORY_WRITE_TOOL_NAMES
            : undefined;
    if (!hidden)
        return [...tools];
    return tools.filter((t) => !hidden.has(t.def.name));
}
/**
 * Background-task feature gate (user-level rollout).
 *
 * archon-server's assembler computes the gray-release decision (whitelist +
 * percentage over Apollo `background_task` gate config) and ships the result as
 * `AgentConfig.background_task_enabled`. When it is not strictly `true`
 * (`false` / `undefined` for pre-rollout or non-allowlisted users), for that
 * turn we:
 *   1. drop the background control-plane tools (`task_query` / `task_output` /
 *      `task_stop`) from the catalog,
 *   2. swap the `task` tool's def to the sync-only schema of its own family —
 *      `CloudTaskToolDef` to `GatedSyncTaskToolDef`, and the v2 agent_name-only
 *      `CloudAgentNameTaskToolDef` to `CloudAgentNameSyncTaskToolDef`, and
 *   3. swap the `bash` tool's def to the sync-only `CloudBashToolDef` (the
 *      registry binds the background-capable `BackgroundBashToolDef`, whose
 *      schema/description carry & encourage `run_in_background`, whenever the
 *      deployment-level flag is on).
 * so the model never sees the background entrypoints. Both impls are unchanged —
 * their `executeInBackground` carry the bypass-proof per-user backstop, since
 * tool input is not schema-stripped before `execute`.
 *
 * Scope: synchronous `task` / `bash` remain available. The background control
 * tools all live in `HostToolCapability.BASE` alongside skill_read / todo_write
 * / secret / website_deploy, so capability-level filtering cannot single them
 * out — hence this dedicated name-based gate at the catalog's exit.
 */
const BACKGROUND_CONTROL_TOOL_NAMES = new Set([
    TaskQueryToolDef.name,
    TaskOutputToolDef.name,
    TaskStopToolDef.name,
]);
/**
 * Sync-only `task` def per background-capable def, keyed by identity so the
 * registry's own family decides the swap. v1 binds `CloudTaskToolDef`, v2 binds
 * the agent_name-only `CloudAgentNameTaskToolDef`; without this the gate would
 * hand v1's `subagent_type` schema to a v2 turn.
 */
const SYNC_TASK_DEF_BY_ASYNC_DEF = new Map([
    [CloudTaskToolDef, GatedSyncTaskToolDef],
    [CloudAgentNameTaskToolDef, CloudAgentNameSyncTaskToolDef],
]);
/** v2 `task` defs take `agent_name` only: the schema has it and no `subagent_type`. */
function isAgentNameOnlyTaskDef(def) {
    const properties = def.schema
        ?.properties;
    return properties?.agent_name !== undefined && properties.subagent_type === undefined;
}
/** Falls back to the v1 sync def for defs that carry no recognizable task schema. */
function syncTaskDefFor(def) {
    return (SYNC_TASK_DEF_BY_ASYNC_DEF.get(def) ??
        (isAgentNameOnlyTaskDef(def) ? CloudAgentNameSyncTaskToolDef : GatedSyncTaskToolDef));
}
export function applyBackgroundTaskGate(tools, agentConfig) {
    if (agentConfig.background_task_enabled === true)
        return [...tools];
    return tools
        .filter((t) => !BACKGROUND_CONTROL_TOOL_NAMES.has(t.def.name))
        .map((t) => {
        if (t.def.name === CloudTaskToolDef.name) {
            return { ...t, def: syncTaskDefFor(t.def) };
        }
        // bash: registry may have bound the background-capable def (same name);
        // force the sync-only def so run_in_background is hidden from the model.
        if (t.def.name === CloudBashToolDef.name)
            return { ...t, def: CloudBashToolDef };
        return t;
    });
}
/**
 * Delegation is an interactive-primary capability, not a background-task
 * capability. Keep this complete family separate from the rollout gate so a
 * background_task_enabled flag can never re-open it for a child or direct
 * subagent turn.
 */
export const TASK_FAMILY_TOOL_NAMES = new Set([
    CloudTaskToolDef.name,
    'task_append',
    TaskQueryToolDef.name,
    TaskOutputToolDef.name,
    TaskStopToolDef.name,
]);
/** Apply the final per-turn primary-surface ceiling after every tool source is merged. */
export function applyTaskCapabilityGate(tools, taskFamilyEnabled) {
    if (taskFamilyEnabled)
        return [...tools];
    return tools.filter((tool) => !TASK_FAMILY_TOOL_NAMES.has(tool.def.name));
}
/** Only the delegation tools; task_query / task_output / task_stop stay with background tasks. */
const DELEGATION_TOOL_NAMES = new Set([CloudTaskToolDef.name, 'task_append']);
/**
 * Harness v2 per-turn ceiling: drops task / task_append when delegation is denied and keeps the
 * background-task controls, which every session with background tasks uses for its own tasks.
 */
export function applyDelegationCapabilityGate(tools, delegationEnabled) {
    if (delegationEnabled)
        return [...tools];
    return tools.filter((tool) => !DELEGATION_TOOL_NAMES.has(tool.def.name));
}
//# sourceMappingURL=cloud-tool-catalog.js.map