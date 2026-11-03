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
import { MEMORY_TOOL_OUTPUT_MAX_BYTES } from '@mavis/shared/memory-limits';
import { LocalMemoryToolDef } from './builtin-defs.js';
import { applyDesktopTextLimit, isPtcChildCall, limitDesktopHeadTailLines, } from './output-limit.js';
import { withDesktopCompletenessReport } from './ptc-result-projection.js';
let LocalMemoryTool = (() => {
    let _classDecorators = [bindTool(LocalMemoryToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalMemoryTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalMemoryTool = _classThis = _classDescriptor.value;
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
            const result = await this.adapter.execute(ctx, input, signal);
            const toolResult = {
                tool_name: LocalMemoryToolDef.name,
                text: result.text,
                content: [{ type: 'text', text: result.text }],
                details: { kind: 'memory', ...(result.details ?? {}) },
                // A failed operation is an error result, not text that reads like memory.
                ...(result.details?.ok === false ? { isError: true } : {}),
            };
            if (isPtcChildCall(ctx)) {
                // A run_code child gets the whole text and data (see isPtcChildCall).
                const uncappedOutput = Buffer.byteLength(result.text, 'utf8') > MEMORY_TOOL_OUTPUT_MAX_BYTES;
                return withDesktopCompletenessReport(LocalMemoryToolDef.name, toolResult, {
                    ...(result.data ? { data: result.data } : {}),
                    ...(uncappedOutput ? { uncappedOutput } : {}),
                });
            }
            const limited = applyDesktopTextLimit(toolResult, limitDesktopHeadTailLines(result.text, {
                maxBytes: MEMORY_TOOL_OUTPUT_MAX_BYTES,
                notice: () => '[Memory output truncated. Narrow the memory search query or use the read tool with a file path and offset/limit to inspect more.]',
            }));
            const cut = limited.details?.desktop_output_truncation !== undefined;
            const data = result.data && (cut ? memoryMetadata(result.data) : result.data);
            return withDesktopCompletenessReport(LocalMemoryToolDef.name, limited, data ? { data } : {});
        }
    };
    return LocalMemoryTool = _classThis;
})();
export { LocalMemoryTool };
/**
 * The head+tail cut drops the middle of the text, so no content field could
 * end where the text does; only counts and sizes survive it.
 */
function memoryMetadata(data) {
    const { ok, target, operation, sizeBytes, matches, topics } = data;
    return {
        ok,
        target,
        operation,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(Array.isArray(matches) ? { matchCount: matches.length } : {}),
        ...(Array.isArray(topics) ? { topicCount: topics.length } : {}),
    };
}
//# sourceMappingURL=local-memory.js.map