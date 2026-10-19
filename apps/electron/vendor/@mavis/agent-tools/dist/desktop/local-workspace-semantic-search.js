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
import { Type } from '@sinclair/typebox';
import { bindTool, } from '@mavis/agent-core/tools';
export const LocalWorkspaceSemanticSearchToolDef = {
    name: 'workspace_semantic_search',
    executionMode: 'parallel',
    description: 'Search the current Session workspace by meaning using its downloaded semantic index. ' +
        'Use this when the exact identifier or wording is unknown; use glob/grep/read for exact ' +
        'matches and source verification. The workspace, Session, and indexed Revision are bound ' +
        'by the desktop runtime and cannot be selected by tool input. The tool is exposed only ' +
        'when a compatible index exists for the latest captured workspace Revision.',
    schema: Type.Object({
        query: Type.String({
            minLength: 1,
            maxLength: 2_000,
            description: 'Natural-language description of the code or behavior to find.',
        }),
        top_k: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: 20,
            default: 8,
            description: 'Maximum number of ranked matches. Defaults to 8.',
        })),
        path_prefix: Type.Optional(Type.String({
            minLength: 1,
            maxLength: 1_024,
            description: "Optional workspace-relative path prefix such as 'src/' to narrow results.",
        })),
    }, { additionalProperties: false }),
};
let LocalWorkspaceSemanticSearchTool = (() => {
    let _classDecorators = [bindTool(LocalWorkspaceSemanticSearchToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalWorkspaceSemanticSearchTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalWorkspaceSemanticSearchTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        adapter;
        constructor(adapter) {
            this.adapter = adapter;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const result = await this.adapter.search(ctx, input, signal);
            const lines = result.results.length === 0
                ? ['No semantic matches found in the current workspace Revision.']
                : result.results.flatMap((match, index) => [
                    `${index + 1}. ${match.path}:${match.startLine}-${match.endLine} (score ${match.score.toFixed(4)})`,
                    match.snippet,
                ]);
            const text = lines.join('\n');
            return {
                tool_name: LocalWorkspaceSemanticSearchToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    revision_id: result.revisionId,
                    match_count: result.results.length,
                    matches: result.results,
                },
            };
        }
    };
    return LocalWorkspaceSemanticSearchTool = _classThis;
})();
export { LocalWorkspaceSemanticSearchTool };
//# sourceMappingURL=local-workspace-semantic-search.js.map