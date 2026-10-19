/**
 * Control-plane tools for background tasks (web / cloud-runtime).
 *
 * These three LLM-facing tools let the parent agent manage the background
 * tasks it launched via `run_in_background=true` WITHIN a session:
 *
 *   - `task_query`  — list this session's background tasks, or get one by id.
 *   - `task_output` — read a finished/running background task's output.
 *   - `task_stop`   — request a background task to stop.
 *
 * All three delegate to a {@link BackgroundTaskController}. In cloud-runtime the
 * concrete controller is `ArchonBackgroundTaskController(client, outputStore)`:
 *   - status / list / stop round-trip to archon-server (the SoT, tenant-scoped
 *     by user_id + biz_id from BaseReq headers);
 *   - output is read from the process-lifetime `TaskOutputStore` that the
 *     background runners write, or from durable runtime-specific output refs.
 *
 * Scope note (design §1.4 / §4 Phase 5): these are the model-facing control
 * surface. The human-facing projection — session task/tool message rendering,
 * page-refresh recovery, completion notification into the conversation — spans
 * archon-server + web UI and is tracked separately (design doc §9.1).
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
import { Type } from '@sinclair/typebox';
import { bindTool, } from '@mavis/agent-core/tools';
import { CloudTaskToolDef } from './builtin-defs.js';
/**
 * Gated-off `task` definition (Phase 6). When the background gate is OFF the
 * registry binds the CloudTaskTool impl to THIS def instead of CloudTaskToolDef,
 * so the model sees a `task` tool with NO `run_in_background` field and a
 * description that makes no mention of background execution — full schema /
 * prompt parity with legacy synchronous one-shot delegation. Derived from
 * CloudTaskToolDef (single source of truth for the shared fields) minus the
 * `run_in_background` property.
 */
