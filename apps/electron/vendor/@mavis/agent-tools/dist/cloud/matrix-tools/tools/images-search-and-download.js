/**
 * matrix_images_search_and_download —— Pattern C-special:服务端按 query 列出
 * 候选图片(每 query 至多 5 张),本工具按 LLM 给的 `output_dir_path` 把每个
 * `image_url` 下载到 `<dir>/<n>.<ext>`。单张失败不阻断 batch,在 details 里
 * 汇总成功 / 失败计数。
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
import { extname } from 'node:path';
import { bindTool } from '@mavis/agent-core/tools';
import { callMatrixToolRaw } from '../client.js';
import { FileTransferError, downloadOutputFile, fileTransferFailureResult, } from '../file-transfer.js';
import { MATRIX_TOOL_PATHS, MatrixImagesSearchAndDownloadToolDef, } from '../tool-defs.js';
const FALLBACK_EXT = '.jpg';
function inferExt(url) {
    try {
        const ext = extname(new URL(url).pathname).toLowerCase();
        if (!ext || ext.length > 5)
            return FALLBACK_EXT;
        return ext;
    }
    catch {
        return FALLBACK_EXT;
    }
}
let MatrixImagesSearchAndDownloadTool = (() => {
    let _classDecorators = [bindTool(MatrixImagesSearchAndDownloadToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var MatrixImagesSearchAndDownloadTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MatrixImagesSearchAndDownloadTool = _classThis = _classDescriptor.value;
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
            const toolName = MatrixImagesSearchAndDownloadToolDef.name;
            const path = MATRIX_TOOL_PATHS[toolName];
            const body = {
                queries: input.queries.map((q) => ({
                    query: q.query,
                    ...(q.prompt !== undefined ? { prompt: q.prompt } : {}),
                })),
            };
            if (input.providers !== undefined)
                body.providers = input.providers;
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
            const results = Array.isArray(raw.response.results)
                ? raw.response.results
                : [];
            const summaries = [];
            for (let i = 0; i < input.queries.length; i++) {
                const q = input.queries[i];
                const r = results[i];
                const summary = {
                    query: q.query,
                    output_dir_path: q.output_dir_path,
                    downloaded: [],
                    failed: [],
                };
                if (r?.error)
                    summary.server_error = r.error;
                const images = Array.isArray(r?.images) ? r.images : [];
                for (let j = 0; j < images.length; j++) {
                    const url = images[j]?.image_url;
                    if (!url) {
                        summary.failed.push({ index: j, image_url: '', reason: 'missing image_url in response' });
                        continue;
                    }
                    const localPath = `${q.output_dir_path.replace(/\/+$/, '')}/${j}${inferExt(url)}`;
                    try {
                        const dl = await downloadOutputFile(url, localPath, this.workspaceScope, this.ossMediaClient, { ...(signal ? { signal } : {}) });
                        summary.downloaded.push({
                            index: j,
                            image_url: url,
                            local_path: dl.absolutePath,
                            bytes: dl.bytes,
                        });
                    }
                    catch (err) {
                        if (err instanceof FileTransferError) {
                            // Path-escape errors apply to the whole query (the dir is unsafe), so abort
                            // this query and move on; per-image network failures are recorded.
                            if (err.kind === 'path_escapes_workspace') {
                                return fileTransferFailureResult(toolName, path, err);
                            }
                            summary.failed.push({ index: j, image_url: url, reason: err.message });
                            continue;
                        }
                        throw err;
                    }
                }
                summaries.push(summary);
            }
            const totalDownloaded = summaries.reduce((acc, s) => acc + s.downloaded.length, 0);
            const totalFailed = summaries.reduce((acc, s) => acc + s.failed.length, 0);
            const text = `${totalDownloaded} image(s) saved across ` +
                `${summaries.length} query(ies); ${totalFailed} failure(s).`;
            return {
                tool_name: toolName,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ok: true,
                    path,
                    total_downloaded: totalDownloaded,
                    total_failed: totalFailed,
                    per_query: summaries,
                },
            };
        }
    };
    return MatrixImagesSearchAndDownloadTool = _classThis;
})();
export { MatrixImagesSearchAndDownloadTool };
//# sourceMappingURL=images-search-and-download.js.map