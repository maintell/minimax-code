/**
 * desktop mavis 的子命令词表 —— 单一来源。
 *
 * 拆成独立模块是为了让 `builtin-defs.ts`（工具定义）和 `local-mavis.ts`
 * （dispatcher 实现）都能引用同一份命令清单而不产生 import 环：
 * `local-mavis.ts` 依赖 `builtin-defs.ts` 的 `LocalMavisToolDef`，所以
 * 词表不能反过来住在 dispatcher 里。
 *
 * 新增子命令需要同时更新：
 *   1. 本文件 `LOCAL_MAVIS_COMMANDS`
 *   2. `local-mavis.ts` 的 `LOCAL_MAVIS_COMMAND_SCHEMAS` 和 `HANDLERS`
 *   3. PTC 回合的去向：`PTC_MAVIS_CHILD_TOOLS` 加一项并在 `local-mavis-ptc.ts` 写说明
 *
 * `local-mavis.ts` 的类型约束会在 1 和 2 不同步时直接编译失败；3 漏掉时
 * `local-mavis-ptc.ts` 的单测失败。
 *
 * 复合 `mavis` 工具已经不在任何 Agent 的清单里，它只是这些命令的执行器。
 * 协调者（Bunny）自己的空间与任务模型命令不再是 `mavis` 子命令，它们是
 * `local-bunny-space-tools.ts` 里的独立工具，本文件只保留它们的说明词表。
 */
import { normalizeMavisCommand } from '../shared/mavis-operation-classifier.js';
import { isRegisteredPtcMavisChildToolName, ptcMavisRunCodeCall, } from '../shared/ptc-mavis-child.js';
export { ptcMavisRunCodeCall };
export const LOCAL_MAVIS_COMMANDS = [
    'agent list',
    'agent get',
    'agent create',
    'agent update',
    'agent delete',
    'agent help',
    'session list',
    'session get',
    'session send',
    'session update',
    'session interrupt',
    'session messages',
    'session help',
    'mcp list',
    'mcp get',
    'mcp create',
    'mcp update',
    'mcp delete',
    'mcp help',
];
/**
 * The task-space coordinator's (Bunny's) own operations. Each one is a
 * top-level tool of its own (`local-bunny-space-tools.ts`), listed for the
 * coordinator alone; no other Agent has them.
 */
export const BUNNY_MAVIS_COMMANDS = [
    'space list',
    'space get',
    'space create',
    'space update',
    'space context read',
    'space context write',
    'task model list',
    'task model set',
];
/**
 * What each coordinator operation does and takes: the one source of the tool
 * descriptions in `local-bunny-space-tools.ts`.
 */
