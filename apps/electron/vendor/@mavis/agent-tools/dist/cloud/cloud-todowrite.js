/**
 * CloudTodoWriteTool —— `todowrite` 工具的 cloud 实现,效仿 legacy local runtime 的
 * `Pi todo tool shape:TodoWriteTool`。LLM 用它在当前 session
 * 里维护一份结构化的 task list,调用一次就用入参里的 `todos[]` 整体覆盖旧列表。
 *
 * 三件副作用,按依赖顺序:
 *   1) **内存覆盖** —— 更新进程内 `Map<sessionId, TodoItem[]>` 当前快照,
 *      仅供同进程调试 / 测试读回(`getSessionTodos`)。legacy local runtime 用 SQLite 是
 *      因为本地 daemon 进程要跨重启复用;cloud-runtime 是常驻进程,session
 *      维度的 todo 跟当前 sandbox 进程生命周期对齐,重启即丢(UI 端的历史
 *      在 archon-server 的 message 流里已经持久化)。
 *   2) **SR 状态喂养** —— 调用 agent-core 的 `updateTodoState(sessionId,
 *      todos)`。它**不发事件**,只更新进程内 `todoStates` Map;下一轮
 *      `composePrompts()` 走到 `taskCompletionReminderProvider` 时才读这个
 *      状态,决定要不要在 prompt 里塞 `<task-completion-reminder>` 块。
 *   3) **`todo_updated` 副流事件** —— 拼一条 `MsgType.SystemEvent` 的 RespData
 *      (`msg_content = JSON({eventType:'todo_updated', todos})`),走
 *      `buildStreamRespEvent` 包成 `stream.resp` RuntimeEvent,通过当前
 *      turn 的 `ctx.reporter` 发出去。UI(`packages/ui`)端的
 *      `runtimeProjection.ts` 在 `respDataToChunk` 里识别 `MsgType.SystemEvent`
 *      + `eventType === 'todo_updated'` 分支,跟 daemon 链路
 *      (`bridge-content-helpers.ts:buildTodoUpdatedEvent`)合成的 SSE
 *      消息形态一致 —— 两条链路共用同一份 UI 渲染逻辑。
 *
 * 上下文获取:`sessionId` / `turnId` / `reporter` 全部从 `ctx`(由
 * SessionController 构造的 `CloudRuntimeContext`)读取,PiTurnRunner 在
 * `assembleAgentTools` 把 ctx 闭包进 wrapper —— 不再走 AsyncLocalStorage。
 *
 * runtime_seq 顺序:reporter 的 seq 全局单调,所以这里发的 SystemEvent
 * 会自然落在 pi 的 `tool_execution_start` 之后、`tool_execution_end` 之前
 * (因为 execute 同步返回 ToolResult 之后 pi 才 emit end),UI 按 seq 排
 * 序看到的就是 "start → todo_updated → end",符合 daemon 链路的语义。
 *
 * 事件落地失败不阻塞 tool 主路径:reporter.appendEvents reject 时只 warn,
 * tool 仍然 fulfilled return,LLM 拿到 ToolResult,只是 UI 这次 turn 没看到
 * todo 同步事件(下次 turn 模型重新发 todowrite 就会补上)。
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
import { CloudTodoWriteToolDef as TodoWriteToolDef } from './builtin-defs.js';
import { MsgType, RespDataType, } from '@mavis/agent-core/protocol/agent-message';
import { buildStreamRespEvent } from '@mavis/agent-core/event-bridge';
import { updateTodoState } from '@mavis/system-reminder';
import { logger } from './runtime-types.js';
const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const TODO_WRITE_SUCCESS = 'success';
const TODO_UPDATED_EVENT_TYPE = 'todo_updated';
const todosBySession = new Map();
/**
 * Process-wide monotonic counter ensuring the synthesized `msg_id` is unique
 * across all `todo_updated` emissions in this cloud-runtime process. Mirrors
 * daemon's `ResponseBroadcaster.todoSeqCounter` — the timestamp+seq combo
 * keeps ids stable enough for the UI's MessageStore dedup (id is the primary
 * key) without coordinating across replicas (cloud-runtime is single-process
 * per sandbox).
 */
let todoEmitSeq = 0;
let CloudTodoWriteTool = (() => {
    let _classDecorators = [bindTool(TodoWriteToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudTodoWriteTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudTodoWriteTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const todos = Array.isArray(input.todos) ? input.todos : [];
            const sessionId = ctx.sessionId;
            if (todos.length === 0) {
                todosBySession.delete(sessionId);
            }
            else {
                todosBySession.set(sessionId, [...todos]);
            }
            // 同步给 SR 机制;失败也只是 SR 那侧降级,不阻塞 tool 主路径。
            try {
                updateTodoState(sessionId, todos);
            }
            catch {
                // 静默吞掉 —— SR 状态记不上不影响 todo 本身的更新与 UI 渲染。
            }
            // 副流事件:把 todos 同步给 UI 渲染。reporter 总是存在(由
            // SessionController 注入到 ctx),这里只兜 emit 本身的失败。
            let eventEmitted = false;
            try {
                await emitTodoUpdatedEvent(ctx, todos);
                eventEmitted = true;
            }
            catch {
                logger.warn(`[cloud-todowrite] stage=todo_updated_emit code=CLOUD_TODOWRITE_EVENT_EMIT_FAILED session_id=${ctx.sessionId} turn_id=${ctx.turnId}`);
            }
            const active = todos.filter((t) => !TERMINAL_STATUSES.has(t.status)).length;
            const completed = todos.filter((t) => t.status === 'completed').length;
            const cancelled = todos.filter((t) => t.status === 'cancelled').length;
            const text = TODO_WRITE_SUCCESS;
            return {
                tool_name: TodoWriteToolDef.name,
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
    return CloudTodoWriteTool = _classThis;
})();
export { CloudTodoWriteTool };
async function emitTodoUpdatedEvent(ctx, todos) {
    todoEmitSeq += 1;
    const msgId = `todo_${Date.now()}_${todoEmitSeq}`;
    const agentMessage = {
        msg_id: msgId,
        msg_type: MsgType.SystemEvent,
        msg_content: JSON.stringify({ eventType: TODO_UPDATED_EVENT_TYPE, todos }),
    };
    const respData = {
        type: RespDataType.AgentMessage,
        agent_message: agentMessage,
    };
    const event = buildStreamRespEvent({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        eventId: ctx.reporter.nextEventId('todo_updated'),
        runtimeSeq: ctx.reporter.nextRuntimeSeq(),
        respData,
    });
    await ctx.reporter.appendEvents([event]);
}
/**
 * 读出某个 session 的当前 todo 快照 —— 仅供测试 / 调试用,生产路径不依赖
 * 这个函数。返回的是引用本身的浅拷贝,调用方修改不会影响内部状态。
 */
export function getSessionTodos(sessionId) {
    const todos = todosBySession.get(sessionId);
    return todos ? [...todos] : [];
}
/**
 * 清空所有 session 的 todo 状态 + emit seq 计数 —— 测试隔离用,避免单测
 * 之间互相污染。
 */
export function _resetCloudTodoWriteStateForTests() {
    todosBySession.clear();
    todoEmitSeq = 0;
}
//# sourceMappingURL=cloud-todowrite.js.map