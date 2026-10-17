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
import { updateTodoState } from '@mavis/system-reminder';
import { LocalTodoWriteToolDef } from './builtin-defs.js';
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const TODO_WRITE_SUCCESS = 'success';
const todosBySession = new Map();
let LocalTodoWriteTool = (() => {
    let _classDecorators = [bindTool(LocalTodoWriteToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalTodoWriteTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalTodoWriteTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        eventSink;
        constructor(eventSink) {
            this.eventSink = eventSink;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const todos = Array.isArray(input.todos) ? input.todos : [];
            if (todos.length === 0) {
                todosBySession.delete(ctx.sessionId);
            }
            else {
                todosBySession.set(ctx.sessionId, [...todos]);
            }
            try {
                updateTodoState(ctx.sessionId, todos);
            }
            catch {
                // Reminder state is best-effort and should not block the tool result.
            }
            let eventEmitted = false;
            if (this.eventSink) {
                try {
                    eventEmitted = await this.eventSink.emitTodoUpdated(ctx, todos, signal);
                }
                catch (error) {
                    if (signal?.aborted)
                        throw error;
                    // The structured todo state and tool result are authoritative. A
                    // side-stream delivery failure must not fail the provider tool call.
                }
            }
            const active = todos.filter((t) => !TERMINAL_STATUSES.has(t.status)).length;
            const completed = todos.filter((t) => t.status === 'completed').length;
            const cancelled = todos.filter((t) => t.status === 'cancelled').length;
            const text = TODO_WRITE_SUCCESS;
            return {
                tool_name: LocalTodoWriteToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    todos,
                    total: todos.length,
                    active,
                    completed,
                    cancelled,
                    event_emitted: eventEmitted,
                },
            };
        }
    };
    return LocalTodoWriteTool = _classThis;
})();
export { LocalTodoWriteTool };
export function getLocalSessionTodos(sessionId) {
    const todos = todosBySession.get(sessionId);
    return todos ? [...todos] : [];
}
export function _resetLocalTodoWriteStateForTests() {
    todosBySession.clear();
}
//# sourceMappingURL=local-todowrite.js.map