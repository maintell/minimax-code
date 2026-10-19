/**
 * CloudWebFetchTool —— `web_fetch` 工具的 cloud 实现。
 *
 * 调用 archon-server `WebFetch` RPC(`/api/v1/web-fetch`)—— 服务端拉 URL →
 * HTML → markdown,用小模型按 prompt 抽取后返回文本。语义与 daemon 端
 * WebFetch 工具 1:1 对齐(IDL 注释见 archon_server.thrift §R)。
 *
 * 工具 def 在本文件就近定义 —— `web_fetch` 是 cloud-runtime 在 Network
 * capability 下挂的 host-only 工具,agent-core 不需要知道它。schema 字段名
 * 直接镜像 IDL `WebFetchReq` 的 wire 字段(`fetch_mode` 而非 camelCase),
 * 透传到 callRpc 不需要再做转换。
 *
 * 失败语义:`base_resp.status_code != 0` 时返回业务失败的 ToolResult
 * (`details.ok = false`),避免抛异常打断 turn —— 跟 mavis 工具的 archon
 * business failure 通道一致。
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
import { Buffer } from 'node:buffer';
import { Type } from '@sinclair/typebox';
import { bindTool, } from '@mavis/agent-core/tools';
import { FetchMode, } from './runtime-types.js';
const WEB_FETCH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const WebFetchToolDef = {
    name: 'web_fetch',
    description: 'Fetch URL content. Use `deep` mode only when a prior default fetch failed because of captcha, anti-bot blocking, or empty extracted content.',
    schema: Type.Object({
        url: Type.String({ description: 'URL to fetch.' }),
        prompt: Type.Optional(Type.String({
            description: 'Describe what to extract or summarize from the page. Pass this when you need extraction/summarization; omit to receive the raw page content.',
        })),
        fetch_mode: Type.Optional(Type.Union([Type.Literal('default'), Type.Literal('deep')], {
            description: 'Leave unset by default. Use `deep` only to retry a URL that previously failed extraction (captcha / anti-bot / empty content).',
        })),
    }),
};
let CloudWebFetchTool = (() => {
    let _classDecorators = [bindTool(WebFetchToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudWebFetchTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudWebFetchTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        constructor(archonServer) {
            this.archonServer = archonServer;
        }
        async execute(_ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const fetchMode = mapFetchMode(input.fetch_mode);
            const resp = await this.archonServer.callRpc('WebFetch', {
                url: input.url,
                ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
                ...(fetchMode !== undefined ? { fetch_mode: fetchMode } : {}),
            }, signal);
            const statusCode = resp.base_resp?.status_code ?? 0;
            if (statusCode !== 0) {
                const message = resp.base_resp?.status_msg ?? 'archon-server WebFetch returned non-zero status';
                return {
                    tool_name: WebFetchToolDef.name,
                    text: message,
                    content: [{ type: 'text', text: message }],
                    details: {
                        ok: false,
                        url: input.url,
                        status_code: statusCode,
                    },
                };
            }
            const content = resp.content ?? '';
            const receivedBytes = Buffer.byteLength(content, 'utf8');
            if (receivedBytes > WEB_FETCH_MAX_RESPONSE_BYTES) {
                // TODO(7062762593): replace this post-RPC guard with an archon-server-owned
                // artifact reference plus bounded search/read so the full response stays
                // available without crossing the RPC, BPE, or model-context boundaries.
                const message = `web_fetch response exceeded the safe limit (${receivedBytes} UTF-8 bytes; ` +
                    `maximum ${WEB_FETCH_MAX_RESPONSE_BYTES}). Retry with a narrower \`prompt\` or use a more specific data source.`;
                return {
                    tool_name: WebFetchToolDef.name,
                    text: message,
                    content: [{ type: 'text', text: message }],
                    details: {
                        ok: false,
                        reason: 'response_too_large',
                        url: input.url,
                        received_bytes: receivedBytes,
                        max_response_bytes: WEB_FETCH_MAX_RESPONSE_BYTES,
                    },
                };
            }
            return {
                tool_name: WebFetchToolDef.name,
                text: content,
                content: [{ type: 'text', text: content }],
                details: {
                    ok: true,
                    url: input.url,
                },
            };
        }
    };
    return CloudWebFetchTool = _classThis;
})();
export { CloudWebFetchTool };
function mapFetchMode(mode) {
    if (mode === 'deep')
        return FetchMode.Deep;
    if (mode === 'default')
        return FetchMode.Default;
    return undefined;
}
//# sourceMappingURL=cloud-webfetch.js.map