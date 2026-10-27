/**
 * `CloudTaskTool` — wire-compatible (Pi-compatible) sub-agent
 * delegation for cloud-runtime. Re-enters `PiTurnRunner.runTurn` with a
 * persisted sub-`sessionId` / fresh sub-`turnId`, a child-scoped event
 * reporter, and a filtered tool catalog that NEVER contains `task`
 * (recursion guard). A local-only compatibility path remains for legacy
 * `subagent_type` while the unified coordinator gate is disabled.
 *
 * Returns the sub-agent's final assistant text wrapped in
 * `<task_result>…</task_result>` for the model, plus structured `details`
 * (sub_session_id / sub_turn_id / event_count / usage) for the host.
 *
 * Child events and canonical history are written under the child session;
 * none of them are appended through the parent reporter.
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
import { cloudToolHookTargets, withCloudToolTargetHooks } from './cloud-tool-target-hooks.js';
import { randomUUID } from 'node:crypto';
import { withMcodeToolsMasterReminder } from '@mavis/system-reminder';
import { bindTool, isRuntimeToolInputValid, } from '@mavis/agent-core/tools';
import { CloudTaskToolDef } from './builtin-defs.js';
import { extractFinalAssistantText, extractFinalAssistantUsageFromBuffer, } from '@mavis/agent-core/event-bridge';
import { mergePluginHookContext } from '@mavis/plugin-hooks';
import { ProtocolErrorCode, RuntimeEventStatus, RuntimeEventType, RuntimeStopReasonType, RUNTIME_EVENT_SCHEMA, ThinkingLevel, } from '@mavis/protocol';
import { buildDefaultCloudLLMModelConfig, } from './runtime-types.js';
import { logger, BackgroundTaskKind, BackgroundTaskStatus } from './runtime-types.js';
import { PluginHookTranscript } from '../plugin-hooks/transcript.js';
import { buildCloudPluginHookAfterToolResult, CLOUD_PLUGIN_STOP_CONTINUATION_LIMIT, } from './cloud-plugin-hook-result.js';
import { isCloudPluginHookToolFailure, readCloudCompatibleToolResponse, readCloudCodexToolResponse, } from './cloud-plugin-hook-response.js';
import { cloudPluginHookEffort } from './plugin-hook-effort.js';
import { withPluginHookCompatibleToolResponse } from '../plugin-hooks/vendor-tool-response.js';
export { CloudTaskToolDef };
export const INVALID_SUBAGENT_TARGET = 'INVALID_SUBAGENT_TARGET';
export const CLOUD_UNIFIED_TASK_DISABLED = 'CLOUD_UNIFIED_TASK_DISABLED';
export const SUBAGENT_PERSISTENCE_FAILED = 'SUBAGENT_PERSISTENCE_FAILED';
export const SUBAGENT_EXECUTION_FAILED = 'SUBAGENT_EXECUTION_FAILED';
const SUBAGENT_CHILD_CREATE_FAILED = 'SUBAGENT_CHILD_CREATE_FAILED';
const SUBAGENT_CHILD_RESPONSE_INVALID = 'SUBAGENT_CHILD_RESPONSE_INVALID';
const STABLE_COORDINATOR_ERROR_CODES = new Set([
    INVALID_SUBAGENT_TARGET,
    'AGENT_NOT_FOUND',
    'AGENT_UNAVAILABLE',
    'SUBSESSION_ID_CONFLICT',
    'SUBAGENT_COORDINATOR_UNAVAILABLE',
    'SUBAGENT_MODEL_UNAVAILABLE',
    'AGENT_CONFIG_CHANGED_RETRY_EXHAUSTED',
    CLOUD_UNIFIED_TASK_DISABLED,
]);
export const SubAgentExecutionMode = { Foreground: 1, Background: 2 };
const DEFAULT_BACKGROUND_HEARTBEAT_INTERVAL_MS = 30_000;
function childTitleFromDescription(description) {
    return [...description.trim().replace(/\s+/gu, ' ')].slice(0, 20).join('');
}
/**
 * Built-in ceiling (ms) on a single background sub-agent run, applied whenever
 * a task runs in background and no explicit `maxRunMs` is configured. Generous
 * enough not to kill legitimate long delegations, but bounds a hung sub-turn so
 * eval / headless paths never wait unbounded (design §4 Phase 6). Override per
 * environment via `background_task.headless_max_wait_ms`.
 */
