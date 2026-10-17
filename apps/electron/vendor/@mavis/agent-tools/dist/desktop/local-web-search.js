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
import { WebSearchToolDef } from '../shared/web-search.js';
const LEGACY_MATRIX_SERVER_NAME = 'matrix';
let LocalWebSearchTool = (() => {
    let _classDecorators = [bindTool(WebSearchToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalWebSearchTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalWebSearchTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        adapter;
        constructor(adapter) {
            this.adapter = adapter;
        }
        async execute(ctx, input, signal) {
            try {
                if (signal?.aborted)
                    throw new Error('Operation aborted');
                return wrapLegacyMatrixMcpResult(await this.adapter.search(ctx, input, signal));
            }
            catch (error) {
                return wrapLegacyMatrixMcpError(error);
            }
        }
    };
    return LocalWebSearchTool = _classThis;
})();
export { LocalWebSearchTool };
function wrapLegacyMatrixMcpResult(result) {
    // Electron no longer starts the Matrix MCP process, but model-visible content and
    // Tool events must remain byte/shape compatible with the old MCP runtime adapter.
    const mcpResult = {
        content: result.content,
        isError: result.isError === true,
        _meta: {
            matrix: { server: LEGACY_MATRIX_SERVER_NAME, tool: WebSearchToolDef.name },
            ...(result.details ? { details: result.details } : {}),
            ...(result.output ? { output: result.output } : {}),
        },
    };
    return wrapLegacyMatrixMcpCallResult(result.text, mcpResult);
}
function wrapLegacyMatrixMcpError(error) {
    const text = `Matrix MCP tool failed: ${error instanceof Error ? error.message : String(error)}`;
    return wrapLegacyMatrixMcpCallResult(text, {
        content: [{ type: 'text', text }],
        isError: true,
        _meta: {
            matrix: { server: LEGACY_MATRIX_SERVER_NAME, tool: WebSearchToolDef.name },
        },
    });
}
function wrapLegacyMatrixMcpCallResult(text, mcpResult) {
    return {
        tool_name: WebSearchToolDef.name,
        text,
        content: mcpResult.content,
        isError: mcpResult.isError,
        details: {
            mcp: mcpResult,
            server: LEGACY_MATRIX_SERVER_NAME,
            tool: WebSearchToolDef.name,
        },
        output: { mcp: mcpResult },
    };
}
//# sourceMappingURL=local-web-search.js.map