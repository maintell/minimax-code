/**
 * desktop mavis 的子命令词表 —— 单一来源。
 *
 * 拆成独立模块是为了让 `builtin-defs.ts`（工具定义）和 `local-mavis.ts`
 * （dispatcher 实现）都能引用同一份命令清单而不产生 import 环：
 * `local-mavis.ts` 依赖 `builtin-defs.ts` 的 `LocalMavisToolDef`，所以
 * 词表不能反过来住在 dispatcher 里。
 *
 * 新增子命令需要同时更新：
 *   1. 本文件 `LOCAL_MAVIS_COMMANDS`（所有 Agent 可见）或 `BUNNY_MAVIS_COMMANDS`（只有
 *      协调者可见，其余 Agent 调用时按未知命令拒绝）
 *   2. `local-mavis.ts` 的 `LOCAL_MAVIS_COMMAND_SCHEMAS` 和 `HANDLERS`
 *   3. `builtin-defs.ts` 里 `LocalMavisToolDef`（或协调者的 `LocalMavisCoordinatorToolDef`）
 *      `schema.properties.command.description` 的命令列表
 *   4. PTC 回合的去向：`PTC_MAVIS_CHILD_TOOLS` 加一项并在 `local-mavis-ptc.ts` 写说明，
 *      或留在顶层（`PTC_MAVIS_DIRECT_COMMANDS`，同时改顶层说明）
 *
 * `local-mavis.ts` 的类型约束会在 1 和 2 不同步时直接编译失败；4 漏掉时
 * `local-mavis-ptc.ts` 的单测失败。
 */
import { normalizeMavisCommand } from '../shared/mavis-operation-classifier.js';
import { BUNNY_MAVIS_SUMMARY, BUNNY_SHARED_MAVIS_COMMANDS, } from './local-mavis-coordinator-text.js';
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
 * Commands of the task-space coordinator (Bunny) only. They appear only in the
 * coordinator's mavis definition; for every other Agent they are unknown
 * commands, so an ordinary Agent's mavis tool stays exactly what it was before
 * Bunny.
 */
export const BUNNY_MAVIS_COMMANDS = [
    'space list',
    'space get',
    'space create',
    'space update',
    'space context read',
    'space context write',
    'project list',
    'task model list',
    'task model set',
];
/**
 * What each coordinator command does and takes: the one source of the lines in
 * the coordinator's mavis definition and of its `session help` entries.
 */
