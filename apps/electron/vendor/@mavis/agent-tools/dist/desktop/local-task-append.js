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
import { LocalTaskAppendToolDef } from './builtin-defs.js';
let LocalTaskAppendTool = (() => {
    let _classDecorators = [bindTool(LocalTaskAppendToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalTaskAppendTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalTaskAppendTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        adapter;
        constructor(adapter) {
            this.adapter = adapter;
        }
        async execute(ctx, input, signal) {
            const taskId = input.task_id?.trim() ?? '';
            const content = input.content?.trim() ?? '';
            if (!taskId) {
                return failure(taskId, {
                    code: 'INVALID_ARGUMENT',
                    status: 400,
                    message: 'task_append requires a task_id.',
                });
            }
            if (!content) {
                return failure(taskId, {
                    code: 'INVALID_ARGUMENT',
                    status: 400,
                    message: 'task_append content must not be empty after trimming.',
                });
            }
            // An abort before admission must not deliver anything; after admission the
            // child keeps running and is only stopped through task_stop.
            if (signal?.aborted) {
                return failure(taskId, {
                    code: 'TASK_APPEND_ABORTED',
                    status: 409,
                    message: 'task_append was aborted before Turn admission.',
                });
            }
            let result;
            try {
                result = await this.adapter.append(ctx, { taskId, content }, signal);
            }
            catch (error) {
                const mapped = toTaskAppendFailure(error);
                if (!mapped)
                    throw error;
                return failure(taskId, mapped);
            }
            const text = `<task_append task_id="${escapeXmlAttribute(result.taskId)}" mode="${result.mode}" accepted="true" />`;
            return {
                tool_name: LocalTaskAppendToolDef.name,
                text,
                content: [{ type: 'text', text }],
                // Admission only: the child Session and Turn stay runtime-internal, and
                // the task handle is the single way to read or stop the work.
                details: { task_id: result.taskId, mode: result.mode, accepted: true },
            };
        }
    };
    return LocalTaskAppendTool = _classThis;
})();
export { LocalTaskAppendTool };
function toTaskAppendFailure(error) {
    if (!(error instanceof Error))
        return undefined;
    const candidate = error;
    return typeof candidate.code === 'string' && typeof candidate.status === 'number'
        ? { code: candidate.code, status: candidate.status, message: error.message }
        : undefined;
}
function failure(taskId, error) {
    const text = `<task_append_error task_id="${escapeXmlAttribute(taskId)}" code="${error.code}">${error.message}</task_append_error>`;
    return {
        tool_name: LocalTaskAppendToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
            task_id: taskId,
            code: error.code,
            status: error.status,
            accepted: false,
            error_message: error.message,
        },
        isError: true,
    };
}
function escapeXmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
//# sourceMappingURL=local-task-append.js.map