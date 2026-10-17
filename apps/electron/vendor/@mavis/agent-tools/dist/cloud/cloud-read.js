/**
 * CloudReadTool —— `read` 工具的 cloud 实现。
 *
 * 委托给 pi `createReadTool`,workspace 围栏只在 execute 入口做一次:
 * `resolveWithinWorkspace` 把 LLM 给的 path 算成绝对路径并校验在 workspace
 * 内,再把绝对路径透传给 pi。pi 内部 `resolveToCwd(absPath, cwd)` 看到
 * `isAbsolute` 直接 short-circuit,fs syscall 用的就是我们 guard 过的路径,
 * 不需要拦截 pi 的 `ReadOperations`。
 *
 * Video inline (mp4/mov/mkv/webm/flv) goes through the shared helper in
 * `../shared/read-video.ts` so the local-runtime LocalReadTool produces
 * identical `ToolResult` shapes; cloud only owns the capability gate.
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
import { CloudReadToolDef as ReadToolDef, } from './builtin-defs.js';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { assertOfficeGuard, hasOfficeGuardGate } from './office-guard.js';
import { resolveWithinWorkspace } from './path-guard.js';
import { inferReadVideoMimeType, readVideoAsToolResult } from '../shared/read-video.js';
import { checkBlockedDeviceRead, checkNonRegularFileRead, detectBinaryRead, } from '../shared/read-guards.js';
import { isPdfReadPath, readPdfAsToolResult } from '../shared/read-pdf.js';
import { isNotebookReadPath, readNotebookAsToolResult } from '../shared/read-notebook.js';
import { piReadResultToToolResult, readErrorResult } from '../shared/read-result.js';
let CloudReadTool = (() => {
    let _classDecorators = [bindTool(ReadToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudReadTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudReadTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        workspaceRoot;
        tool;
        constructor(workspaceRoot) {
            this.workspaceRoot = workspaceRoot;
            this.tool = createReadTool(workspaceRoot);
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Workspace fence stays first: every later branch (video/pdf/notebook
            // dispatch, guards, pi) must only ever see fenced absolute paths.
            const abs = await resolveWithinWorkspace(input.path, this.workspaceRoot);
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // Office direct-edit guard — engages only when archon-server downloads
            // the `office-intercept` builtin hook (Apollo `builtin_hooks` config).
            // Default OFF so cloud-runtime carries the body dormant; activation is
            // hot-toggleable from server without image rebuild. See office-guard.ts
            // header for the full activation model.
            if (hasOfficeGuardGate(ctx.parentAgentConfig)) {
                assertOfficeGuard('Read', input.path, abs);
            }
            // Device guard before anything opens the file (design doc §3): a read
            // of /dev/zero or a /proc fd alias would hang the sandbox executor.
            const deviceError = checkBlockedDeviceRead(abs);
            if (deviceError)
                return readErrorResult(ReadToolDef.name, deviceError);
            // FIFO/socket/block-device blind spot (one stat, follows symlinks): a
            // named pipe read would block the sandbox executor like /dev/zero.
            const irregularError = await checkNonRegularFileRead(abs);
            if (irregularError)
                return readErrorResult(ReadToolDef.name, irregularError);
            const videoMime = inferReadVideoMimeType(abs);
            if (videoMime) {
                return readVideoAsToolResult({
                    toolName: ReadToolDef.name,
                    absolutePath: abs,
                    mimeType: videoMime,
                    capabilities: ctx.parentAgentConfig?.model?.capabilities,
                    signal,
                });
            }
            // PDF / notebook dispatch: these never reach pi (which would read them
            // as UTF-8 garbage / raw JSON).
            if (isPdfReadPath(abs)) {
                return readPdfAsToolResult({
                    toolName: ReadToolDef.name,
                    absolutePath: abs,
                    pages: input.pages,
                    signal,
                });
            }
            if (isNotebookReadPath(abs)) {
                return readNotebookAsToolResult({ toolName: ReadToolDef.name, absolutePath: abs, signal });
            }
            // Binary guard: pi would decode anything else as UTF-8 — turn silent
            // garbage into an explicit, recoverable tool error.
            const binary = await detectBinaryRead(abs);
            if (binary.binary)
                return readErrorResult(ReadToolDef.name, binary.message);
            // pi `AgentTool.execute(toolCallId, params, signal?, onUpdate?)` 接受
            // signal 参数;FS 操作本身基本是同步的,这里把 signal 透下去主要为了
            // 对齐合约和让 read 大文件分块时也能 cooperative cancel。
            // `pages` 被剥掉:pi 的 read schema 不认识它,模型偶尔会对非 PDF 文件
            // 误传 pages。
            const { pages: _pages, ...piInput } = input;
            const res = await this.tool.execute('', { ...piInput, path: abs }, signal);
            return piReadResultToToolResult(ReadToolDef.name, res, {
                offset: input.offset,
            });
        }
    };
    return CloudReadTool = _classThis;
})();
export { CloudReadTool };
//# sourceMappingURL=cloud-read.js.map