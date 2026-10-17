/**
 * matrix_image_reverse_search —— Pattern D-special:本地图片上传 OSS 后做以图
 * 搜图,服务端返回结构化结果列表(data: ReverseSearchResultItem[]),本工具
 * 把它格式化成 markdown 写到 LLM 指定路径。不下载远端文件。
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
import { callMatrixToolRaw } from '../client.js';
import { FileTransferError, fileTransferFailureResult, requireUploadedInputFileUrl, uploadInputFile, writeOutputText, } from '../file-transfer.js';
import { MATRIX_TOOL_PATHS, MatrixImageReverseSearchToolDef, } from '../tool-defs.js';
function formatMarkdown(items) {
    const lines = ['# Reverse Image Search Results', ''];
    if (items.length === 0) {
        lines.push('_No results._', '');
        return lines.join('\n');
    }
    items.forEach((it, i) => {
        const heading = `## ${i + 1}. ${it.title ?? '(untitled)'}`;
        lines.push(heading);
        if (it.link)
            lines.push(`- **Link:** ${it.link}`);
        if (it.source)
            lines.push(`- **Source:** ${it.source}`);
        if (it.image_url)
            lines.push(`- **Image:** ${it.image_url}`);
        if (it.snippet)
            lines.push(`- **Snippet:** ${it.snippet}`);
        lines.push('');
    });
    return lines.join('\n');
}
let MatrixImageReverseSearchTool = (() => {
    let _classDecorators = [bindTool(MatrixImageReverseSearchToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var MatrixImageReverseSearchTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MatrixImageReverseSearchTool = _classThis = _classDescriptor.value;
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
            const toolName = MatrixImageReverseSearchToolDef.name;
            const path = MATRIX_TOOL_PATHS[toolName];
            try {
                const uploaded = await uploadInputFile(input.image_file_path, this.workspaceScope, this.ossMediaClient, { forceRemoteUrl: true });
                const body = { image_url: requireUploadedInputFileUrl(uploaded) };
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
                const items = Array.isArray(raw.response.data)
                    ? raw.response.data
                    : [];
                const md = formatMarkdown(items);
                const written = await writeOutputText(md, input.output_file_path, this.workspaceScope);
                const text = `wrote ${items.length} result(s) (${written.bytes} bytes) to ${written.absolutePath}.`;
                return {
                    tool_name: toolName,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        ok: true,
                        path,
                        output_file_path: written.absolutePath,
                        bytes: written.bytes,
                        result_count: items.length,
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
    return MatrixImageReverseSearchTool = _classThis;
})();
export { MatrixImageReverseSearchTool };
//# sourceMappingURL=image-reverse-search.js.map