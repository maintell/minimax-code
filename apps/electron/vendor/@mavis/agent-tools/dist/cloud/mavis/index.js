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
import { bindTool } from '@mavis/agent-core/tools';
import { normalizeMavisCommand } from '../../shared/mavis-operation-classifier.js';
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
            if (input.command.trim().toLowerCase().replace(/\s+/g, ' ').startsWith('cron ')) {
                const text = JSON.stringify({
                    ok: false,
                    error: {
                        code: 'CRON_TOOL_MOVED',
                        message: 'Use self_reminder for task follow-up; discover Cron CRUD through tool_search and execute through mcp_invoke.',
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
            }, input.command, input.args, signal);
            return toToolResult(output);
        }
    };
    return DofldTool = _classThis;
})();
export { DofldTool };
export function currentCloudCronModel(ctx) {
    const providerId = ctx.parentAgentConfig?.model?.provider?.trim();
    const modelId = ctx.parentAgentConfig?.model?.model_id?.trim();
    if (!providerId || !modelId)
        return undefined;
    return { provider_id: providerId, model_id: modelId };
}
export { CLOUD_MAVIS_COMMANDS, MavisBaseToolDef } from './mavis-tool-def.js';
//# sourceMappingURL=index.js.map