export const BUNNY_MAVIS_COMMAND_DOCS = {
    'space list': {
        args: [],
        summary: '列出事项：ID、名称、目标、关联项目、进行中任务数。无参数。',
    },
    'space get': {
        args: ['space_id'],
        summary: '一个事项的详情：目标、关联项目、事项目录、事项简报（context.md）的 summary、进行中的任务、最近的资产。space_id（必填）。',
    },
    'space create': {
        args: ['name', 'goal?', 'projects? (string[])'],
        summary: '新建事项，返回 { space }。name（必填）、goal、projects。任何一轮都能调用，任务回传、定时这类系统事件唤醒的一轮也可以。',
    },
    'space update': {
        args: ['space_id', 'name?', 'goal?', 'projects? (string[])'],
        summary: '修改事项的名称、目标、关联项目，只改这三项。space_id（必填）、name、goal（同步写进 context.md 的 <goal>）、projects。instructions、decisions、next_steps 已取消：约定、已定事项、下一步改用 bunny_task_space_context_write。',
    },
    'space context read': {
        args: ['space_id'],
        summary: '读事项简报 context.md，返回 { goal, summary, revision, directory }。goal 是事项目标，summary 是简报正文（最新进展 / 推进建议 / 约定 / 已定事项 / 进展 / 待定问题 / 下一步）。space_id（必填）。',
    },
    'space context write': {
        args: ['space_id', 'summary', 'sections', 'revision', 'end_turn'],
        summary: '改写 context.md 的 <summary>（<goal> 只能用 bunny_task_space_update 改）。space_id、revision（必填，取自最近一次 bunny_task_space_context_read 的完整 12 位 revision，不要用状态块里的版本前缀）；summary（整段新的 <summary>，不含标签）和 sections（[{heading, content}]，只改这几节：heading 是标题整行，按整行匹配，一节到下一个同级或更高级标题为止，传入的一节整段替换原节；content 为空删掉这一节；找不到的标题加在末尾；“## 最新进展”“## 推进建议”两节例外，写入后总在开头，按这个顺序）只给一个。end_turn=true 时写成功后立即结束这一轮。版本不一致返回 SPACE_CONTEXT_CONFLICT，这次没有写入：错误里同时给出你传的 revision、当前 revision，以及你要改的内容现在的样子（写 sections 时是 current_sections 里这几节，写 summary 时是 current_summary 整段）。把里面的改动并进你要写的内容，用当前 revision 再写一次，不用重读。summary 有变化时返回事项里没关闭的任务 openTasks。',
    },
    'task model list': {
        args: [],
        summary: '读任务模型：current 是设置里现在的任务模型（没设过时没有这一项），models 是设置里可选的模型（name、providerId、modelId）。读不到时 models 是空数组。无参数。',
    },
    'task model set': {
        args: ['model'],
        summary: '把设置里的任务模型改成用户选的或填的模型，返回回读确认后的 { model, confirmed }。只在用户选定后调用。model（必填）：用户选的模型名或在“其他”里填的内容，原样传。只接受和可选模型的名称、模型 ID 或 provider/model 完全一致的写法；对不上返回 BUNNY_TASK_MODEL_NOT_FOUND，同名模型有多个返回 BUNNY_TASK_MODEL_AMBIGUOUS，读不到可选模型返回 BUNNY_TASK_MODEL_CATALOG_UNAVAILABLE，这三种都不保存。',
    },
};
/** Internal command vocabulary reused by the standalone Cron adapters. */
export const LOCAL_CRON_COMMANDS = [
    'cron list',
    'cron get',
    'cron resolve-model',
    'cron create',
    'cron self',
    'cron once',
    'cron update',
    'cron delete',
    'cron trigger',
    'cron sessions',
    'cron help',
];
/**
 * The Desktop mavis commands no `mavis_*` run_code tool is built for
 * (`PTC_MAVIS_CHILD_TOOLS` holds the rest). The table answers
 * `isPtcMavisDirectCommand`, which no production caller reads any more: the
 * composite `mavis` tool left every Agent's catalog and is only the executor
 * behind the namespaced tools, so there is no top-level `mavis` left for a
 * command to stay on. It is kept as the record of where each name went.
 *
 * - `agent create` and `session send` are owned by the namespaced tools
 *   `agent_create` (namespace `agent`) and `session_send` (namespace
 *   `session.dispatch`). On a PTC Turn `agent_create` is a run_code child and
 *   `session_send` is a top-level tool of its own
 *   (`PTC_TOP_LEVEL_NAMESPACED_TOOL_NAMES`); neither is reached through a
 *   top-level `mavis`. Both keep their Skill gate.
 * - `session delete` is not a mavis command at all; the executor answers it
 *   with a refusal.
 * - The coordinator's space and task-model commands are standalone top-level
 *   tools (`local-bunny-space-tools.ts`) listed for the coordinator alone, not
 *   mavis subcommands, so naming them here decides nothing.
 */
const PTC_MAVIS_DIRECT_COMMANDS = new Set([
    'agent create',
    ...BUNNY_MAVIS_COMMANDS,
    'session send',
    'session delete',
]);
/**
 * The run_code tools of a PTC Turn with the Desktop mavis tool: one per
 * command, each with that command's own argument schema (local-mavis-ptc.ts),
 * so a program sees and is checked against what each command takes instead
 * of one `mavis({ command, args })`. The help commands are not flattened.
 */
export const PTC_MAVIS_CHILD_TOOLS = [
    { name: 'mavis_agent_list', command: 'agent list' },
    { name: 'mavis_agent_get', command: 'agent get' },
    { name: 'mavis_agent_update', command: 'agent update' },
    { name: 'mavis_agent_delete', command: 'agent delete' },
    { name: 'mavis_session_list', command: 'session list' },
    { name: 'mavis_session_get', command: 'session get' },
    { name: 'mavis_session_update', command: 'session update' },
    { name: 'mavis_session_interrupt', command: 'session interrupt' },
    { name: 'mavis_session_messages', command: 'session messages' },
    { name: 'mavis_mcp_list', command: 'mcp list' },
    { name: 'mavis_mcp_get', command: 'mcp get' },
    { name: 'mavis_mcp_create', command: 'mcp create' },
    { name: 'mavis_mcp_update', command: 'mcp update' },
    { name: 'mavis_mcp_delete', command: 'mcp delete' },
];
/** The run_code tool standing for a Desktop mavis command; undefined for the top-level ones. */
export function ptcMavisChildToolName(command) {
    if (typeof command !== 'string')
        return undefined;
    const normalized = normalizeMavisCommand(command);
    return PTC_MAVIS_CHILD_TOOLS.find((entry) => entry.command === normalized)?.name;
}
/**
 * True for the names of the mavis_* run_code tools; metrics fold them into
 * `mavis`. The Desktop list is static; a Host with its own split (cloud)
 * registers its names when the catalog builds that Turn's mavis_* tools.
 */
