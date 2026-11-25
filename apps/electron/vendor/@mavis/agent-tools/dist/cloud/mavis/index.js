/**
 * DofldTool —— `mavis` LLM 工具的 cloud 实现。
 *
 * 单一职责:把 LLM 传入的 `{ command, args }` 透给 `dispatchDofld`,把
 * `DofldOutput` 走 `toToolResult` wrap 成 ToolResult。
 *
 * 构造时持有的 deps:
 *   - `archonServer`: 完整 `ArchonServerAdapter`,通过 `callRpc` 访问 archon-server
 *     27 个管理 RPC。注意这是 full adapter,跟 cloud-bash 用的 ShellExecutor narrow
 *     不同 —— `tools/index.ts` 在 `buildCloudToolRegistry` 时传 full adapter 进来。
 *   - `workspaceRoot`: sandbox workspace 绝对路径,upload 命令读 local file 用。
 *   - `teamRuntime`: 可选;启用 team plan engine 时由 `startCloudRuntime` 注入。
 *     `team plan ...` 子命令通过它访问 `CycleEngine` / `PlanStore`;缺失时该组
 *     子命令直接返回 structured failure(team engine 未启用)。
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
import { bindTool, withProgrammaticResult, } from '@mavis/agent-core/tools';
import { ThinkingLevel } from '@mavis/protocol';
import { isPtcChildCall } from '../../desktop/output-limit.js';
import { normalizeMavisCommand } from '../../shared/mavis-operation-classifier.js';
import { isMavisTeamCommand, teamDisabledFailure } from './commands/team.js';
import { dispatchDofld } from './dispatcher.js';
import { CLOUD_MAVIS_COMMANDS, MavisBaseToolDef } from './mavis-tool-def.js';
import { toToolResult } from './output.js';
let DofldTool = (() => {
    let _classDecorators = [bindTool(MavisBaseToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var DofldTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            DofldTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        deps;
        constructor(deps) {
            this.deps = deps;
        }
        async execute(ctx, input, signal) {
            return withMavisChildData(ctx, await this.dispatch(ctx, input, signal));
        }
        async dispatch(ctx, input, signal) {
            const normalized = normalizeMavisCommand(input.command);
            // Trusted session policy wins before every compatibility redirect and the
            // command whitelist, so a disabled session always gets a stable TEAM_DISABLED.
            const teamDisabled = ctx.parentAgentConfig?.team?.disabled === true;
            if (teamDisabled && isMavisTeamCommand(normalized)) {
                return toToolResult(teamDisabledFailure(normalized));
            }
            if (normalized === 'session list' ||
                normalized === 'session get' ||
                normalized === 'session update' ||
                normalized === 'session messages') {
                const text = JSON.stringify({
                    ok: false,
                    command: normalized,
                    error: {
                        kind: 'validation',
                        code: 'SESSION_TOOL_MOVED',
                        message: isCallableInRunCode(ctx, 'session_list')
                            ? SESSION_TOOLS_RUN_CODE
                            : SESSION_TOOLS_MCP_INVOKE,
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            if (normalized === 'session delete') {
                const text = JSON.stringify({
                    ok: false,
                    command: normalized,
                    error: {
                        kind: 'validation',
                        code: 'SESSION_DELETE_NOT_ALLOWED',
                        message: 'Deleting a session is reserved for the user. Ask the user to delete it in the app, or archive it with session update (archived: true).',
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            if (normalized.startsWith('cron ')) {
                const text = JSON.stringify({
                    ok: false,
                    error: {
                        code: 'CRON_TOOL_MOVED',
                        message: isCallableInRunCode(ctx, 'cron_read')
                            ? 'Use self_reminder for task follow-up. Search for cron_create, cron_read, cron_update or cron_delete with tool_search, then call the chosen tool inside run_code, e.g. await tools.cron_read(args).'
                            : 'Use self_reminder for task follow-up; discover Cron CRUD through tool_search and execute through mcp_invoke.',
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            const command = normalizeMavisCommand(input.command);
            if (!CLOUD_MAVIS_COMMANDS.includes(command)) {
                const text = JSON.stringify({
                    ok: false,
                    command,
                    error: {
                        kind: 'validation',
                        message: 'Unknown mavis command.',
                        known_commands: CLOUD_MAVIS_COMMANDS,
                    },
                });
                return { tool_name: 'mavis', text, content: [{ type: 'text', text }], isError: true };
            }
            const currentModel = currentCloudCronModel(ctx);
            const output = await dispatchDofld({
                archonServer: this.deps.archonServer,
                workspaceRoot: this.deps.workspaceRoot,
                sessionId: ctx.sessionId,
                toolCallId: ctx.toolCallId,
                ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
                ...(ctx.reporter ? { reporter: ctx.reporter } : {}),
                ...(currentModel ? { currentModel } : {}),
                ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
                ...(ctx.parentAgentConfig?.display_name
                    ? { agentDisplayName: ctx.parentAgentConfig.display_name }
                    : {}),
                ...(ctx.timezone ? { timezone: ctx.timezone } : {}),
                ...(this.deps.teamRuntime ? { teamRuntime: this.deps.teamRuntime } : {}),
                ...(teamDisabled ? { teamDisabled: true } : {}),
            }, input.command, input.args, signal);
            return toToolResult(withRunCodeSessionHelp(ctx, command, output));
        }
    };
    return DofldTool = _classThis;
})();
export { DofldTool };
/** session_* 的恢复提示。非 PTC 回合逐字保持原文案；help.ts 的 session help 摘要也含前一句。 */
const SESSION_TOOLS_MCP_INVOKE = 'Search for session_* with tool_search, then call mcp_invoke.';
const SESSION_TOOLS_RUN_CODE = 'Search for session_* with tool_search, then call the chosen tool inside run_code, e.g. await tools.session_list(args).';
/**
 * 本轮是 PTC 回合、且这个按需工具是 run_code 子工具时为 true（同桌面 local-mavis
 * `isCallableInRunCode`）。这时 mcp_invoke 不路由它，写着 "call mcp_invoke" 的恢复提示会把模型
 * 引向一次失败调用。ptcExecutor 只认本轮 ptcTools，非 PTC 回合恒为 false，原文案不变。
 */
