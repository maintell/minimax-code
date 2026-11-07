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
import { LocalTaskToolDef } from './builtin-defs.js';
import { formatLocalTaskParentReport } from './task-verification.js';
import { withPluginHookCompatibleToolResponse } from '../plugin-hooks/vendor-tool-response.js';
let LocalTaskTool = (() => {
    let _classDecorators = [bindTool(LocalTaskToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalTaskTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalTaskTool = _classThis = _classDescriptor.value;
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
            if (input.run_in_background === true && ctx.canConsumeBackgroundTaskOutput !== true) {
                const text = '<task_error>Background task execution requires native task_output. This Turn is missing task_output, so asynchronous task execution cannot be started. Set run_in_background=false to run the task in the foreground.</task_error>';
                return {
                    tool_name: LocalTaskToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        agent_name: input.agent_name,
                        status: 'background_output_unavailable',
                        error_code: 'TASK_BACKGROUND_OUTPUT_UNAVAILABLE',
                    },
                    isError: true,
                };
            }
            const runInBackground = input.run_in_background === undefined
                ? ctx.canConsumeBackgroundTaskOutput === true
                : input.run_in_background;
            if (runInBackground) {
                const started = await this.adapter.startBackground(ctx, input, signal);
                if (started.status !== 'started' || !started.taskId) {
                    const errorMessage = started.errorMessage ?? 'Local background task failed to start';
                    const text = `<task_error${taskIdAttribute(started.taskId)}${sessionIdAttribute(started.subSessionId)}${errorCodeAttribute(started.errorCode)}>${errorMessage}</task_error>`;
                    return {
                        tool_name: LocalTaskToolDef.name,
                        text,
                        content: [{ type: 'text', text }],
                        details: {
                            agent_name: input.agent_name,
                            status: started.status,
                            ...(started.taskId ? { task_id: started.taskId } : {}),
                            ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
                            ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
                            ...(started.errorCode ? { error_code: started.errorCode } : {}),
                        },
                        isError: true,
                    };
                }
                const text = `<task_background task_id="${escapeXmlAttribute(started.taskId)}"${sessionIdAttribute(started.subSessionId)}${concurrencyAttributes(started.concurrency)}>\nStarted background task ${started.taskId}. The owning conversation will automatically resume when it finishes; use task_query/task_output to inspect it early and task_stop to cancel it.\n</task_background>`;
                const result = {
                    tool_name: LocalTaskToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        agent_name: input.agent_name,
                        status: 'started',
                        task_id: started.taskId,
                        ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
                        ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
                        ...(started.concurrency
                            ? {
                                active_child_tasks: started.concurrency.active,
                                child_task_limit: started.concurrency.limit,
                            }
                            : {}),
                    },
                };
                return started.subSessionId
                    ? withPluginHookCompatibleToolResponse(result, {
                        status: 'async_launched',
                        agentId: started.subSessionId,
                        description: input.description,
                        prompt: input.prompt,
                    })
                    : result;
            }
            const run = await this.adapter.runForeground(ctx, input, signal);
            if (run.status !== 'succeeded') {
                const errorMessage = run.errorMessage ?? 'Agent task failed';
                const text = `<task_error${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}${errorCodeAttribute(run.errorCode)}>\n${formatLocalTaskParentReport({
                    ...run,
                    errorMessage,
                })}\n</task_error>`;
                return {
                    tool_name: LocalTaskToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        agent_name: input.agent_name,
                        status: run.status,
                        ...(run.taskId ? { task_id: run.taskId } : {}),
                        ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
                        ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
                        ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
                        requested_agent_name: run.requestedAgentName,
                        ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
                        ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
                        ...(run.verification ? { verification: run.verification } : {}),
                        error_message: errorMessage,
                        ...(run.errorCode ? { error_code: run.errorCode } : {}),
                    },
                    isError: true,
                };
            }
            const text = `<task_result${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}>\n${formatLocalTaskParentReport(run)}\n</task_result>`;
            const result = {
                tool_name: LocalTaskToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    agent_name: input.agent_name,
                    status: 'succeeded',
                    ...(run.taskId ? { task_id: run.taskId } : {}),
                    ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
                    ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
                    ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
                    requested_agent_name: run.requestedAgentName,
                    ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
                    ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
                    ...(run.verification ? { verification: run.verification } : {}),
                },
            };
            return run.subSessionId
                ? withPluginHookCompatibleToolResponse(result, {
                    status: 'completed',
                    agentId: run.subSessionId,
                    content: [{ type: 'text', text: run.finalText ?? '' }],
                })
                : result;
        }
    };
    return LocalTaskTool = _classThis;
})();
export { LocalTaskTool };
/**
 * The first receipt carries both handles: `task_id` drives task_query /
 * task_output / task_stop, `session_id` drives session send.
 */
function taskIdAttribute(taskId) {
    return taskId ? ` task_id="${escapeXmlAttribute(taskId)}"` : '';
}
function sessionIdAttribute(sessionId) {
    return sessionId ? ` session_id="${escapeXmlAttribute(sessionId)}"` : '';
}
function concurrencyAttributes(concurrency) {
    return concurrency
        ? ` active_child_tasks="${String(concurrency.active)}" child_task_limit="${String(concurrency.limit)}"`
        : '';
}
function errorCodeAttribute(errorCode) {
    return errorCode ? ` code="${escapeXmlAttribute(errorCode)}"` : '';
}
function escapeXmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
//# sourceMappingURL=local-task.js.map