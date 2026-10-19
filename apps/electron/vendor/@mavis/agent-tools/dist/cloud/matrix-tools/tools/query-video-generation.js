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
import { callMatrixToolRaw } from '../client.js';
import { downloadOutputFile, FileTransferError, fileTransferFailureResult, } from '../file-transfer.js';
import { HAILUO_23_MODEL, isH3VideoModel, MATRIX_TOOL_PATHS, MINIMAX_H3_MODEL, MatrixQueryVideoGenerationToolDef, } from '../tool-defs.js';
let MatrixQueryVideoGenerationTool = (() => {
    let _classDecorators = [bindTool(MatrixQueryVideoGenerationToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var MatrixQueryVideoGenerationTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MatrixQueryVideoGenerationTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        mediaClient;
        workspaceScope;
        constructor(archonServer, mediaClient, workspaceScope) {
            this.archonServer = archonServer;
            this.mediaClient = mediaClient;
            this.workspaceScope = workspaceScope;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const toolName = MatrixQueryVideoGenerationToolDef.name;
            const path = MATRIX_TOOL_PATHS[toolName];
            if (!isH3VideoModel(input.model) && input.model !== HAILUO_23_MODEL) {
                const text = `Invalid video query: model must be ${MINIMAX_H3_MODEL} or ${HAILUO_23_MODEL}.`;
                return {
                    tool_name: toolName,
                    text,
                    content: [{ type: 'text', text }],
                    isError: true,
                    details: { ok: false, path, reason: 'invalid_video_request' },
                };
            }
            const raw = await callMatrixToolRaw({
                toolName,
                path,
                input: { task_id: input.task_id, model: input.model },
                ctx,
                archonServer: this.archonServer,
                ...(signal ? { signal } : {}),
            });
            if (!raw.ok)
                return raw.result;
            if (raw.response.status === 'succeeded') {
                const videoUrl = typeof raw.response.video_url === 'string' ? raw.response.video_url : '';
                if (!videoUrl) {
                    const text = 'Video task succeeded but the server response did not include video_url, so no local file was written.';
                    return {
                        tool_name: toolName,
                        text,
                        content: [{ type: 'text', text }],
                        isError: true,
                        details: { ok: false, path, reason: 'missing_video_url', response: raw.response },
                    };
                }
                try {
                    const downloaded = await downloadOutputFile(videoUrl, input.output_file_path, this.workspaceScope, this.mediaClient, { ...(signal ? { signal } : {}) });
                    const text = `Video generation succeeded. Wrote ${downloaded.bytes} bytes to ${downloaded.absolutePath}.`;
                    return {
                        tool_name: toolName,
                        text,
                        content: [{ type: 'text', text }],
                        details: {
                            ok: true,
                            path,
                            response: raw.response,
                            output_file_path: downloaded.absolutePath,
                            bytes: downloaded.bytes,
                        },
                    };
                }
                catch (err) {
                    if (err instanceof FileTransferError) {
                        return fileTransferFailureResult(toolName, path, err);
                    }
                    throw err;
                }
            }
            const text = JSON.stringify(raw.response, null, 2);
            return {
                tool_name: toolName,
                text,
                content: [{ type: 'text', text }],
                details: { ok: true, path, response: raw.response },
            };
        }
    };
    return MatrixQueryVideoGenerationTool = _classThis;
})();
export { MatrixQueryVideoGenerationTool };
//# sourceMappingURL=query-video-generation.js.map