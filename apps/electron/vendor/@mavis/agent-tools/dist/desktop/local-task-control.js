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
import { isActiveTaskStatus } from '@mavis/background-task';
import { LocalTaskOutputToolDef, LocalTaskQueryToolDef, LocalTaskStopToolDef, } from './builtin-defs.js';
import { formatBashExecutionOutcome, readBashExecutionOutcome } from './local-bash-result.js';
const MAX_TASK_OUTPUT_WAIT_MS = 30_000;
let LocalTaskQueryTool = (() => {
    let _classDecorators = [bindTool(LocalTaskQueryToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalTaskQueryTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalTaskQueryTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        adapter;
        constructor(adapter) {
            this.adapter = adapter;
        }
        async execute(ctx, input) {
            if (input.task_id) {
                const task = await this.adapter.get(ctx, input.task_id);
                if (!task)
                    return notFound(LocalTaskQueryToolDef.name, input.task_id);
                return ok(LocalTaskQueryToolDef.name, renderTask(task), { task: summarizeTask(task) });
            }
            const query = {
                ownerSessionId: ctx.sessionId,
                ...(input.status ? { statuses: [input.status] } : {}),
            };
            const result = await this.adapter.list(ctx, query);
            const text = result.items.length === 0
                ? 'No local background tasks in this session.'
                : result.items.map(renderTask).join('\n');
            return ok(LocalTaskQueryToolDef.name, text, {
                count: result.items.length,
                tasks: result.items.map(summarizeTask),
                ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
            });
        }
    };
    return LocalTaskQueryTool = _classThis;
})();
export { LocalTaskQueryTool };
let LocalTaskOutputTool = (() => {
    let _classDecorators = [bindTool(LocalTaskOutputToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalTaskOutputTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalTaskOutputTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        adapter;
        // A turn's tool instance only needs its latest read, not a growing task/session cache.
        lastRead;
        constructor(adapter) {
            this.adapter = adapter;
        }
        async execute(ctx, input, signal) {
            const requestedWaitMs = input.wait_ms;
            const effectiveWaitMs = Math.min(requestedWaitMs ?? 0, MAX_TASK_OUTPUT_WAIT_MS);
            const waitMsClamped = requestedWaitMs !== undefined && requestedWaitMs > MAX_TASK_OUTPUT_WAIT_MS;
            const task = await this.adapter.get(ctx, input.task_id);
            if (!task) {
                this.lastRead = undefined;
                return notFound(LocalTaskOutputToolDef.name, input.task_id, {
                    effective_wait_ms: effectiveWaitMs,
                    wait_ms_clamped: waitMsClamped,
                });
            }
            const read = await this.adapter.readOutput(ctx, input.task_id, {
                ...(input.offset === undefined ? {} : { offset: input.offset }),
                waitMs: effectiveWaitMs,
                ...(signal ? { signal } : {}),
            });
            const status = read.status ?? task.status;
            const snapshot = read.task ?? task;
            const execution = readBashExecutionOutcome(snapshot.metadata?.bashDetails);
            const output = snapshot.metadata?.bashDetails?.output;
            const persistenceHint = output?.persistence === 'incomplete'
                ? '<task_output_hint>Output persistence is incomplete; this log may be missing command output.</task_output_hint>\n'
                : '';
            const body = read.content || '(no output yet)';
            const cursor = [
                ...(read.nextOffset === undefined ? [] : [`next_offset="${read.nextOffset}"`]),
                ...(read.truncated === undefined ? [] : [`truncated="${read.truncated}"`]),
                ...(read.timedOut === undefined ? [] : [`timed_out="${read.timedOut}"`]),
            ];
            const receipt = cursor.length === 0 ? '' : `<task_output_cursor ${cursor.join(' ')} />\n`;
            const waitLimitHint = signal?.aborted || !waitMsClamped || read.timedOut !== true
                ? ''
                : '<task_output_hint>Your requested wait_ms exceeded 30000 ms and was capped at 30000 ms (30 seconds). This output read reached its wait limit; the background task was not stopped. Use wait_ms=30000 or less for future reads.</task_output_hint>\n';
            const hint = signal?.aborted ? '' : this.pollingHint(ctx, input.task_id, { ...read, status });
            const outcome = execution
                ? `<bash_status>${formatBashExecutionOutcome(execution)}</bash_status>\n`
                : '';
            const text = `<task_output status="${status}">\n${receipt}${waitLimitHint}${persistenceHint}${hint}${outcome}${body}\n</task_output>`;
            const result = ok(LocalTaskOutputToolDef.name, text, {
                task_id: input.task_id,
                status,
                ...(execution ? { execution } : {}),
                ...(output ? { output } : {}),
                timing: snapshot.metadata?.bashDetails?.timing ??
                    snapshot.metadata?.timing,
                effective_wait_ms: effectiveWaitMs,
                wait_ms_clamped: waitMsClamped,
                ...(read.timedOut === undefined ? {} : { timed_out: read.timedOut }),
                ...(read.nextOffset === undefined ? {} : { next_offset: read.nextOffset }),
                ...(read.truncated === undefined ? {} : { truncated: read.truncated }),
                ...(read.summary ? { summary: read.summary } : {}),
            });
            return result;
        }
        pollingHint(ctx, taskId, read) {
            const previous = this.lastRead;
            this.lastRead = undefined;
            if (!isActiveTaskStatus(read.status) ||
                read.nextOffset === undefined ||
                !Number.isSafeInteger(read.nextOffset) ||
                read.nextOffset < 0) {
                return '';
            }
            const key = JSON.stringify([ctx.sessionId, ctx.turnId, taskId]);
            this.lastRead = { key, status: read.status, nextOffset: read.nextOffset };
            if (previous?.key !== key ||
                previous.status !== read.status ||
                previous.nextOffset !== read.nextOffset ||
                read.timedOut === true) {
                return '';
            }
            const nextRead = JSON.stringify({ task_id: taskId, offset: read.nextOffset, wait_ms: 30_000 });
            return ('<task_output_hint>Task status and next_offset are unchanged since the previous read. ' +
                `To wait for new output, use task_output(${nextRead}). ` +
                'offset=0 replays existing output and can return immediately even with wait_ms. ' +
                'Avoid repeated immediate checks; continue independent work and wait for the completion notification when available.</task_output_hint>\n');
        }
    };
    return LocalTaskOutputTool = _classThis;
})();
export { LocalTaskOutputTool };
let LocalTaskStopTool = (() => {
    let _classDecorators = [bindTool(LocalTaskStopToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalTaskStopTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalTaskStopTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        adapter;
        constructor(adapter) {
            this.adapter = adapter;
        }
        async execute(ctx, input) {
            const task = await this.adapter.stop(ctx, input.task_id, input.reason);
            if (!task)
                return notFound(LocalTaskStopToolDef.name, input.task_id);
            const stopError = task.metadata?.stopError ??
                (task.lastError?.code === 'TASK_STOP_FAILED' ? task.lastError : undefined);
            const message = stopError
                ? `Stop failed for ${input.task_id}: ${stopError.message}. Process cleanup could not be confirmed.`
                : `Task ${input.task_id} is ${task.status}.`;
            const text = `<task_stop status="${task.status}">\n${message}\n</task_stop>`;
            return {
                ...ok(LocalTaskStopToolDef.name, text, {
                    task_id: input.task_id,
                    status: task.status,
                    ...(stopError ? { stopError } : {}),
                }),
                ...(stopError ? { isError: true } : {}),
            };
        }
    };
    return LocalTaskStopTool = _classThis;
})();
export { LocalTaskStopTool };
function renderTask(task) {
    const description = task.description ? ` ${task.description}` : '';
    const sessionId = childSessionId(task);
    const mode = executionMode(task);
    const lineage = [
        ...(sessionId ? [`session_id=${sessionId}`] : []),
        ...(task.parentTaskId ? [`parent_task_id=${task.parentTaskId}`] : []),
        ...(mode ? [`execution_mode=${mode}`] : []),
    ];
    const lineageText = lineage.length === 0 ? '' : ` (${lineage.join(' ')})`;
    const execution = readBashExecutionOutcome(task.metadata?.bashDetails);
    const outcome = execution ? ` — ${formatBashExecutionOutcome(execution)}` : '';
    const output = task.metadata?.bashDetails
        ?.output;
    const persistence = output?.persistence === 'incomplete' ? ' — output log incomplete' : '';
    return `- ${task.taskId} [${task.kind}/${task.status}]${description}${lineageText}${outcome}${persistence}`;
}
function summarizeTask(task) {
    const sessionId = childSessionId(task);
    const mode = executionMode(task);
    const execution = readBashExecutionOutcome(task.metadata?.bashDetails);
    return {
        task_id: task.taskId,
        kind: task.kind,
        status: task.status,
        ...(execution ? { execution } : {}),
        output: task.metadata?.bashDetails?.output,
        timing: task.metadata?.bashDetails?.timing ??
            task.metadata?.timing,
        ...(task.metadata?.stopError ? { stopError: task.metadata.stopError } : {}),
        // Handle recovery after the first receipt scrolled out of context. Only a
        // subagent task that really owns a child Session gets a session handle.
        ...(sessionId ? { session_id: sessionId } : {}),
        parent_task_id: task.parentTaskId ?? null,
        ...(mode ? { execution_mode: mode } : {}),
        ...(task.description ? { description: task.description } : {}),
        ...(task.createdAt ? { created_at: task.createdAt } : {}),
        ...(task.endedAt ? { ended_at: task.endedAt } : {}),
        ...(task.lastError ? { last_error: task.lastError.message } : {}),
    };
}
function childSessionId(task) {
    if (task.kind !== 'subagent')
        return undefined;
    const sessionId = task.metadata?.childSessionId;
    return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}
function executionMode(task) {
    const mode = task.metadata?.executionMode;
    return typeof mode === 'string' && mode ? mode : undefined;
}
function ok(toolName, text, details) {
    return { tool_name: toolName, text, content: [{ type: 'text', text }], details };
}
function notFound(toolName, taskId, extraDetails = {}) {
    const text = `<task_error>Local background task not found: ${taskId}</task_error>`;
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: { task_id: taskId, status: 'not_found', ...extraDetails },
        isError: true,
    };
}
//# sourceMappingURL=local-task-control.js.map