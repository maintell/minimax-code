/**
 * matrix_videos_understand —— Pattern B(batch-only):一次调用最多 5 个本地
 * 视频走 mcp-server 后端 Gemini 理解,返回 list<MediaUnderstandResult> 文本。
 * 调用方有多个视频时必须 batch 一次性传完,不要 loop 调用本工具。不下载任何
 * 产物文件。
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
import { callMatrixTool } from '../client.js';
import { FileTransferError, fileTransferFailureResult, uploadInputFiles, uploadedInputFileToMediaInfo, } from '../file-transfer.js';
import { MATRIX_TOOL_PATHS, MatrixVideosUnderstandToolDef, } from '../tool-defs.js';
let MatrixVideosUnderstandTool = (() => {
    let _classDecorators = [bindTool(MatrixVideosUnderstandToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var MatrixVideosUnderstandTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MatrixVideosUnderstandTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        ossMediaClient;
        workspaceScope;
        constructor(archonServer, ossMediaClient, workspaceScope) {
            this.archonServer = archonServer;
            this.ossMediaClient = ossMediaClient;
            this.workspaceScope = workspaceScope;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const toolName = MatrixVideosUnderstandToolDef.name;
            const path = MATRIX_TOOL_PATHS[toolName];
            try {
                const uploaded = await uploadInputFiles(input.video_info.map((it) => it.file_path), this.workspaceScope, this.ossMediaClient);
                const body = {
                    video_info: input.video_info.map((it, i) => uploadedInputFileToMediaInfo(uploaded[i], it.prompt)),
                };
                return await callMatrixTool({
                    toolName,
                    path,
                    input: body,
                    ctx,
                    archonServer: this.archonServer,
                    ...(signal ? { signal } : {}),
                });
            }
            catch (err) {
                if (err instanceof FileTransferError) {
                    return fileTransferFailureResult(toolName, path, err);
                }
                throw err;
            }
        }
    };
    return MatrixVideosUnderstandTool = _classThis;
})();
export { MatrixVideosUnderstandTool };
//# sourceMappingURL=videos-understand.js.map