export const BUNNY_MAVIS_COMMAND_DOCS = {
    'space list': {
        args: [],
        summary: '列出任务空间：ID、名称、目标、关联项目、进行中任务数。无参数。没有 space help 命令。',
    },
    'space get': {
        args: ['space_id'],
        summary: '一个任务空间的详情：目标、关联项目、空间目录、context.md 的 summary、进行中的任务、最近的资产。space_id（必填）。',
    },
    'space create': {
        args: ['name', 'goal?', 'projects? (string[])'],
        summary: '新建任务空间，返回 { space }。name（必填）、goal、projects。只在用户回复（消息或问卷回答）的这一轮里有效；系统事件唤醒的一轮调用返回 BUNNY_SPACE_CREATE_NEEDS_USER。',
    },
    'space update': {
        args: ['space_id', 'name?', 'goal?', 'projects? (string[])'],
        summary: '修改任务空间的名称、目标、关联项目，只改这三项。space_id（必填）、name、goal（同步写进 context.md 的 <goal>）、projects。instructions、decisions、next_steps 已取消：约定、已定事项、下一步改用 space context write。',
    },
    'space context read': {
        args: ['space_id'],
        summary: '读任务空间的 context.md，返回 { goal, summary, revision, directory }。goal 是空间目标，summary 是空间现状（约定 / 已定事项 / 进展 / 待定问题 / 下一步）。space_id（必填）。',
    },
    'space context write': {
        args: ['space_id', 'summary', 'sections', 'revision', 'end_turn'],
        summary: '改写 context.md 的 <summary>（<goal> 只能用 space update 改）。space_id、revision（必填，取自最近一次 read）；summary（整段新的 <summary>，不含标签）和 sections（[{heading, content}]，只改这几节：heading 是标题整行，按整行匹配，一节到下一个同级或更高级标题为止；content 为空删掉这一节；找不到的标题加在末尾）只给一个。end_turn=true 时写成功后立即结束这一轮。版本不一致返回 SPACE_CONTEXT_CONFLICT：重读、合并用户改动后再写。summary 有变化时返回空间里没关闭的任务 openTasks。',
    },
    'project list': {
        args: [],
        summary: '列出用户在 MCode 里的全部项目：名称、路径、最近活跃时间。无参数。',
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
/**
 * Every command the coordinator's mavis lists and runs: its own space, project and task
 * model commands plus the read-only session reads. A whitelist, so a shared command added
 * to `LOCAL_MAVIS_COMMANDS` later stays out of the coordinator until it is named here.
 */
export const COORDINATOR_LISTED_MAVIS_COMMANDS = [
    ...BUNNY_MAVIS_COMMANDS,
    ...BUNNY_SHARED_MAVIS_COMMANDS,
];
const COORDINATOR_LISTED = new Set(COORDINATOR_LISTED_MAVIS_COMMANDS);
/** False for every command the coordinator's mavis withholds. */
export function isCoordinatorListedMavisCommand(command) {
    return COORDINATOR_LISTED.has(command);
}
const COMMAND_LIST_HEADER = 'Subcommand in "<group> <action>" form:';
/**
 * A `<command> — <summary>` list as the coordinator's mavis shows it: the header, its own
 * commands, then one line per shared command it lists and no line for the rest.
 */
export function coordinatorMavisCommandList(list) {
    const lines = list.split('\n');
    if (lines[0] !== COMMAND_LIST_HEADER)
        throw new Error('mavis command list has no subcommand header');
    return [
        COMMAND_LIST_HEADER,
        ...BUNNY_MAVIS_COMMANDS.map((command) => `${command} — ${BUNNY_MAVIS_COMMAND_DOCS[command].summary}`),
        ...lines.slice(1).filter((line) => isCoordinatorListedMavisCommand(line.split(' — ')[0] ?? '')),
    ].join('\n');
}
/** Paragraphs about a command group the coordinator's mavis withholds entirely. */
export const COORDINATOR_DROPPED_PARAGRAPHS = [
    'agent — local desktop agent roster',
    'mcp — current-profile MCP server settings',
];
/** Description lines that name a command the coordinator's mavis withholds. */
export const COORDINATOR_DROPPED_LINE_PREFIXES = [
    '  Use session send to deliver a message into an existing unarchived local session.',
    '  Before sending to a session on another device (source ssh, rc or cloud),',
    '  When the user asks for a new, separate or fresh session, find session_create with tool_search',
];
/** Every shared mavis description opens with this; the coordinator replaces the line. */
export const SHARED_SUMMARY_PREFIX = 'Manage MiniMax Code desktop ';
/** A description without the named paragraphs: each header, its body and the blank line that ends it. */
function withoutParagraphs(description, headers) {
    const lines = description.split('\n');
    const kept = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!headers.includes(line)) {
            kept.push(line);
            continue;
        }
        while (index + 1 < lines.length && (lines[index + 1] ?? '').trim() !== '')
            index += 1;
        if (index + 1 < lines.length)
            index += 1;
    }
    return kept.join('\n');
}
/**
 * A mavis description as the coordinator reads it: its own summary line, no agent or mcp
 * paragraph, and no line for a command it withholds. Each removal is asserted to match
 * exactly once, so a reworded shared description fails here instead of drifting.
 */
