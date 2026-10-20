/**
 * matrix_image_synthesize —— Pattern D 批量:每个 request 可带参考图
 * (input_file_paths)和输出路径(output_file_path)。上传阶段失败即整 batch
 * 退;响应阶段单个 slot 下载失败只记录在 details,batch 不退。
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
import { FileTransferError, downloadOutputFile, fileTransferFailureResult, requireUploadedInputFileUrl, uploadInputFiles, } from '../file-transfer.js';
import { MATRIX_TOOL_PATHS, MatrixImageSynthesizeToolDef, } from '../tool-defs.js';
import { inferAigcMimeType, registerAigcIfPresent } from '../aigc-helpers.js';
function parseSlotIndex(echoed) {
    if (typeof echoed !== 'string')
        return null;
    const m = echoed.match(/^slot_(\d+)\./);
    return m ? Number(m[1]) : null;
}
let MatrixImageSynthesizeTool = (() => {
    let _classDecorators = [bindTool(MatrixImageSynthesizeToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var MatrixImageSynthesizeTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MatrixImageSynthesizeTool = _classThis = _classDescriptor.value;
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
            const toolName = MatrixImageSynthesizeToolDef.name;
            const path = MATRIX_TOOL_PATHS[toolName];
            // Upload phase — collect input_urls per request. Abort whole batch on failure.
            const uploadedUrlsPerRequest = [];
            try {
                for (const r of input.requests) {
                    if (r.input_file_paths && r.input_file_paths.length > 0) {
                        const up = await uploadInputFiles(r.input_file_paths, this.workspaceScope, this.ossMediaClient, { forceRemoteUrl: true });
                        uploadedUrlsPerRequest.push(up.map((u) => requireUploadedInputFileUrl(u)));
                    }
                    else {
                        uploadedUrlsPerRequest.push([]);
                    }
                }
            }
            catch (err) {
                if (err instanceof FileTransferError) {
                    return fileTransferFailureResult(toolName, path, err);
                }
                throw err;
            }
            // Build outgoing body — use input_urls only (signed); strip workspace-local paths.
            const body = {
                requests: input.requests.map((r, i) => {
                    const item = {
                        prompt: r.prompt,
                        output_file: `slot_${i}.png`,
                    };
                    if (uploadedUrlsPerRequest[i].length > 0) {
                        item.input_urls = uploadedUrlsPerRequest[i];
                    }
                    if (r.aspect_ratio !== undefined)
                        item.aspect_ratio = r.aspect_ratio;
                    if (r.resolution !== undefined)
                        item.resolution = r.resolution;
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
                if (item.text_response)
                    slot.text_response = item.text_response;
                const url = item.output_url ?? '';
                if (!url || item.has_image_output === false) {
                    slot.status = 'failed';
                    slot.error = item.text_response
                        ? `server returned text only (no image): ${item.text_response}`
                        : 'server reported success but no output_url';
                    continue;
                }
                try {
                    const dl = await downloadOutputFile(url, slot.output_file_path, this.workspaceScope, this.ossMediaClient, { ...(signal ? { signal } : {}) });
                    slot.status = 'downloaded';
                    slot.bytes = dl.bytes;
                    slot.output_file_path = dl.absolutePath;
                    // v5 AIGC watermark: when mcp returned clean (and optionally
                    // visible) OSS keys for this slot, register the pair against
                    // archon-server so the chat-side download picks the visible
                    // variant. Helper is a fail-soft no-op when the service /
                    // endpoint is unavailable.
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
                const code = item.err_code ? ` [${item.err_code}]` : '';
                slot.error = (item.error_msg ?? 'unknown server error') + code;
            }
            const downloaded = perRequest.filter((s) => s.status === 'downloaded').length;
            const failed = perRequest.filter((s) => s.status !== 'downloaded').length;
            // `details` is UI metadata, not guaranteed to reach the model. Expose the
            // actual saved paths in content so it need not reconstruct cwd-relative
            // destinations when producing Markdown or <media> links.
            const text = [
                `${downloaded}/${perRequest.length} images saved (${failed} failed/missing).`,
                ...perRequest.map((slot) => slot.status === 'downloaded'
                    ? `Saved image: ${JSON.stringify(slot.output_file_path)}`
                    : `Image ${slot.index + 1} ${slot.status}: ${slot.error ?? 'No image file was saved.'}`),
            ].join('\n');
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
    return MatrixImageSynthesizeTool = _classThis;
})();
export { MatrixImageSynthesizeTool };
//# sourceMappingURL=image-synthesize.js.map