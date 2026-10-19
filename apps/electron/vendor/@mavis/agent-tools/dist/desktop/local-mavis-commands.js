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
 *   2. `local-mavis.ts` 的 `COMMAND_SCHEMAS` 和 `HANDLERS`
 *   3. `builtin-defs.ts` 里 `LocalMavisToolDef.schema.properties.command.description` 的命令列表
 *
 * `local-mavis.ts` 的类型约束会在 1 和 2 不同步时直接编译失败。
 */
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
    'session delete',
    'session messages',
    'session help',
    'mcp list',
    'mcp get',
    'mcp create',
    'mcp update',
    'mcp delete',
    'mcp help',
];
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
//# sourceMappingURL=local-mavis-commands.js.map