export function isPtcMavisChildToolName(name) {
    return (PTC_MAVIS_CHILD_TOOLS.some((entry) => entry.name === name) ||
        isRegisteredPtcMavisChildToolName(name));
}
/** Desktop mavis commands a PTC Turn runs only through their mavis_* run_code tool. */
export function isPtcMavisProgrammaticCommand(command) {
    return ptcMavisChildToolName(command) !== undefined;
}
/** Desktop mavis commands that stay on the top-level mavis tool of a PTC Turn. */
export function isPtcMavisDirectCommand(command) {
    return (typeof command === 'string' && PTC_MAVIS_DIRECT_COMMANDS.has(normalizeMavisCommand(command)));
}
/**
 * The run_code tool of `command` when this Turn's run_code lists it (the
 * executor resolves only names its run_code registered). Undefined on every
 * other Turn, so the mavis tool keeps its wording there byte for byte.
 */
export function ptcMavisRunCodeTool(ctx, command) {
    const name = ptcMavisChildToolName(command);
    return name && ctx.ptcExecutor?.getToolExecutionMode(name) !== undefined ? name : undefined;
}
/**
 * Help output on a PTC Turn whose run_code lists the mavis_* tools: each
 * flattened command names its run_code call and its examples use it, so the
 * model does not copy a `mavis({ command })` call the top level refuses.
 * Every other Turn gets the output unchanged.
 */
export function ptcMavisHelpOutput(ctx, output) {
    if (!output.ok || !output.command.endsWith(' help') || !('response' in output))
        return output;
    const response = output.response;
    if (!isRecord(response) || !Array.isArray(response.commands))
        return output;
    let changed = false;
    const commands = response.commands.map((entry) => {
        const command = isRecord(entry) ? entry.command : undefined;
        const tool = typeof command === 'string' ? ptcMavisRunCodeTool(ctx, command) : undefined;
        if (!isRecord(entry) || !tool)
            return entry;
        changed = true;
        const examples = Array.isArray(entry.examples)
            ? entry.examples.map((example) => typeof example === 'string'
                ? example.replace(/^mavis\(\{ command: "[^"]+", args: (.*) \}\)$/u, (_, args) => ptcMavisRunCodeCall(tool, String(args)))
                : example)
            : undefined;
        return { ...entry, run_code: ptcMavisRunCodeCall(tool), ...(examples ? { examples } : {}) };
    });
    return changed ? { ...output, response: { ...response, commands } } : output;
}
/** How to archive a Session, in the form this Turn accepts. */
export function localMavisArchiveCall(_ctx) {
    return 'session_update (archived: true)';
}
const LOCAL_MAVIS_MUTATION_COMMANDS = new Set([
    'agent create',
    'agent update',
    'agent delete',
    'cron create',
    'cron self',
    'cron once',
    'cron update',
    'cron delete',
    'cron trigger',
    'session update',
    'session interrupt',
    'session send',
    'mcp create',
    'mcp update',
    'mcp delete',
    // The coordinator's own tool now, but the rule is the same: a cut response
    // never replays a write that already landed.
    'space context write',
]);
/**
 * Recovery line of a truncated mavis response; a mutation is never replayed.
 * `windowed` is set only for the coordinator, the one caller that reads a long
 * `session messages` page in windows by offset.
 *
 * `callerToolName` is the namespaced tool the call arrived through, when it did:
 * the model called `session_messages`, not `mavis`, so the line names that tool
 * again. Inside run_code it is reached as `tools.<name>`.
 */
export function mavisRecoveryInstruction(command, runCodeTool, windowed = false, callerToolName) {
    if (LOCAL_MAVIS_MUTATION_COMMANDS.has(command)) {
        return (`do not repeat the mutation command ${JSON.stringify(command)} automatically; ` +
            'inspect current state with the corresponding get/list command');
    }
    // A namespaced caller is the tool the model reached for, on either surface.
    // Otherwise a PTC Turn runs this command as its mavis_* run_code tool, the
    // only form it accepts there.
    const again = callerToolName
        ? runCodeTool
            ? `tools.${callerToolName} again inside run_code`
            : `${callerToolName} again`
        : runCodeTool
            ? `tools.${runCodeTool} again inside run_code`
            : `mavis again with command=${JSON.stringify(command)}`;
    const narrower = `call ${again} and narrower args ` +
        '(prefer a smaller limit, tighter search/filter, pagination cursor, or a specific get command); ' +
        'preserve the same logical query';
    // A long message cannot be narrowed by paging; its page is read in windows by offset.
    return windowed && command === 'session messages'
        ? `${narrower}; to read this page in full, call it again with the same args plus offset 0 and continue with the offset each window returns until the end`
        : narrower;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=local-mavis-commands.js.map