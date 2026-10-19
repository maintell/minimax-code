/**
 * matrix_batch_text_to_audio —— Pattern C 批量:跟 batch_synthesize_speech
 * 同形(N 个 AudioParams → 各自 mp3),只是 archon-server 路由不同。用
 * `slot_<i>.mp3` 占位符 + 响应里 `output_file` 回显反查 LLM 给的本地路径。
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
import { MATRIX_TOOL_PATHS, MatrixBatchTextToAudioToolDef, } from '../tool-defs.js';
import { inferAigcMimeType, registerAigcIfPresent } from '../aigc-helpers.js';
function parseSlotIndex(echoed) {
    if (typeof echoed !== 'string')
        return null;
    const m = echoed.match(/^slot_(\d+)\./);
    return m ? Number(m[1]) : null;
}
let MatrixBatchTextToAudioTool = (() => {
    let _classDecorators = [bindTool(MatrixBatchTextToAudioToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var MatrixBatchTextToAudioTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MatrixBatchTextToAudioTool = _classThis = _classDescriptor.value;
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
            const toolName = MatrixBatchTextToAudioToolDef.name;
            const path = MATRIX_TOOL_PATHS[toolName];
            const body = {
                requests: input.requests.map((r, i) => {
                    const item = {
                        text: r.text,
                        output_file: `slot_${i}.mp3`,
                    };
                    if (r.voice_id !== undefined)
                        item.voice_id = r.voice_id;
                    if (r.speed !== undefined)
                        item.speed = r.speed;
                    if (r.volume !== undefined)
                        item.volume = r.volume;
                    if (r.pitch !== undefined)
                        item.pitch = r.pitch;
                    if (r.emotion !== undefined)
                        item.emotion = r.emotion;
                    return item;
                }),
            };
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
            const successItems = Array.isArray(raw.response.success_items)
                ? raw.response.success_items
                : [];
            const failedItems = Array.isArray(raw.response.failed_items)
                ? raw.response.failed_items
                : [];
            const perRequest = input.requests.map((r, i) => ({
                index: i,
                output_file_path: r.output_file_path,
                status: 'missing',
            }));
            for (const item of successItems) {
                const idx = parseSlotIndex(item.output_file);
                if (idx === null || idx < 0 || idx >= perRequest.length)
                    continue;
                const slot = perRequest[idx];
                const url = item.output_url ?? '';
                if (!url) {
                    slot.status = 'failed';
                    slot.error = 'server reported success but output_url is empty';
                    continue;
                }
                try {
                    const dl = await downloadOutputFile(url, slot.output_file_path, this.workspaceScope, this.ossMediaClient, { ...(signal ? { signal } : {}) });
                    slot.status = 'downloaded';
                    slot.bytes = dl.bytes;
                    slot.output_file_path = dl.absolutePath;
                    // v5 AIGC watermark — register clean+visible OSS pair if mcp returned them.
                    await registerAigcIfPresent({
                        oss: { clean_oss_key: item.clean_oss_key, visible_oss_key: item.visible_oss_key },
                        absolutePath: dl.absolutePath,
                        fileName: basename(dl.absolutePath),
                        sizeBytes: dl.bytes,
                        mime: inferAigcMimeType(dl.absolutePath),
                        sessionId: ctx.sessionId,
                        toolName,
                        registerService: this.aigcRegisterServiceGetter ? this.aigcRegisterServiceGetter() : null,
                    });
                }
                catch (err) {
                    if (err instanceof FileTransferError) {
                        if (err.kind === 'path_escapes_workspace') {
                            return fileTransferFailureResult(toolName, path, err);
                        }
                        slot.status = 'failed';
                        slot.error = err.message;
                        continue;
                    }
                    throw err;
                }
            }
            for (const item of failedItems) {
                const idx = parseSlotIndex(item.output_file);
                if (idx === null || idx < 0 || idx >= perRequest.length)
                    continue;
                const slot = perRequest[idx];
                slot.status = 'failed';
                slot.error = item.error_msg ?? 'unknown server error';
            }
            const downloaded = perRequest.filter((s) => s.status === 'downloaded').length;
            const failed = perRequest.filter((s) => s.status !== 'downloaded').length;
            const text = `${downloaded}/${perRequest.length} succeeded (${failed} failed/missing).`;
            return {
                tool_name: toolName,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    path,
                    total_succeeded: downloaded,
                    total_failed: failed,
                    per_request: perRequest,
                },
            };
        }
    };
    return MatrixBatchTextToAudioTool = _classThis;
})();
export { MatrixBatchTextToAudioTool };
//# sourceMappingURL=batch-text-to-audio.js.map