export const DEFAULT_BACKGROUND_MAX_RUN_MS = 30 * 60 * 1000;
let CloudTaskTool = (() => {
    let _classDecorators = [bindTool(CloudTaskToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudTaskTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudTaskTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        piRunner;
        subagents;
        workspaceRoot;
        options;
        constructor(piRunner, subagents, workspaceRoot, options) {
            this.piRunner = piRunner;
            this.subagents = subagents;
            this.workspaceRoot = workspaceRoot;
            this.options = options;
        }
        get background() {
            return this.options?.client ? this.options : undefined;
        }
        get runtime() {
            return this.options?.runtime ?? {};
        }
        async execute(ctx, rawInput, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            const input = rawInput.run_in_background === undefined
                ? {
                    ...rawInput,
                    run_in_background: ctx.parentAgentConfig?.background_task_enabled === true &&
                        this.background !== undefined,
                }
                : rawInput;
            const target = resolveTaskTarget(input);
            if (!target) {
                return taskError(input, INVALID_SUBAGENT_TARGET, 'Exactly one of agent_name or subagent_type must be provided');
            }
            if (!ctx.parentAgentConfig) {
                if (input.run_in_background === true) {
                    this.background?.metrics?.recordBackgroundTaskTool({
                        tool: 'task',
                        mode: 'background',
                        result: 'missing_parent_context',
                    });
                }
                return taskError(input, 'missing_parent_context', 'Sub-agent invocation requires parent agent_config context');
            }
            // The caller owns this idempotency key. RemoteArchonServerAdapter may retry
            // the HTTP request, but every attempt serializes this same request object.
            const requestedSubSessionId = randomUUID();
            const subTurnId = randomUUID();
            // Reject impossible background launches before persistence so a disabled
            // background path cannot leave an orphan child Session behind.
            if (input.run_in_background === true &&
                ctx.parentAgentConfig.background_task_enabled !== true) {
                this.background?.metrics?.recordBackgroundTaskTool({
                    tool: 'task',
                    mode: 'background',
                    result: 'background_not_enabled',
                });
                return taskError(input, 'background_not_enabled', 'Background task execution is not enabled for this user', { requested_sub_session_id: requestedSubSessionId, sub_turn_id: subTurnId });
            }
            if (input.run_in_background === true && !this.background) {
                return taskError(input, 'background_not_enabled', 'Background task execution is not enabled', { requested_sub_session_id: requestedSubSessionId, sub_turn_id: subTurnId });
            }
            let resolved;
            let subSessionId = requestedSubSessionId;
            let reportBackgroundSetupFailure;
            const childSetupDetails = (childSessionId) => ({
                sub_session_id: childSessionId,
                requested_sub_session_id: requestedSubSessionId,
                sub_turn_id: subTurnId,
            });
            let childReporterFailureMessage = 'Child persistence reporter unavailable';
            const childReporterUnavailable = (childSessionId) => taskError(input, SUBAGENT_PERSISTENCE_FAILED, `${SUBAGENT_PERSISTENCE_FAILED}: ${childReporterFailureMessage}`, childSetupDetails(childSessionId));
            const createChildReporter = (childSessionId) => {
                const factory = this.runtime.createChildReporter;
                if (!factory) {
                    logger.error(`[cloud-task] child setup failed stage=create_child_reporter code=${SUBAGENT_PERSISTENCE_FAILED} parent_session_id=${ctx.sessionId} parent_turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId} requested_sub_session_id=${requestedSubSessionId} sub_session_id=${childSessionId} sub_turn_id=${subTurnId}`);
                    return undefined;
                }
                try {
                    return factory(childSessionId, subTurnId);
                }
                catch {
                    childReporterFailureMessage = 'Child persistence reporter failed';
                    logger.error(`[cloud-task] child setup failed stage=create_child_reporter code=${SUBAGENT_PERSISTENCE_FAILED} parent_session_id=${ctx.sessionId} parent_turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId} requested_sub_session_id=${requestedSubSessionId} sub_session_id=${childSessionId} sub_turn_id=${subTurnId}`);
                    return undefined;
                }
            };
            const reportSetupFailure = async (childReporter, childSessionId, code, message, stage) => {
                let safeCode = code;
                let safeMessage = message;
                const messageStore = this.runtime.messageStore;
                if (!messageStore) {
                    safeCode = SUBAGENT_PERSISTENCE_FAILED;
                    safeMessage = 'Child persistence message store unavailable';
                }
                else {
                    try {
                        await messageStore.flush(childSessionId);
                    }
                    catch {
                        safeCode = SUBAGENT_PERSISTENCE_FAILED;
                        safeMessage = 'Child persistence flush failed';
                    }
                }
                logger.error(`[cloud-task] child setup failed stage=${stage} code=${safeCode} parent_session_id=${ctx.sessionId} parent_turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId} requested_sub_session_id=${requestedSubSessionId} sub_session_id=${childSessionId} sub_turn_id=${subTurnId}`);
                try {
                    await childReporter.appendEvents([
                        makeChildFailedEvent(childReporter, childSessionId, subTurnId, safeCode, safeMessage),
                    ]);
                }
                catch {
                    logger.error(`[cloud-task] child setup failed stage=report_child_failure code=${SUBAGENT_PERSISTENCE_FAILED} parent_session_id=${ctx.sessionId} parent_turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId} requested_sub_session_id=${requestedSubSessionId} sub_session_id=${childSessionId} sub_turn_id=${subTurnId}`);
                    return taskError(input, SUBAGENT_PERSISTENCE_FAILED, `${SUBAGENT_PERSISTENCE_FAILED}: Child persistence reporter failed`, childSetupDetails(childSessionId));
                }
                return taskError(input, safeCode, `${safeCode}: ${safeMessage}`, childSetupDetails(childSessionId));
            };
            const createChild = this.runtime.createSubAgentChild;
            if (createChild) {
                if (!ctx.toolCallId) {
                    return taskError(input, 'SUBAGENT_CHILD_CONTEXT_MISSING', 'Sub-agent child creation requires tool_call_id');
                }
                let response;
                try {
                    const parentEffectiveModel = toParentModelSelection(ctx.parentAgentConfig);
                    response = await createChild({
                        parent_session_id: ctx.sessionId,
                        parent_turn_id: ctx.turnId,
                        tool_call_id: ctx.toolCallId,
                        requested_sub_session_id: requestedSubSessionId,
                        agent_request_ref: target.value,
                        title: childTitleFromDescription(input.description),
                        execution_mode: input.run_in_background === true
                            ? SubAgentExecutionMode.Background
                            : SubAgentExecutionMode.Foreground,
                        ...(parentEffectiveModel ? { parent_effective_model: parentEffectiveModel } : {}),
                    }, signal);
                }
                catch {
                    const childReporter = createChildReporter(requestedSubSessionId);
                    if (!childReporter)
                        return childReporterUnavailable(requestedSubSessionId);
                    return reportSetupFailure(childReporter, requestedSubSessionId, SUBAGENT_CHILD_CREATE_FAILED, 'Sub-agent child creation failed', 'create_subagent_child');
                }
                const statusCode = response.base_resp?.status_code ?? 0;
                const statusMessage = response.base_resp?.status_msg?.trim() ?? '';
                const stableErrorCode = stableCoordinatorErrorCode(statusMessage);
                if (response.sub_session_id && !response.agent_config) {
                    subSessionId = response.sub_session_id;
                    const childReporter = createChildReporter(subSessionId);
                    if (!childReporter)
                        return childReporterUnavailable(subSessionId);
                    return reportSetupFailure(childReporter, subSessionId, SUBAGENT_CHILD_RESPONSE_INVALID, 'Sub-agent child response is missing agent_config', 'create_subagent_child_response');
                }
                if (statusCode !== 0 || stableErrorCode !== undefined) {
                    if (stableErrorCode !== CLOUD_UNIFIED_TASK_DISABLED) {
                        if (!stableErrorCode) {
                            logger.error(`[cloud-task] child setup failed stage=create_subagent_child_response code=${SUBAGENT_CHILD_CREATE_FAILED} parent_session_id=${ctx.sessionId} parent_turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId} requested_sub_session_id=${requestedSubSessionId} sub_turn_id=${subTurnId}`);
                        }
                        return taskError(input, stableErrorCode ?? SUBAGENT_CHILD_CREATE_FAILED, stableErrorCode
                            ? statusMessage
                            : `${SUBAGENT_CHILD_CREATE_FAILED}: Sub-agent child creation failed`, { requested_sub_session_id: requestedSubSessionId });
                    }
                    // Rollout-off compatibility is deliberately one-way: only the legacy
                    // alias may enter the old fixed-config resolver. Canonical agent_name
                    // must never be silently interpreted as a local/display identity.
                    if (target.kind === 'agent_name') {
                        return taskError(input, CLOUD_UNIFIED_TASK_DISABLED, CLOUD_UNIFIED_TASK_DISABLED);
                    }
                }
                else {
                    if (!response.sub_session_id) {
                        return taskError(input, SUBAGENT_CHILD_RESPONSE_INVALID, 'Sub-agent child response is missing sub_session_id', { requested_sub_session_id: requestedSubSessionId });
                    }
                    subSessionId = response.sub_session_id;
                    const childReporter = createChildReporter(subSessionId);
                    if (!childReporter)
                        return childReporterUnavailable(subSessionId);
                    const childReportSetupFailure = (code, message, stage) => reportSetupFailure(childReporter, subSessionId, code, message, stage);
                    if (!response.agent_config) {
                        return childReportSetupFailure(SUBAGENT_CHILD_RESPONSE_INVALID, 'Sub-agent child response is missing agent_config', 'create_subagent_child_response');
                    }
                    if (!this.runtime.messageStore) {
                        return childReportSetupFailure(SUBAGENT_PERSISTENCE_FAILED, 'Child persistence message store unavailable', 'message_store');
                    }
                    try {
                        const assembled = this.runtime.assembleChildRuntime
                            ? await this.runtime.assembleChildRuntime(response.agent_config, signal)
                            : { config: response.agent_config, tools: [] };
                        resolved = {
                            ...assembled,
                            tools: assembled.tools.filter((tool) => tool.def.name !== CloudTaskToolDef.name),
                            persistent: true,
                            childReporter,
                        };
                    }
                    catch {
                        return childReportSetupFailure(SUBAGENT_EXECUTION_FAILED, 'Child sub-agent execution failed', 'assemble_child_runtime');
                    }
                    reportBackgroundSetupFailure = childReportSetupFailure;
                }
            }
            else if (target.kind === 'agent_name') {
                return taskError(input, CLOUD_UNIFIED_TASK_DISABLED, CLOUD_UNIFIED_TASK_DISABLED);
            }
            // Gate-off compatibility path. The alias is passed to the local resolver
            // exactly as received; no ListAgent/display_name reverse lookup exists here.
            if (!resolved) {
                resolved = this.subagents.resolve(target.value, ctx.parentAgentConfig);
            }
            if (!resolved) {
                if (input.run_in_background === true) {
                    this.background?.metrics?.recordBackgroundTaskTool({
                        tool: 'task',
                        mode: 'background',
                        result: 'unknown_type',
                    });
                }
                return taskError(input, 'unknown_type', `Unknown subagent type: ${target.value}`);
            }
            if (input.run_in_background === true) {
                return this.executeInBackground(ctx, input, resolved, subSessionId, subTurnId, signal, reportBackgroundSetupFailure);
            }
            const run = await this.runSubagentTurn(ctx, input, resolved, subSessionId, subTurnId, signal);
            const finalText = run.finalText;
            const usage = run.usage;
            const errorCode = run.errorCode;
            const errorMessage = run.errorMessage;
            const terminalStatus = run.terminalStatus;
            const eventCount = run.eventCount;
            if (errorMessage) {
                const text = `<task_error>${errorCode ? `${errorCode}: ` : ''}${errorMessage}</task_error>`;
                return {
                    tool_name: CloudTaskToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        ...taskTargetDetails(input),
                        sub_session_id: subSessionId,
                        sub_turn_id: subTurnId,
                        // Preserve PiTurnRunner terminal class (DOC-2 §6 T02). `?? 'failed'`
                        // is defense — terminalStatus is set on every branch that produces
                        // errorMessage; the fallback should never fire.
                        status: errorCode ?? terminalStatus ?? 'failed',
                        ...(errorCode ? { error_code: errorCode } : {}),
                        is_error: true,
                        event_count: eventCount,
                    },
                };
            }
            // NO `task_id:` prefix — advertising a resume id we don't support would
            // confuse the model (bundle §1.7). Sub-session id stays in details.
            const text = `<task_result>\n${finalText}\n</task_result>`;
            const result = {
                tool_name: CloudTaskToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ...taskTargetDetails(input),
                    sub_session_id: subSessionId,
                    sub_turn_id: subTurnId,
                    event_count: eventCount,
                    ...(usage ? { usage } : {}),
                },
            };
            return withPluginHookCompatibleToolResponse(result, {
                status: 'completed',
                agentId: subSessionId,
                content: [{ type: 'text', text: finalText }],
                resolvedModel: resolved.config.model.model_id,
                ...(usage ? { totalTokens: usage.total_tokens } : {}),
            });
        }
        async executeInBackground(ctx, input, resolved, subSessionId, subTurnId, signal, reportSetupFailure) {
            // Per-user rollout gate (symmetric with cloud-bash executeInBackground).
            // archon-server assembler ships AgentConfig.background_task_enabled after the
            // Apollo whitelist+rollout decision; when not allowed (false / undefined for
            // pre-rollout or non-allowlisted users) we reject the background subagent and
            // let the model fall back to synchronous task. Bypass-proof backstop: tool
            // input is NOT schema-stripped (pi-turn-runner tools.ts passes params through
            // verbatim), so hiding run_in_background via GatedSyncTaskToolDef alone is not
            // sufficient.
            if (ctx.parentAgentConfig?.background_task_enabled !== true) {
                this.background?.metrics?.recordBackgroundTaskTool({
                    tool: 'task',
                    mode: 'background',
                    result: 'background_not_enabled',
                });
                const text = '<task_error>Background task execution is not enabled for this user</task_error>';
                return {
                    tool_name: CloudTaskToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        subagent_type: input.subagent_type,
                        sub_session_id: subSessionId,
                        sub_turn_id: subTurnId,
                        status: 'background_not_enabled',
                        is_error: true,
                    },
                };
            }
            const background = this.background;
            if (!background) {
                const text = '<task_error>Background task execution is not enabled</task_error>';
                return {
                    tool_name: CloudTaskToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        subagent_type: input.subagent_type,
                        sub_session_id: subSessionId,
                        sub_turn_id: subTurnId,
                        status: 'background_not_enabled',
                        is_error: true,
                    },
                };
            }
            const executionRefJson = stringifyJson({
                backend: 'cloud-runtime.piRunner.runTurn',
                sub_turn_id: subTurnId,
            });
            let started;
            try {
                started = await background.client.start({
                    kind: BackgroundTaskKind.Subagent,
                    owner_session_id: ctx.sessionId,
                    owner_turn_id: ctx.turnId,
                    ...(ctx.toolCallId ? { tool_call_id: ctx.toolCallId } : {}),
                    sub_session_id: subSessionId,
                    description: input.description,
                    input_json: stringifyJson({
                        description: input.description,
                        prompt: input.prompt,
                        ...taskTargetDetails(input),
                    }),
                    execution_ref_json: executionRefJson,
                }, signal);
            }
            catch {
                background.metrics?.recordBackgroundTaskTool({
                    tool: 'task',
                    mode: 'background',
                    result: 'background_start_failed',
                });
                if (reportSetupFailure) {
                    return reportSetupFailure(SUBAGENT_EXECUTION_FAILED, 'Child sub-agent execution failed', 'background_start');
                }
                logger.error(`[background-task] failed stage=background_start code=${SUBAGENT_EXECUTION_FAILED} parent_session_id=${ctx.sessionId} parent_turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId} sub_session_id=${subSessionId} sub_turn_id=${subTurnId}`);
                return taskError(input, SUBAGENT_EXECUTION_FAILED, `${SUBAGENT_EXECUTION_FAILED}: Child sub-agent execution failed`, { sub_session_id: subSessionId, sub_turn_id: subTurnId });
            }
            const taskId = started.task.taskId;
            const outputRef = stringifyJson({
                taskId,
                kind: 'session_transcript',
                uri: `session://${subSessionId}`,
            });
            void this.runBackgroundSubagent({
                ctx,
                input,
                resolved,
                subSessionId,
                subTurnId,
                taskId,
                leaseToken: started.leaseToken,
                outputRef,
                executionRefJson,
            });
            background.metrics?.recordBackgroundTaskTool({
                tool: 'task',
                mode: 'background',
                result: 'background_started',
            });
            const text = `<task_background>\nBackground task ${taskId} started.\n</task_background>`;
            const result = {
                tool_name: CloudTaskToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    ...taskTargetDetails(input),
                    task_id: taskId,
                    sub_session_id: subSessionId,
                    sub_turn_id: subTurnId,
                    status: 'background_started',
                    lease_until: started.leaseUntil,
                },
            };
            return withPluginHookCompatibleToolResponse(result, {
                status: 'async_launched',
                agentId: subSessionId,
                description: input.description,
                prompt: input.prompt,
                resolvedModel: resolved.config.model.model_id,
            });
        }
        async runBackgroundSubagent(args) {
            const background = this.background;
            if (!background)
                return;
            const controller = new AbortController();
            const intervalMs = positiveMs(background.heartbeatIntervalMs) ?? DEFAULT_BACKGROUND_HEARTBEAT_INTERVAL_MS;
            let stopRequested = false;
            let heartbeatInFlight;
            const heartbeat = async () => {
                if (heartbeatInFlight)
                    return heartbeatInFlight;
                heartbeatInFlight = background.client
                    .heartbeat({
                    task_id: args.taskId,
                    lease_token: args.leaseToken,
                    output_ref: args.outputRef,
                    execution_ref_json: args.executionRefJson,
                    sub_session_id: args.subSessionId,
                }, controller.signal)
                    .then((result) => {
                    if (result.abortRequested || result.status === 'stopping') {
                        stopRequested = true;
                        if (!controller.signal.aborted) {
                            controller.abort(new Error('Background task stop requested'));
                        }
                    }
                })
                    .catch(() => {
                    logger.warn(`[background-task] failed stage=heartbeat code=BACKGROUND_TASK_HEARTBEAT_FAILED task_id=${args.taskId} sub_session_id=${args.subSessionId}`);
                })
                    .finally(() => {
                    heartbeatInFlight = undefined;
                });
                return heartbeatInFlight;
            };
            const timer = setInterval(() => {
                void heartbeat();
            }, intervalMs);
            timer.unref?.();
            // Phase 6 headless ceiling: ALWAYS bound a background run. An explicit
            // headless_max_wait_ms overrides; otherwise a built-in default applies, so
            // enabling the gate without configuring a timeout can never run unbounded.
            let timedOut = false;
            const maxRunMs = positiveMs(background.maxRunMs) ?? DEFAULT_BACKGROUND_MAX_RUN_MS;
            const runTimer = setTimeout(() => {
                timedOut = true;
                stopRequested = true;
                if (!controller.signal.aborted) {
                    controller.abort(new Error(`Background task exceeded maxRunMs=${maxRunMs}`));
                }
            }, maxRunMs);
            runTimer.unref?.();
            const clearTimers = () => {
                clearInterval(timer);
                clearTimeout(runTimer);
            };
            logger.info(`[background-task] stage=runner_start code=BACKGROUND_TASK_STARTED task_id=${args.taskId} sub_session_id=${args.subSessionId} sub_turn_id=${args.subTurnId}`);
            const startedAt = Date.now();
            let run;
            try {
                await heartbeat();
                run = await this.runSubagentTurn(args.ctx, args.input, args.resolved, args.subSessionId, args.subTurnId, controller.signal);
            }
            catch {
                clearTimers();
                if (heartbeatInFlight)
                    await heartbeatInFlight.catch(() => undefined);
                const thrownStatus = controller.signal.aborted
                    ? BackgroundTaskStatus.Canceled
                    : BackgroundTaskStatus.Failed;
                const errorCode = controller.signal.aborted ? 'ABORTED' : SUBAGENT_EXECUTION_FAILED;
                const errorMessage = controller.signal.aborted
                    ? 'Background sub-agent aborted'
                    : 'Background sub-agent execution failed';
                logger.error(`[background-task] failed stage=run_subagent code=${errorCode} task_id=${args.taskId} sub_session_id=${args.subSessionId} sub_turn_id=${args.subTurnId}`);
                logger.info(`[background-task] stage=runner_finish code=${errorCode} task_id=${args.taskId} sub_session_id=${args.subSessionId} sub_turn_id=${args.subTurnId}`);
                background.metrics?.recordBackgroundTaskRunnerFinish({
                    kind: 'subagent',
                    status: backgroundTaskStatusLabel(thrownStatus),
                    reason: timedOut ? 'timeout' : stopRequested ? 'stopped' : 'error',
                    durationMs: Date.now() - startedAt,
                });
                await background.client
                    .finish({
                    task_id: args.taskId,
                    lease_token: args.leaseToken,
                    status: thrownStatus,
                    output_ref: args.outputRef,
                    execution_ref_json: args.executionRefJson,
                    sub_session_id: args.subSessionId,
                    last_error_json: stringifyJson({
                        code: errorCode,
                        message: errorMessage,
                    }),
                }, undefined)
                    .catch(() => {
                    logger.warn(`[background-task] failed stage=finish_after_failure code=BACKGROUND_TASK_FINISH_FAILED task_id=${args.taskId} sub_session_id=${args.subSessionId}`);
                });
                return;
            }
            clearTimers();
            if (heartbeatInFlight)
                await heartbeatInFlight;
            const status = stopRequested || run.terminalStatus === 'aborted'
                ? BackgroundTaskStatus.Canceled
                : run.errorMessage
                    ? BackgroundTaskStatus.Failed
                    : BackgroundTaskStatus.Succeeded;
            logger.info(`[background-task] stage=runner_finish code=BACKGROUND_TASK_FINISHED task_id=${args.taskId} sub_session_id=${args.subSessionId} sub_turn_id=${args.subTurnId}`);
            background.metrics?.recordBackgroundTaskRunnerFinish({
                kind: 'subagent',
                status: backgroundTaskStatusLabel(status),
                reason: timedOut ? 'timeout' : stopRequested ? 'stopped' : 'normal',
                durationMs: Date.now() - startedAt,
            });
            const persistedOutputRef = status === BackgroundTaskStatus.Succeeded
                ? await this.persistBackgroundSubagentOutput(args.taskId, run)
                : undefined;
            const safeLastError = run.errorMessage ? safeBackgroundSubagentError(run) : undefined;
            await background.client
                .finish({
                task_id: args.taskId,
                lease_token: args.leaseToken,
                status,
                output_ref: persistedOutputRef ? stringifyJson(persistedOutputRef) : args.outputRef,
                execution_ref_json: args.executionRefJson,
                sub_session_id: args.subSessionId,
                ...(safeLastError
                    ? {
                        last_error_json: stringifyJson(safeLastError),
                    }
                    : {}),
            }, undefined)
                .catch(() => {
                logger.warn(`[background-task] failed stage=finish code=BACKGROUND_TASK_FINISH_FAILED task_id=${args.taskId} sub_session_id=${args.subSessionId}`);
            });
        }
        async persistBackgroundSubagentOutput(taskId, run) {
            const outputStore = this.background?.outputStore;
            if (!outputStore)
                return undefined;
            try {
                const outputRef = await outputStore.append({
                    taskId,
                    stream: 'final_result',
                    content: run.finalText,
                    metadata: {
                        sub_session_id: run.subSessionId,
                        sub_turn_id: run.subTurnId,
                        event_count: run.eventCount,
                        ...(run.usage ? { usage: run.usage } : {}),
                    },
                });
                await outputStore.finalize(taskId, run.finalText);
                return outputRef;
            }
            catch {
                logger.warn(`[background-task] failed stage=output_persist code=BACKGROUND_TASK_OUTPUT_PERSIST_FAILED task_id=${taskId}`);
                return undefined;
            }
        }
        async runSubagentTurn(ctx, input, resolved, subSessionId, subTurnId, signal) {
            const agentType = input.agent_name ?? input.subagent_type ?? 'unknown';
            // Buffer locally for the parent-facing ToolResult, while the persistent
            // path also reports every frame through a reporter bound to the child
            // SessionExchange. The parent reporter is never referenced here.
            const buffered = [];
            const deferredUntilFlush = [];
            let repCounter = 0;
            const noopReporter = {
                nextEventId: (kind) => `sub-noop:${kind}:${++repCounter}`,
                nextRuntimeSeq: () => ++repCounter,
                appendEvents: async () => {
                    /* swallow — sub-tools cannot inject into parent SSE */
                },
            };
            const childReporter = resolved.childReporter ?? noopReporter;
            const messageStore = resolved.persistent ? this.runtime.messageStore : undefined;
            const reportChildEvents = async (events) => {
                try {
                    await childReporter.appendEvents(events);
                }
                catch (error) {
                    if (!messageStore)
                        throw error;
                    throw new CloudTaskPersistenceError('reporter', error);
                }
            };
            const deferOrReport = async (events) => {
                for (const event of events) {
                    if (messageStore && isPostFlushChildEvent(event))
                        deferredUntilFlush.push(event);
                    else
                        await reportChildEvents([event]);
                }
            };
            const persistenceFailureResult = async (error) => {
                const errorMessage = `Child persistence ${error.stage} failed`;
                try {
                    const failureEvent = makeChildFailedEvent(childReporter, subSessionId, subTurnId, SUBAGENT_PERSISTENCE_FAILED, errorMessage);
                    buffered.push(failureEvent);
                    await childReporter.appendEvents([failureEvent]);
                }
                catch {
                    logger.warn(`[cloud-task] child persistence failure report unavailable stage=${error.stage} code=${SUBAGENT_PERSISTENCE_FAILED} sub_session_id=${subSessionId} sub_turn_id=${subTurnId}`);
                }
                return {
                    subSessionId,
                    subTurnId,
                    finalText: '',
                    eventCount: buffered.length,
                    errorCode: SUBAGENT_PERSISTENCE_FAILED,
                    errorMessage,
                    terminalStatus: 'failed',
                };
            };
            const executionFailureResult = async () => {
                const errorMessage = 'Child sub-agent execution failed';
                const failureEvent = makeChildFailedEvent(childReporter, subSessionId, subTurnId, SUBAGENT_EXECUTION_FAILED, errorMessage);
                try {
                    await childReporter.appendEvents([failureEvent]);
                }
                catch {
                    logger.warn(`[cloud-task] child persistence failure report unavailable stage=reporter code=${SUBAGENT_PERSISTENCE_FAILED} sub_session_id=${subSessionId} sub_turn_id=${subTurnId}`);
                    return {
                        subSessionId,
                        subTurnId,
                        finalText: '',
                        eventCount: buffered.length,
                        errorCode: SUBAGENT_PERSISTENCE_FAILED,
                        errorMessage: 'Child persistence reporter failed',
                        terminalStatus: 'failed',
                    };
                }
                buffered.push(failureEvent);
                return {
                    subSessionId,
                    subTurnId,
                    finalText: '',
                    eventCount: buffered.length,
                    errorCode: SUBAGENT_EXECUTION_FAILED,
                    errorMessage,
                    terminalStatus: 'failed',
                };
            };
            const flushChildHistory = async () => {
                if (!messageStore)
                    return undefined;
                try {
                    await messageStore.flush(subSessionId);
                    return undefined;
                }
                catch (error) {
                    return new CloudTaskPersistenceError('flush', error);
                }
            };
            // Child-side privacy boundary: terminal runner causes never leave this bridge raw.
            const bridgeChildEvents = async (events) => {
                if (events.length === 0)
                    return;
                const safeEvents = events.map(normalizeChildTerminalEvent);
                buffered.push(...safeEvents);
                await deferOrReport(safeEvents);
            };
            const eventWriter = {
                pushRuntime: async (event) => bridgeChildEvents([event]),
                appendEvents: async (events) => bridgeChildEvents(events),
            };
            let persistedHistory = [];
            if (messageStore) {
                try {
                    persistedHistory = await messageStore.getOrLoad(subSessionId);
                }
                catch (error) {
                    const flushError = await flushChildHistory();
                    return persistenceFailureResult(flushError ?? new CloudTaskPersistenceError('load', error));
                }
            }
            const history = persistedHistory.map((entry) => entry.message);
            const persistChildHistory = messageStore
                ? async (change) => {
                    if (change.reason !== 'messageDelta' || change.messages.length === 0)
                        return;
                    const messages = change.messages.map((message) => ({
                        message_id: `msg-${randomUUID()}`,
                        turn_id: subTurnId,
                        message,
                    }));
                    try {
                        messageStore.append(subSessionId, messages);
                    }
                    catch (error) {
                        throw new CloudTaskPersistenceError('append', error);
                    }
                    deferredUntilFlush.push(...messages.map((entry) => ({
                        schema: RUNTIME_EVENT_SCHEMA,
                        event_id: childReporter.nextEventId('message_persisted'),
                        session_id: subSessionId,
                        turn_id: subTurnId,
                        runtime_seq: childReporter.nextRuntimeSeq(),
                        type: RuntimeEventType.MESSAGE_PERSISTED,
                        payload: {
                            message_id: entry.message_id,
                            body_json: JSON.stringify(entry.message),
                            runtime_kind: 'pi',
                        },
                    })));
                }
                : undefined;
            const subTimezone = ctx.timezone ?? resolved.config.timezone;
            // Explicit construction — NEVER spread {...ctx}. Spreading would leak the
            // parent's reporter, breaking the isolation invariant (deep's R2 bug).
            // bizId / workspace / credentials are inherited runtime resources, but
            // session-scoped RPC ownership is the real persisted child Session.
            const subToolContext = {
                sessionId: resolved.persistent ? subSessionId : ctx.sessionId,
                turnId: subTurnId,
                workspaceRoot: this.workspaceRoot,
                reporter: childReporter,
                parentAgentConfig: resolved.config,
                ...(resolved.skillLookup
                    ? { skillLookup: resolved.skillLookup }
                    : ctx.skillLookup
                        ? { skillLookup: ctx.skillLookup }
                        : {}),
                ...(ctx.pluginHooks ? { pluginHooks: ctx.pluginHooks } : {}),
                ...((resolved.pluginMcpToolOwners ?? ctx.pluginMcpToolOwners)
                    ? { pluginMcpToolOwners: resolved.pluginMcpToolOwners ?? ctx.pluginMcpToolOwners }
                    : {}),
                ...(ctx.pluginSubagentLifecycle
                    ? { pluginSubagentLifecycle: ctx.pluginSubagentLifecycle }
                    : {}),
                ...(ctx.bizId ? { bizId: ctx.bizId } : {}),
                ...(ctx.requestSk ? { requestSk: ctx.requestSk } : {}),
                ...(ctx.secretStore ? { secretStore: ctx.secretStore } : {}),
                ...(resolved.config.model?.api_key ? { apiKey: resolved.config.model.api_key } : {}),
                ...(resolved.config.agent_id !== undefined
                    ? { agentId: String(resolved.config.agent_id) }
                    : {}),
                ...(subTimezone ? { timezone: subTimezone } : {}),
                // 父 turn 的 traceId 透传给子 turn:同一个 inbound request 的延续,
                // 共享 trace 才能让 LLM 网关 / Jaeger 把父子 turn 关联起来。
                ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
            };
            // Chain supplied abort signal — repo idiom (pi-turn-runner.ts:546-552).
            // No AbortSignal.any (Node 20.3+; not worth the version pin).
            const childController = new AbortController();
            const onParentAbort = () => childController.abort(signal.reason);
            if (signal?.aborted)
                childController.abort(signal.reason);
            else
                signal?.addEventListener('abort', onParentAbort, { once: true });
            let pluginTranscript;
            let result;
            let caughtError;
            let didCatch = false;
            try {
                pluginTranscript =
                    (ctx.pluginHooks?.length ?? 0) > 0
                        ? await createSubagentPluginTranscript(this.workspaceRoot, subSessionId)
                        : undefined;
                const pluginStartDecision = await ctx.pluginSubagentLifecycle?.start({
                    childSessionId: subSessionId,
                    childTurnId: subTurnId,
                    agentId: subSessionId,
                    agentType,
                    agentTranscriptPath: pluginTranscript?.path ?? null,
                    agentCodexTranscriptPath: pluginTranscript?.codexPath ?? null,
                    model: resolved.config.model.model_id,
                    permissionMode: 'bypassPermissions',
                    effort: cloudPluginHookEffort(resolved.config.model),
                }, childController.signal);
                if (pluginStartDecision?.continue === false) {
                    const errorMessage = pluginStartDecision.stopReason ??
                        pluginStartDecision.systemMessage ??
                        'Sub-agent stopped by Plugin Hook.';
                    return {
                        subSessionId,
                        subTurnId,
                        finalText: '',
                        eventCount: 0,
                        errorMessage,
                        terminalStatus: 'failed',
                    };
                }
                const beforeToolCall = this.runtime.buildBeforeToolCallHook?.(resolved.config, subToolContext);
                const buildLLMModelConfig = this.runtime.buildLLMModelConfig ?? buildDefaultCloudLLMModelConfig;
                let llm = await buildLLMModelConfig(resolved.config, {
                    sessionId: subSessionId,
                    turnId: subTurnId,
                });
                const modelResponseObserver = llm.responseObserver;
                llm = {
                    ...llm,
                    ...(subToolContext.traceId
                        ? { headers: { ...(llm.headers ?? {}), 'X-MM-Request-Id': subToolContext.traceId } }
                        : {}),
                    responseObserver: async (response, model) => {
                        await modelResponseObserver?.(response, model);
                        const traceHeader = this.runtime.pickTraceIdHeader?.(response.headers);
                        if (traceHeader) {
                            logger.info(`[cloud-task] stage=llm_response code=LLM_RESPONSE_RECEIVED sub_session_id=${subSessionId} sub_turn_id=${subTurnId} downstream_trace_id=${traceHeader.value}`);
                        }
                    },
                };
                const pluginControl = buildSubagentPluginHooks(subToolContext, subSessionId, subTurnId, resolved.tools, childController.signal, pluginTranscript, resolved.config.model.model_id, cloudPluginHookEffort(resolved.config.model), agentType);
                const hooks = {
                    ...(pluginControl?.hooks ?? {}),
                    ...(beforeToolCall
                        ? {
                            beforeToolCallHook: [
                                ...(pluginControl?.hooks.beforeToolCallHook ?? []),
                                beforeToolCall,
                            ],
                        }
                        : {}),
                    ...(persistChildHistory
                        ? {
                            onHistoryChangedHook: [
                                ...(pluginControl?.hooks.onHistoryChangedHook ?? []),
                                persistChildHistory,
                            ],
                        }
                        : {}),
                };
                await this.piRunner.runTurn({
                    sessionId: subSessionId,
                    turnId: subTurnId,
                    workspaceDir: this.workspaceRoot,
                    // Raw system_prompt from the fixed subagent type — do NOT pass through
                    // PromptComposer (it is parent-only; bundle §1.7). Description /
                    // persona / BASE_PROMPT are not added for sub-agents.
                    systemPrompt: resolved.config.system_prompt,
                    userMessage: {
                        text: [
                            withMcodeToolsMasterReminder({
                                reminderText: undefined,
                                modelID: resolved.config.model.model_id,
                                enabled: resolved.config.skills.some((skill) => skill.name === 'mcode-tools-master'),
                            }),
                            appendPluginHookContext(input.prompt, pluginStartDecision?.additionalContext),
                        ].join('\n\n'),
                    },
                    llm,
                    eventWriter,
                    history,
                    signal: childController.signal,
                    toolConfig: {
                        // Filtered upstream — MUST NEVER contain 'task' (recursion guard).
                        // Disable pi builtin fallback so this remains an exact allowlist.
                        tools: resolved.tools,
                        disableBuiltinToolFallback: true,
                        context: subToolContext,
                    },
                    hooks: withCloudToolTargetHooks(resolved.tools, hooks),
                    ...(pluginControl
                        ? {
                            getSteeringMessages: pluginControl.getSteeringMessages,
                            tryBeginClose: pluginControl.tryBeginClose,
                        }
                        : {}),
                });
                const terminal = extractSubagentTerminal(buffered);
                if (terminal.status === 'aborted') {
                    const safeError = safeBackgroundSubagentError({ terminalStatus: 'aborted' });
                    result = {
                        subSessionId,
                        subTurnId,
                        finalText: '',
                        eventCount: buffered.length,
                        errorMessage: `${safeError.code}: ${safeError.message}`,
                        terminalStatus: 'aborted',
                    };
                }
                else if (terminal.status === 'failed') {
                    const safeError = safeBackgroundSubagentError({ terminalStatus: 'failed' });
                    result = {
                        subSessionId,
                        subTurnId,
                        finalText: '',
                        eventCount: buffered.length,
                        errorMessage: `${safeError.code}: ${safeError.message}`,
                        terminalStatus: 'failed',
                    };
                }
                else {
                    result = {
                        subSessionId,
                        subTurnId,
                        finalText: extractFinalAssistantText(buffered),
                        eventCount: buffered.length,
                        ...(extractFinalAssistantUsageFromBuffer(buffered)
                            ? { usage: extractFinalAssistantUsageFromBuffer(buffered) }
                            : {}),
                    };
                }
            }
            catch (error) {
                didCatch = true;
                caughtError = error;
            }
            finally {
                ctx.pluginSubagentLifecycle?.cancel(subSessionId);
                await pluginTranscript?.cleanup().catch(() => undefined);
                if (signal)
                    signal.removeEventListener('abort', onParentAbort);
            }
            const flushError = await flushChildHistory();
            if (flushError)
                return persistenceFailureResult(flushError);
            if (caughtError instanceof CloudTaskPersistenceError) {
                return persistenceFailureResult(caughtError);
            }
            if (didCatch && resolved.persistent) {
                logger.error(`[cloud-task] child execution failed stage=run_subagent_turn code=${SUBAGENT_EXECUTION_FAILED} parent_session_id=${ctx.sessionId} parent_turn_id=${ctx.turnId} sub_session_id=${subSessionId} sub_turn_id=${subTurnId}`);
            }
            const expectedTerminalStatus = result?.terminalStatus === 'failed'
                ? RuntimeEventStatus.FAILED
                : result?.terminalStatus === 'aborted'
                    ? RuntimeEventStatus.ABORTED
                    : RuntimeEventStatus.COMPLETED;
            const publishableDeferred = deferredUntilFlush.filter((event) => event.type === RuntimeEventType.MESSAGE_PERSISTED ||
                (!didCatch &&
                    event.type === RuntimeEventType.SESSION_STATUS &&
                    event.payload?.status === expectedTerminalStatus));
            if (publishableDeferred.length > 0) {
                try {
                    await reportChildEvents(publishableDeferred);
                }
                catch (error) {
                    if (error instanceof CloudTaskPersistenceError) {
                        return persistenceFailureResult(error);
                    }
                    throw error;
                }
            }
            if (didCatch) {
                if (resolved.persistent || input.run_in_background !== true)
                    return executionFailureResult();
                throw caughtError;
            }
            if (!result)
                throw new Error('Sub-agent run completed without a result');
            return result;
        }
    };
    return CloudTaskTool = _classThis;
})();
export { CloudTaskTool };
function buildSubagentPluginHooks(ctx, subSessionId, subTurnId, tools, signal, transcript, model, effort, agentType) {
    const handlers = ctx.pluginHooks ?? [];
    const lifecycle = ctx.pluginSubagentLifecycle;
    if (handlers.length === 0 || !lifecycle)
        return undefined;
    const hookTargets = cloudToolHookTargets(tools);
    const toolContexts = new Map();
    const toolStartedAtMs = new Map();
    let stopHookActive = false;
    const beforeToolCallHook = async (toolContext) => {
        const eventContext = {
            sessionId: subSessionId,
            turnId: subTurnId,
            promptId: subTurnId,
            transcriptPath: transcript?.path ?? null,
            codexTranscriptPath: transcript?.codexPath ?? null,
            model,
            effort,
            permissionMode: 'bypassPermissions',
            cwd: ctx.workspaceRoot,
            matcherValue: toolContext.toolCall.name,
            ...pluginMcpToolProvenance(ctx, toolContext.toolCall.name),
        };
        const result = await lifecycle.runEvent({
            event: 'PreToolUse',
            ...eventContext,
            payload: {
                tool_name: toolContext.toolCall.name,
                tool_input: objectRecord(toolContext.args),
                tool_use_id: toolContext.toolCall.id,
                agent_id: subSessionId,
                agent_type: agentType,
            },
        }, signal);
        const invalidRewrite = applyPluginToolRewrite(hookTargets, toolContext, result.decision.updatedInput);
        if (invalidRewrite) {
            toolContexts.delete(toolContext.toolCall.id);
            return { block: true, reason: invalidRewrite };
        }
        const additionalContext = result.decision.additionalContext?.trim();
        if (additionalContext)
            toolContexts.set(toolContext.toolCall.id, additionalContext);
        if (result.decision.continue === false) {
            toolContexts.delete(toolContext.toolCall.id);
            return {
                block: true,
                terminateAgent: true,
                reason: result.decision.stopReason ?? result.decision.reason ?? 'Agent stopped by Plugin Hook.',
            };
        }
        if (result.decision.decision === 'deny' ||
            result.decision.decision === 'defer' ||
            result.decision.toolPermissionDecision === 'deny' ||
            result.decision.toolPermissionDecision === 'defer') {
            toolContexts.delete(toolContext.toolCall.id);
            return {
                block: true,
                reason: mergePluginHookContext(result.decision.reason ??
                    (result.decision.decision === 'defer' ||
                        result.decision.toolPermissionDecision === 'defer'
                        ? 'Plugin Hook requested deferred approval, but Cloud cannot defer tool execution.'
                        : 'Tool blocked by Plugin Hook.'), additionalContext) ?? 'Tool blocked by Plugin Hook.',
            };
        }
        if (result.decision.decision === 'ask' || result.decision.toolPermissionDecision === 'ask') {
            const permission = await lifecycle.runEvent({
                event: 'PermissionRequest',
                ...eventContext,
                payload: {
                    tool_name: toolContext.toolCall.name,
                    tool_input: objectRecord(toolContext.args),
                    tool_use_id: toolContext.toolCall.id,
                    agent_id: subSessionId,
                    agent_type: agentType,
                },
            }, signal);
            const permissionUpdatedInputIsValid = !permission.decision.updatedInput ||
                isRuntimeToolInputValid(hookTargets, toolContext.toolCall.name, permission.decision.updatedInput);
            const permissionUpdatesAreSupported = !permission.decision.updatedPermissions?.length;
            if (permission.decision.updatedInput &&
                permissionUpdatedInputIsValid &&
                permissionUpdatesAreSupported) {
                replaceObject(toolContext.args, permission.decision.updatedInput);
            }
            if (permissionUpdatedInputIsValid &&
                permissionUpdatesAreSupported &&
                permission.decision.permissionDecision === 'allow' &&
                // The current prompt was explicitly requested by PreToolUse. Only
                // Codex `any_prompt` may approve that prompt; Compatible `ordinary_only`
                // is limited to an ordinary host permission check.
                permission.decision.permissionAutoApproval === 'any_prompt' &&
                permission.decision.decision !== 'deny' &&
                permission.decision.continue !== false &&
                permission.decision.interrupt !== true) {
                return undefined;
            }
            toolContexts.delete(toolContext.toolCall.id);
            return {
                block: true,
                ...(permission.decision.continue === false || permission.decision.interrupt === true
                    ? { terminateAgent: true }
                    : {}),
                reason: permission.decision.stopReason ??
                    permission.decision.reason ??
                    (!permissionUpdatedInputIsValid
                        ? 'PermissionRequest Hook returned invalid tool input.'
                        : !permissionUpdatesAreSupported
                            ? 'PermissionRequest Hook requested local permission updates, which Cloud cannot persist.'
                            : permission.decision.permissionDecision === 'deny'
                                ? 'Permission denied by Plugin Hook.'
                                : 'Plugin Hook requested approval, but Cloud has no interactive permission UI.'),
            };
        }
        return undefined;
    };
    const afterToolCallHook = async (toolContext) => {
        const startedAt = toolStartedAtMs.get(toolContext.toolCall.id);
        toolStartedAtMs.delete(toolContext.toolCall.id);
        const compatibleToolResponse = readCloudCompatibleToolResponse(toolContext.result);
        const codexToolResponse = readCloudCodexToolResponse(toolContext.result);
        const isError = isCloudPluginHookToolFailure(toolContext.toolCall.name, toolContext.result, toolContext.isError);
        const result = await lifecycle.runEvent({
            event: 'PostToolUse',
            sessionId: subSessionId,
            turnId: subTurnId,
            promptId: subTurnId,
            transcriptPath: transcript?.path ?? null,
            codexTranscriptPath: transcript?.codexPath ?? null,
            model,
            effort,
            permissionMode: 'bypassPermissions',
            cwd: ctx.workspaceRoot,
            matcherValue: toolContext.toolCall.name,
            ...pluginMcpToolProvenance(ctx, toolContext.toolCall.name),
            payload: {
                tool_name: toolContext.toolCall.name,
                tool_input: objectRecord(toolContext.args),
                tool_use_id: toolContext.toolCall.id,
                tool_result: toolContext.result,
                ...(compatibleToolResponse ? { compatible_tool_response: compatibleToolResponse } : {}),
                ...(codexToolResponse !== undefined ? { codex_tool_response: codexToolResponse } : {}),
                is_error: isError,
                agent_id: subSessionId,
                agent_type: agentType,
                ...(startedAt !== undefined ? { duration_ms: Date.now() - startedAt } : {}),
            },
        }, signal);
        const context = mergePluginHookContext(toolContexts.get(toolContext.toolCall.id), result.decision.additionalContext);
        toolContexts.delete(toolContext.toolCall.id);
        return buildCloudPluginHookAfterToolResult({
            toolName: toolContext.toolCall.name,
            originalContent: toolContext.result.content,
            decision: result.decision,
            additionalContext: context,
        });
    };
    const stopContinuations = [];
    let stopContinuationCount = 0;
    return {
        hooks: {
            beforeToolCallHook: [beforeToolCallHook],
            onToolExecutionStartHook: [
                (toolContext) => {
                    toolStartedAtMs.set(toolContext.toolCall.id, Date.now());
                },
            ],
            afterToolCallHook: [afterToolCallHook],
            ...(transcript
                ? {
                    onHistoryChangedHook: [async (change) => transcript.onHistoryChanged(change)],
                }
                : {}),
        },
        getSteeringMessages: () => stopContinuations.splice(0),
        tryBeginClose: async ({ lastAssistantMessage }) => {
            const decision = await lifecycle.finish({
                childSessionId: subSessionId,
                childTurnId: subTurnId,
                stopHookActive,
                ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
            }, signal);
            if (decision.continue === false) {
                lifecycle.complete(subSessionId);
                return true;
            }
            if (decision.continuePrompt) {
                if (stopContinuationCount >= CLOUD_PLUGIN_STOP_CONTINUATION_LIMIT) {
                    logger.warn(`[plugin-hooks] forcing subagent close after ${CLOUD_PLUGIN_STOP_CONTINUATION_LIMIT} Stop continuations session=${subSessionId}`);
                    lifecycle.complete(subSessionId);
                    return true;
                }
                stopContinuationCount += 1;
                stopHookActive = true;
                stopContinuations.push({
                    role: 'user',
                    content: [{ type: 'text', text: decision.continuePrompt }],
                    timestamp: Date.now(),
                });
                return false;
            }
            lifecycle.complete(subSessionId);
            return true;
        },
    };
}
function pluginMcpToolProvenance(ctx, toolName) {
    const pluginName = ctx.pluginMcpToolOwners?.get(toolName);
    return pluginName ? { toolProvenance: { kind: 'plugin_mcp', pluginName } } : {};
}
async function createSubagentPluginTranscript(workspaceRoot, sessionId) {
    try {
        return await PluginHookTranscript.create({ cwd: workspaceRoot, sessionId, messages: [] });
    }
    catch (error) {
        logger.warn(`[plugin-hooks] subagent transcript creation failed open session=${sessionId} err=${formatError(error)}`);
        return undefined;
    }
}
function objectRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function replaceObject(target, next) {
    if (!target || typeof target !== 'object' || Array.isArray(target))
        return;
    const record = target;
    for (const key of Object.keys(record))
        delete record[key];
    Object.assign(record, next);
}
function applyPluginToolRewrite(tools, context, updatedInput) {
    if (!updatedInput)
        return undefined;
    if (!isRuntimeToolInputValid(tools, context.toolCall.name, updatedInput)) {
        return `PreToolUse Plugin Hook returned invalid input for ${context.toolCall.name}.`;
    }
    replaceObject(context.args, updatedInput);
    return undefined;
}
function appendPluginHookContext(prompt, context) {
    return context?.trim()
        ? `${prompt}\n\n<plugin-hook-context>\n${context.trim()}\n</plugin-hook-context>`
        : prompt;
}
class CloudTaskPersistenceError extends Error {
    stage;
    constructor(stage, _originalError) {
        super(`Child persistence ${stage} failed`);
        this.stage = stage;
        this.name = 'CloudTaskPersistenceError';
    }
}
function isPostFlushChildEvent(event) {
    return (event.type === RuntimeEventType.MESSAGE_PERSISTED ||
        (event.type === RuntimeEventType.SESSION_STATUS &&
            (event.payload?.status === RuntimeEventStatus.COMPLETED ||
                event.payload?.status === RuntimeEventStatus.FAILED ||
                event.payload?.status === RuntimeEventStatus.ABORTED)));
}
function makeChildFailedEvent(reporter, sessionId, turnId, code, errorMessage) {
    const message = `${code}: ${errorMessage}`;
    return {
        schema: RUNTIME_EVENT_SCHEMA,
        event_id: reporter.nextEventId('session_status'),
        session_id: sessionId,
        turn_id: turnId,
        runtime_seq: reporter.nextRuntimeSeq(),
        type: RuntimeEventType.SESSION_STATUS,
        payload: {
            status: RuntimeEventStatus.FAILED,
            stop_reason: { type: RuntimeStopReasonType.ERROR, message },
            error: { code: ProtocolErrorCode.INTERNAL_ERROR, message },
        },
    };
}
function normalizeChildTerminalEvent(event) {
    const status = event.payload.status;
    if (event.type !== RuntimeEventType.SESSION_STATUS ||
        (status !== RuntimeEventStatus.FAILED && status !== RuntimeEventStatus.ABORTED)) {
        return event;
    }
    const terminalStatus = status === RuntimeEventStatus.ABORTED ? 'aborted' : 'failed';
    const safeError = safeBackgroundSubagentError({ terminalStatus });
    const message = `${safeError.code}: ${safeError.message}`;
    return {
        ...event,
        payload: {
            status,
            ...(event.payload.usage ? { usage: event.payload.usage } : {}),
            stop_reason: {
                type: terminalStatus === 'aborted' ? RuntimeStopReasonType.ABORT : RuntimeStopReasonType.ERROR,
                message,
            },
            error: {
                code: terminalStatus === 'aborted'
                    ? ProtocolErrorCode.ABORTED
                    : ProtocolErrorCode.INTERNAL_ERROR,
                message,
            },
        },
    };
}
function resolveTaskTarget(input) {
    const hasAgentName = input.agent_name !== undefined;
    const hasLegacyAlias = input.subagent_type !== undefined;
    if (hasAgentName === hasLegacyAlias)
        return undefined;
    if (hasAgentName) {
        const value = input.agent_name ?? '';
        return value.trim() ? { kind: 'agent_name', value } : undefined;
    }
    const value = input.subagent_type ?? '';
    return value.trim() ? { kind: 'subagent_type', value } : undefined;
}
function taskTargetDetails(input) {
    return {
        ...(input.agent_name !== undefined ? { agent_name: input.agent_name } : {}),
        ...(input.subagent_type !== undefined ? { subagent_type: input.subagent_type } : {}),
    };
}
function taskError(input, code, message, details = {}) {
    const stableCodeInText = STABLE_COORDINATOR_ERROR_CODES.has(code);
    const text = `<task_error>${stableCodeInText && message !== code ? `${code}: ` : ''}${message}</task_error>`;
    return {
        tool_name: CloudTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
            ...taskTargetDetails(input),
            ...details,
            status: code,
            error_code: code,
            is_error: true,
        },
    };
}
function stableCoordinatorErrorCode(statusMessage) {
    return STABLE_COORDINATOR_ERROR_CODES.has(statusMessage) ? statusMessage : undefined;
}
/** Project the accepted parent model without api_key/base_url credentials. */
export function toParentModelSelection(agentConfig) {
    const model = agentConfig.model;
    const providerId = model?.provider?.trim();
    const modelId = model?.model_id?.trim();
    if (!providerId || !modelId)
        return undefined;
    const level = model.thinking_level;
    const budgets = model.thinking_budgets;
    const effort = model.thinking_effort || thinkingEffortFromLevel(level);
    const normalizedBudgets = budgets
        ? {
            ...(toFiniteNumber(budgets.minimal) !== undefined
                ? { minimal: toFiniteNumber(budgets.minimal) }
                : {}),
            ...(toFiniteNumber(budgets.low) !== undefined ? { low: toFiniteNumber(budgets.low) } : {}),
            ...(toFiniteNumber(budgets.medium) !== undefined
                ? { medium: toFiniteNumber(budgets.medium) }
                : {}),
            ...(toFiniteNumber(budgets.high) !== undefined
                ? { high: toFiniteNumber(budgets.high) }
                : {}),
        }
        : undefined;
    const thinking = {
        ...(effort ? { effort } : {}),
        ...(model.thinking_off_behavior ? { off_behavior: model.thinking_off_behavior } : {}),
        ...(normalizedBudgets && Object.keys(normalizedBudgets).length > 0
            ? { budgets: normalizedBudgets }
            : {}),
    };
    return {
        provider_id: providerId,
        model_id: modelId,
        ...(level !== undefined
            ? {
                variant: level === ThinkingLevel.OFF ? 'none-thinking' : 'thinking',
                reasoning: level !== ThinkingLevel.OFF,
            }
            : {}),
        ...(Object.keys(thinking).length > 0 ? { thinking } : {}),
        ...(toFiniteNumber(model.context_window) !== undefined
            ? { context_window: toFiniteNumber(model.context_window) }
            : {}),
        ...(toFiniteNumber(model.max_tokens) !== undefined
            ? { max_output_tokens: toFiniteNumber(model.max_tokens) }
            : {}),
    };
}
function thinkingEffortFromLevel(level) {
    switch (level) {
        case ThinkingLevel.MINIMAL:
            return 'minimal';
        case ThinkingLevel.LOW:
            return 'low';
        case ThinkingLevel.MEDIUM:
            return 'medium';
        case ThinkingLevel.HIGH:
            return 'high';
        case ThinkingLevel.XHIGH:
            return 'xhigh';
        default:
            return undefined;
    }
}
function toFiniteNumber(value) {
    if (value === undefined || value === '')
        return undefined;
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? number : undefined;
}
function positiveMs(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function safeBackgroundSubagentError(run) {
    if (run.errorCode === SUBAGENT_PERSISTENCE_FAILED) {
        return { code: SUBAGENT_PERSISTENCE_FAILED, message: 'Child persistence failed' };
    }
    if (run.terminalStatus === 'aborted') {
        return { code: 'ABORTED', message: 'Sub-agent aborted' };
    }
    return { code: SUBAGENT_EXECUTION_FAILED, message: 'Child sub-agent execution failed' };
}
function backgroundTaskStatusLabel(status) {
    switch (status) {
        case BackgroundTaskStatus.Queued:
            return 'queued';
        case BackgroundTaskStatus.Running:
            return 'running';
        case BackgroundTaskStatus.Stopping:
            return 'stopping';
        case BackgroundTaskStatus.Succeeded:
            return 'succeeded';
        case BackgroundTaskStatus.Failed:
            return 'failed';
        case BackgroundTaskStatus.Canceled:
            return 'canceled';
        case BackgroundTaskStatus.Lost:
            return 'lost';
        default:
            return 'unknown';
    }
}
function extractSubagentTerminal(events) {
    let status;
    for (const event of events) {
        if (event.type !== RuntimeEventType.SESSION_STATUS)
            continue;
        if (event.payload?.status === RuntimeEventStatus.COMPLETED) {
            status = 'completed';
        }
        else if (event.payload?.status === RuntimeEventStatus.ABORTED) {
            status = 'aborted';
        }
        else if (event.payload?.status === RuntimeEventStatus.FAILED) {
            status = 'failed';
        }
    }
    return status ? { status } : {};
}
function stringifyJson(value) {
    return JSON.stringify(value);
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=cloud-task.js.map