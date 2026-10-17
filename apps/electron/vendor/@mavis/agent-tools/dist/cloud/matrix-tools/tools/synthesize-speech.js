/**
 * matrix_synthesize_speech —— Pattern C:服务端 TTS 后返回 CDN URL,本工具
 * 把 URL 拉回 LLM 指定的 workspace 路径再交差。
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
import { basename } from 'node:path';
import { callMatrixToolRaw } from '../client.js';
import { FileTransferError, downloadOutputFile, fileTransferFailureResult, } from '../file-transfer.js';
import { MATRIX_TOOL_PATHS, MatrixSynthesizeSpeechToolDef, } from '../tool-defs.js';
import { inferAigcMimeType, registerAigcIfPresent } from '../aigc-helpers.js';
let MatrixSynthesizeSpeechTool = (() => {
    let _classDecorators = [bindTool(MatrixSynthesizeSpeechToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var MatrixSynthesizeSpeechTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MatrixSynthesizeSpeechTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        ossMediaClient;
        workspaceScope;
        aigcRegisterServiceGetter;
        constructor(archonServer, ossMediaClient, workspaceScope, aigcRegisterServiceGetter = null) {
            this.archonServer = archonServer;
            this.ossMediaClient = ossMediaClient;
            this.workspaceScope = workspaceScope;
            this.aigcRegisterServiceGetter = aigcRegisterServiceGetter;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const toolName = MatrixSynthesizeSpeechToolDef.name;
            const path = MATRIX_TOOL_PATHS[toolName];
            // Strip output_file_path before sending — server doesn't need it.
            const { output_file_path: _stripped, ...body } = input;
            const raw = await callMatrixToolRaw({
                toolName,
                path,
                input: body,
                ctx,
                archonServer: this.archonServer,
                ...(signal ? { signal } : {}),
            });
            if (!raw.ok)
                return raw.result;
            const outputUrl = typeof raw.response.output_url === 'string' ? raw.response.output_url : '';
            if (!outputUrl) {
                const err = typeof raw.response.error === 'string' ? raw.response.error : '';
                const text = `server response missing output_url${err ? ` (server error: ${err})` : '. Cannot download generated audio.'}`;
                return {
                    tool_name: toolName,
                    text,
                    content: [{ type: 'text', text }],
                    details: { ok: false, path, reason: 'missing_output_url', response: raw.response },
                };
            }
            try {
                const downloaded = await downloadOutputFile(outputUrl, input.output_file_path, this.workspaceScope, this.ossMediaClient, { ...(signal ? { signal } : {}) });
                // v5 AIGC watermark — single-output flavor: OSS keys (when present)
                // sit at the top level of the response. Same fail-soft contract.
                const cleanKey = typeof raw.response.clean_oss_key === 'string' ? raw.response.clean_oss_key : undefined;
                const visibleKey = typeof raw.response.visible_oss_key === 'string' ? raw.response.visible_oss_key : undefined;
                await registerAigcIfPresent({
                    oss: { clean_oss_key: cleanKey, visible_oss_key: visibleKey },
                    absolutePath: downloaded.absolutePath,
                    fileName: basename(downloaded.absolutePath),
                    sizeBytes: downloaded.bytes,
                    mime: inferAigcMimeType(downloaded.absolutePath),
                    sessionId: ctx.sessionId,
                    toolName,
                    registerService: this.aigcRegisterServiceGetter ? this.aigcRegisterServiceGetter() : null,
                });
                const text = `wrote ${downloaded.bytes} bytes to ${downloaded.absolutePath}.`;
                return {
                    tool_name: toolName,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        ok: true,
                        path,
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
    };
    return MatrixSynthesizeSpeechTool = _classThis;
})();
export { MatrixSynthesizeSpeechTool };
//# sourceMappingURL=synthesize-speech.js.map