export function coordinatorMavisDescription(description) {
    const lines = description.split('\n');
    if (!lines[0]?.startsWith(SHARED_SUMMARY_PREFIX))
        throw new Error('mavis description has no shared summary line');
    // The PTC top-level description has no mcp paragraph of its own, so a dropped paragraph
    // may be absent; what must never happen is the same header twice.
    for (const header of COORDINATOR_DROPPED_PARAGRAPHS)
        if (lines.filter((line) => line === header).length > 1)
            throw new Error(`mavis description repeats the paragraph ${JSON.stringify(header)}`);
    for (const prefix of COORDINATOR_DROPPED_LINE_PREFIXES)
        if (lines.filter((line) => line.startsWith(prefix)).length !== 1)
            throw new Error(`mavis description has no single line starting ${JSON.stringify(prefix)}`);
    const kept = withoutParagraphs(lines
        .filter((line) => !COORDINATOR_DROPPED_LINE_PREFIXES.some((p) => line.startsWith(p)))
        .join('\n'), COORDINATOR_DROPPED_PARAGRAPHS).split('\n');
    kept[0] = BUNNY_MAVIS_SUMMARY;
    return kept.join('\n');
}
/** The PTC top-level paragraph naming the run_code tools that stand for mavis commands. */
export const PTC_RUN_CODE_PARAGRAPH_PREFIX = 'Listing, reading, updating, archiving, interrupting and deleting agents and sessions';
/** The run_code tools a coordinator's PTC Turn actually lists: the read-only session reads. */
export const COORDINATOR_PTC_RUN_CODE_LINE = 'Reading conversations is a set of run_code tools in this turn: ' +
    `${ptcMavisRunCodeCall('mavis_session_list', 'args')}, ` +
    `${ptcMavisRunCodeCall('mavis_session_get', 'args')} and ` +
    `${ptcMavisRunCodeCall('mavis_session_messages', 'args')}.`;
/** The coordinator's PTC top-level mavis description: its own run_code line as well. */
export function coordinatorPtcMavisDescription(description) {
    const lines = coordinatorMavisDescription(description).split('\n');
    const index = lines.findIndex((line) => line.startsWith(PTC_RUN_CODE_PARAGRAPH_PREFIX));
    if (index === -1)
        throw new Error('PTC mavis description has no run_code tools paragraph');
    lines[index] = COORDINATOR_PTC_RUN_CODE_LINE;
    return lines.join('\n');
}
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
 * On a PTC Turn every Desktop mavis command except these becomes a run_code
 * tool of its own (`PTC_MAVIS_CHILD_TOOLS`). These two start or continue other
 * work: agent create makes a new Agent with its root Session, session send
 * triggers or continues another Session's Turn. Such spawn and continue calls
 * stay top-level: when v8 kept task and task_append inside run_code only,
 * evals delegated clearly less and never continued a delegated Session, with
 * no score gain, and v9 put them back. session delete is not a command; the
 * mavis tool answers it with a refusal, which is harmless at the top level.
 * The coordinator's space and project commands also stay top-level: they have
 * no run_code tool, so a PTC Turn calls them through the top-level mavis
 * exactly as other Turns do.
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
/** True for the names of the mavis_* run_code tools; metrics fold them into `mavis`. */
export function isPtcMavisChildToolName(name) {
    return PTC_MAVIS_CHILD_TOOLS.some((entry) => entry.name === name);
}
/** Desktop mavis commands a PTC Turn runs only through their mavis_* run_code tool. */
export function isPtcMavisProgrammaticCommand(command) {
    return ptcMavisChildToolName(command) !== undefined;
}
/** Desktop mavis commands that stay on the top-level mavis tool of a PTC Turn. */
export function isPtcMavisDirectCommand(command) {
    return (typeof command === 'string' && PTC_MAVIS_DIRECT_COMMANDS.has(normalizeMavisCommand(command)));
}
/** The call a model writes inside run_code for a flattened command. */
export function ptcMavisRunCodeCall(toolName, args = '{ ... }') {
    return `await tools.${toolName}(${args})`;
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
export function localMavisArchiveCall(ctx) {
    const tool = ptcMavisRunCodeTool(ctx, 'session update');
    return tool
        ? `${ptcMavisRunCodeCall(tool, '{ session_id, archived: true }')} inside run_code`
        : 'session update (archived: true)';
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
]);
/**
 * Recovery line of a truncated mavis response; a mutation is never replayed.
 * `windowed` is set only for the coordinator, the one caller that reads a long
 * `session messages` page in windows by offset.
 */
export function mavisRecoveryInstruction(command, runCodeTool, windowed = false) {
    if (LOCAL_MAVIS_MUTATION_COMMANDS.has(command)) {
        return (`do not repeat the mutation command ${JSON.stringify(command)} automatically; ` +
            'inspect current state with the corresponding get/list command');
    }
    // A PTC Turn runs this command as its mavis_* run_code tool, the only form it accepts there.
    const again = runCodeTool
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