const GATED_SYNC_TASK_DESCRIPTION = `Launch a cloud sub-agent to handle complex, multistep tasks autonomously.

Use this for broad research, parallelizable investigation, or delegated implementation. Do not use it for targeted file reads, grep-style code searches, or work that is simpler to do directly.

Each invocation returns the child agent's final result only to you.`;
const { run_in_background: _omitRunInBackground, ...SYNC_TASK_SCHEMA_PROPS } = CloudTaskToolDef.schema.properties;
export const GatedSyncTaskToolDef = {
    name: CloudTaskToolDef.name,
    executionMode: CloudTaskToolDef.executionMode,
    description: GATED_SYNC_TASK_DESCRIPTION,
    schema: Type.Object(SYNC_TASK_SCHEMA_PROPS),
};
const QUERYABLE_STATUSES = [
    'queued',
    'running',
    'stopping',
    'succeeded',
    'failed',
    'canceled',
    'lost',
];
// ─── task_query ─────────────────────────────────────────────────────────
export const TaskQueryToolDef = {
    name: 'task_query',
    executionMode: 'parallel',
    description: 'Query background tasks started in this session. Omit task_id to list them; pass task_id to get one. Use it to poll whether a background Bash command or sub-agent has finished.',
    schema: Type.Object({
        task_id: Type.Optional(Type.String({
            description: 'A specific background task id to fetch. Omit to list the session tasks.',
        })),
        status: Type.Optional(Type.Union(QUERYABLE_STATUSES.map((s) => Type.Literal(s)), { description: 'Optional status filter when listing.' })),
    }),
};
let CloudTaskQueryTool = (() => {
    let _classDecorators = [bindTool(TaskQueryToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudTaskQueryTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudTaskQueryTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        controller;
        constructor(controller) {
            this.controller = controller;
        }
        async execute(ctx, input) {
            if (input.task_id) {
                const task = await this.controller.get(input.task_id);
                if (!task)
                    return notFound(TaskQueryToolDef.name, input.task_id);
                return ok(TaskQueryToolDef.name, renderTask(task), { task: summarize(task) });
            }
            const query = {
                ownerSessionId: ctx.sessionId,
                ...(input.status ? { statuses: [input.status] } : {}),
            };
            const result = await this.controller.list(query);
            const lines = result.items.length === 0
                ? 'No background tasks in this session.'
                : result.items.map(renderTask).join('\n');
            return ok(TaskQueryToolDef.name, lines, {
                count: result.items.length,
                tasks: result.items.map(summarize),
                ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
            });
        }
    };
    return CloudTaskQueryTool = _classThis;
})();
export { CloudTaskQueryTool };
// ─── task_output ────────────────────────────────────────────────────────
export const TaskOutputToolDef = {
    name: 'task_output',
    executionMode: 'parallel',
    description: "Read a background task's output by task_id. Returns incremental content from `offset`; use the returned next_offset to continue reading a long output.",
    schema: Type.Object({
        task_id: Type.String({ description: 'The background task id to read output from.' }),
        offset: Type.Optional(Type.Number({
            description: 'Byte offset to read from (default 0). Pass the previous next_offset to continue.',
        })),
    }),
};
let CloudTaskOutputTool = (() => {
    let _classDecorators = [bindTool(TaskOutputToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudTaskOutputTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudTaskOutputTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        controller;
        constructor(controller) {
            this.controller = controller;
        }
        async execute(_ctx, input) {
            // Confirm existence + tenant ownership via archon-server before reading the
            // process-local output store.
            const task = await this.controller.get(input.task_id);
            if (!task)
                return notFound(TaskOutputToolDef.name, input.task_id);
            const read = await this.controller.readOutput(input.task_id, {
                ...(input.offset === undefined ? {} : { offset: input.offset }),
            });
            const body = read.content || '(no output yet)';
            const text = `<task_output status="${task.status}">\n${body}\n</task_output>`;
            return ok(TaskOutputToolDef.name, text, {
                task_id: input.task_id,
                status: task.status,
                ...(read.nextOffset === undefined ? {} : { next_offset: read.nextOffset }),
                ...(read.truncated === undefined ? {} : { truncated: read.truncated }),
                ...(read.summary ? { summary: read.summary } : {}),
            });
        }
    };
    return CloudTaskOutputTool = _classThis;
})();
export { CloudTaskOutputTool };
// ─── task_stop ──────────────────────────────────────────────────────────
export const TaskStopToolDef = {
    name: 'task_stop',
    executionMode: 'sequential',
    description: 'Request a background task to stop by task_id. The task is marked stopping and the runner aborts on its next heartbeat; the final state becomes canceled.',
    schema: Type.Object({
        task_id: Type.String({ description: 'The background task id to stop.' }),
        reason: Type.Optional(Type.String({ description: 'Optional human-readable stop reason.' })),
    }),
};
let CloudTaskStopTool = (() => {
    let _classDecorators = [bindTool(TaskStopToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudTaskStopTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudTaskStopTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        controller;
        constructor(controller) {
            this.controller = controller;
        }
        async execute(_ctx, input) {
            const task = await this.controller.stop(input.task_id, input.reason);
            const text = `<task_stop status="${task.status}">\nStop requested for ${input.task_id}.\n</task_stop>`;
            return ok(TaskStopToolDef.name, text, { task_id: input.task_id, status: task.status });
        }
    };
    return CloudTaskStopTool = _classThis;
})();
export { CloudTaskStopTool };
// ─── helpers ────────────────────────────────────────────────────────────
function renderTask(t) {
    const desc = t.description ? ` ${t.description}` : '';
    return `- ${t.taskId} [${t.kind}/${t.status}]${desc}`;
}
function summarize(t) {
    return {
        task_id: t.taskId,
        kind: t.kind,
        status: t.status,
        ...(t.description ? { description: t.description } : {}),
        ...(t.createdAt ? { created_at: t.createdAt } : {}),
        ...(t.endedAt ? { ended_at: t.endedAt } : {}),
        ...(t.lastError ? { last_error: t.lastError.message } : {}),
    };
}
function ok(toolName, text, details) {
    return { tool_name: toolName, text, content: [{ type: 'text', text }], details };
}
function notFound(toolName, taskId) {
    const text = `<task_error>Background task not found: ${taskId}</task_error>`;
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        details: { task_id: taskId, status: 'not_found', is_error: true },
    };
}
//# sourceMappingURL=cloud-task-control.js.map