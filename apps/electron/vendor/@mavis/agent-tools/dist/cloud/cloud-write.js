/**
 * CloudWriteTool —— `write` 工具的 cloud 实现。
 *
 * 委托给 pi `createWriteTool`,workspace 围栏只在 execute 入口做一次:
 * `resolveWithinWorkspace` 校验 LLM 给的 path 在 workspace 内,再把绝对路径
 * 透传给 pi。pi 内部 `dirname(abs)` 算出的父目录也在 workspace 内
 * (因为 abs 已被 guard),所以 mkdir + writeFile 都不会逃逸。
 *
 * pi 自带 `withFileMutationQueue` 串行化对同一 path 的写入;注入的
 * capturing writeFile 在该临界区内完成旧内容捕获与 BOM/编码保全
 * (write-capture.ts / 设计文档 write-tool-optimization.md)。
 *
 * capturing operations + pi write tool 每次 `execute` 现建现用,不做实例级
 * 缓存:本 tool 是进程级单例(`buildCloudToolRegistry`),会被 parent 与后台
 * sub-agent 共享;把 capture 绑到单次 execute 才不会让并发同路径写共享一份
 * 路径级 pending map(否则结果元数据可能串用)。构造是纯对象、无 I/O。
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
import { CloudWriteToolDef as WriteToolDef, } from './builtin-defs.js';
import { createWriteTool } from '@earendil-works/pi-coding-agent';
import { assertOfficeGuard, hasOfficeGuardGate } from './office-guard.js';
import { resolveWithinWorkspace } from './path-guard.js';
import { buildWriteToolResult, createCapturingWriteOperations } from '../shared/write-capture.js';
let CloudWriteTool = (() => {
    let _classDecorators = [bindTool(WriteToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudWriteTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudWriteTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        constructor(workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const abs = await resolveWithinWorkspace(input.path, this.workspaceRoot);
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Office direct-edit guard — engages only when archon-server downloads
            // the `office-intercept` builtin hook. See office-guard.ts header.
            if (hasOfficeGuardGate(ctx.parentAgentConfig)) {
                assertOfficeGuard('Write', input.path, abs);
            }
            // Per-execute capture context: this tool instance is a process-level
            // singleton, so an instance-level pending map would be shared across
            // concurrent writes. Bind capture to this single execute instead.
            const { operations, takeCapture } = createCapturingWriteOperations();
            const tool = createWriteTool(this.workspaceRoot, { operations });
            const res = await tool.execute('', { ...input, path: abs }, signal);
            const capture = takeCapture(abs);
            const piFallbackText = res.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n');
            // The result text names the model-provided path, not the fenced
            // absolute path — the model reconciles against its own input.
            return buildWriteToolResult(WriteToolDef.name, input.path, input.content, capture, piFallbackText);
        }
    };
    return CloudWriteTool = _classThis;
})();
export { CloudWriteTool };
//# sourceMappingURL=cloud-write.js.map