function isCallableInRunCode(ctx, toolName) {
    return ctx.ptcExecutor?.getToolExecutionMode(toolName) !== undefined;
}
/** PTC 回合的 `session help`：摘要里的 mcp_invoke 一句换成 run_code 写法，其余字段不动。 */
function withRunCodeSessionHelp(ctx, command, output) {
    if (!output.ok || command !== 'session help' || !isCallableInRunCode(ctx, 'session_list')) {
        return output;
    }
    const response = output.response;
    if (response === null || typeof response !== 'object')
        return output;
    const summary = response.summary;
    if (typeof summary !== 'string' || !summary.includes(SESSION_TOOLS_MCP_INVOKE))
        return output;
    return {
        ...output,
        response: {
            ...response,
            summary: summary.replace(SESSION_TOOLS_MCP_INVOKE, SESSION_TOOLS_RUN_CODE),
        },
    };
}
/**
 * PTC 子调用的旁路数据：`r.data` 就是 `r.output` 序列化出来的那个对象本身，
 * 模型看到的 text 与 details 一字不改。run_code 说明给每个 mavis_* 子工具声明
 * `MavisData`，并附 `PTC_MAVIS_RUN_CODE_NOTE` 说明 r.data 与 r.output 是同一个
 * 对象的完整内容；云端此前没有这条旁路，程序里拿到的是 `data:{}`。
 *
 * 只给 run_code 子调用：顶层 mavis 不带 parentToolCallId，行为不变。text 解析失败
 * 或不是对象时不附数据，结果照原样返回。
 */
function withMavisChildData(ctx, result) {
    if (!isPtcChildCall(ctx))
        return result;
    const data = readMavisData(result.text);
    // Completeness: toToolResult serializes the whole command output with no
    // head+tail preview and no token cap, so a readable data object means the
    // text is the complete output. Desktop cuts mavis only through its
    // limitLocalManagementOutput head+tail, which the cloud tool never applies.
    return data
        ? withProgrammaticResult(result, { data, completeness: { truncated: false } })
        : result;
}
function readMavisData(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 冻结当前 Turn 的模型与思考选择。档位只有 runtime 知道，archon-server
 * 无法事后恢复；未设置 thinking_level 时不写 variant，交给服务端继承。
 */
export function currentCloudCronModel(ctx) {
    const model = ctx.parentAgentConfig?.model;
    if (!model)
        return undefined;
    const providerId = model.provider?.trim();
    const modelId = model.model_id?.trim();
    if (!providerId || !modelId)
        return undefined;
    const selection = { provider_id: providerId, model_id: modelId };
    const level = model.thinking_level;
    if (level == null)
        return selection;
    if (level === ThinkingLevel.OFF)
        return { ...selection, variant: 'none-thinking' };
    const effort = model.thinking_effort?.trim();
    return { ...selection, variant: 'thinking', ...(effort ? { thinking: { effort } } : {}) };
}
export { CLOUD_MAVIS_COMMANDS, createMavisBaseToolDef, MavisBaseToolDef, MavisBaseToolDefWithoutTeam, } from './mavis-tool-def.js';
//# sourceMappingURL=index.js.map