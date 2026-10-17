/**
 * CloudBashTool —— `bash` 工具的 cloud 实现。
 *
 * 默认行为是把命令转发到 archon-server sandbox-control 的 `executeShell`
 * RPC,沙箱内跑完一次性返回 stdout/stderr/exit_code/timed_out。
 *
 * 优化:常见的纯文件操作命令(ls / cat / find / grep / head / tail / wc /
 * pwd / echo)直接走 `tryLocalDispatch` 在 cloud-runtime 进程内用 node fs
 * 解析,绕过沙箱调度。详见 `./local-shell/`。LLM 看到的 details 里有
 * `dispatched_locally: true/false` 区分。
 *
 * **Observability**:每次 execute 只记录固定 `stage` / `code` 与
 * session、turn、tool call、background task 等非敏感 ID。**不**记录完整
 * context、命令、stdout/stderr、环境变量或下游原始错误。
 *
 * **不支持** 流式 onData —— PiTurnRunner 装配的 `AgentTool.execute` 只
 * 返回一次结果。如果未来需要把 LLM 看到的 stdout 流式回显,要在 PiTurnRunner
 * 上单独加一个 toolStreamSink 端口,本文件保持简单。
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
import { CloudBashToolDef as BashToolDef, } from './builtin-defs.js';
import { SHELL_EXECUTION_POLICY, logger } from './runtime-types.js';
import { BackgroundTaskKind, BackgroundTaskStatus, ShellExecutionPolicy, ShellJobStatus, } from './runtime-types.js';
import { tryLocalDispatch } from './local-shell/index.js';
import { collectSecretEnvVars } from './secret-env-inject.js';
import { withCloudCompatibleToolResponse } from './cloud-plugin-hook-response.js';
const DEFAULT_BACKGROUND_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_BACKGROUND_MAX_RUN_MS = 30 * 60 * 1000;
const BackgroundBashToolDef = {
    name: BashToolDef.name,
    executionMode: BashToolDef.executionMode,
    description: [
        BashToolDef.description,
        '',
        'When run_in_background is true, start the command as a background bash task and return a task id immediately. Use task_query, task_output, and task_stop to inspect or control it.',
        'Set run_in_background to true for open-ended or slow commands expected to take more than ~1 minute (builds, installs, dependency resolution, test suites, training, large downloads, long-running servers), so you can keep working and the result is reported back when it finishes. Keep it false for quick commands whose output you need immediately to proceed.',
    ].join('\n'),
    schema: Type.Object({
        ...BashToolDef.schema.properties,
        run_in_background: Type.Optional(Type.Boolean({
            description: 'Run the shell command asynchronously and return a background task id immediately, ' +
                'instead of blocking until it finishes. ' +
                'Set to true when the command is open-ended or expected to take more than ~1 minute ' +
                '(builds, installs, test suites, training, large downloads, long-running servers, anything whose duration you cannot predict), ' +
                'so you can keep working and the result is reported back automatically when it completes. ' +
                'Leave false (the default) for quick commands (<~1 minute) whose output you need right now to continue. ' +
                'When in doubt for a long or uncertain command, prefer true.',
        })),
    }),
};
let CloudBashTool = (() => {
    let _classDecorators = [bindTool(BackgroundBashToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var CloudBashTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            CloudBashTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        archonServer;
        background;
        constructor(archonServer, background) {
            this.archonServer = archonServer;
            this.background = background;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            if (input.run_in_background === true) {
                return this.executeInBackground(ctx, input, signal);
            }
            // Local fast-path: file-op commands run in-process via node fs and
            // never touch the sandbox. `tryLocalDispatch` returns a
            // discriminated union — the `handler` field marks a local hit.
            const outcome = await tryLocalDispatch(input.command, ctx.workspaceRoot, signal);
            if ('handler' in outcome) {
                logger.info(`[cloud-bash] stage=local_dispatch code=CLOUD_BASH_LOCAL_COMPLETED session_id=${ctx.sessionId} turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId ?? 'none'}`);
                return withCloudCompatibleToolResponse({
                    tool_name: BashToolDef.name,
                    text: outcome.text,
                    content: [{ type: 'text', text: outcome.text }],
                    details: {
                        exit_code: outcome.exitCode,
                        timed_out: false,
                        duration_ms: outcome.durationMs,
                        dispatched_locally: true,
                        local_handler: outcome.handler,
                    },
                }, {
                    stdout: outcome.stdout,
                    stderr: outcome.stderr,
                    interrupted: false,
                    isImage: false,
                });
            }
            // 把 turn-scoped SecretStore 里的 secret 收集成 `env_vars` map,经
            // archon-server `ExecuteShellReq.env_vars`(IDL field 5)透传到沙箱
            // (sandbox-control → e2b `sbx.commands.run(envs=...)`),沙箱内 shell
            // 把它们解析成进程 env,后续 `${SECRET_NAME}` 引用就能展开。空 store /
            // 缺失 ctx.secretStore 时返 undefined,不带该字段,零开销。LLM 看到的
            // input.command 仍是原值(`echo $OPENAI_API_KEY` 这种),secret value
            // **不再**进入 command wire,只活在结构化 env_vars 字段里直到沙箱出口。
            //
            // 注意:这里**不**对 env_vars 做 mask(masker 是出方向闸口);sandbox
            // 必须收到真实 value 才能跑命令,这是设计意图。
            const envVars = collectSecretEnvVars(ctx.secretStore);
            let res;
            try {
                res = await this.archonServer.executeShell(ctx, {
                    command: input.command,
                    ...(input.timeout ? { timeout_seconds: input.timeout } : {}),
                    execution_policy: SHELL_EXECUTION_POLICY.ReusePersistent,
                    ...(envVars ? { env_vars: envVars } : {}),
                }, signal);
            }
            catch {
                if (signal?.aborted)
                    throw new Error('Operation aborted');
                logger.error(`[cloud-bash] stage=shell_execute code=CLOUD_BASH_SHELL_EXECUTION_FAILED session_id=${ctx.sessionId} turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId ?? 'none'}`);
                const text = '<bash_error>CLOUD_BASH_SHELL_EXECUTION_FAILED: Shell command execution failed</bash_error>';
                return {
                    tool_name: BashToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        status: 'shell_execution_failed',
                        dispatched_locally: false,
                        local_dispatch_skip_reason: outcome.reason,
                    },
                };
            }
            logger.info(`[cloud-bash] stage=shell_execute code=CLOUD_BASH_SHELL_COMPLETED session_id=${ctx.sessionId} turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId ?? 'none'}`);
            // Surface `output_truncated` to the model. The flag is set by sandbox-control's
            // `capStream` (8 MiB-per-stream cap, HEAD-only with `[TRUNCATED by sandbox-control]`
            // marker embedded mid-stream); the deeper supervisor `boundedBuffer` (4 MiB-per-stream)
            // also drops the tail but silently, so the flag is necessary-but-not-sufficient
            // for "tail was cut". We append a compact trailing marker so the model sees a
            // structured signal even when downstream `tool-result-truncation` rewraps the
            // text (its global_head_tail strategy preserves the tail, so a tail-anchored
            // marker survives whenever any tail budget is left).
            const rawText = (res.stdout ?? '') + (res.stderr ?? '');
            const text = res.output_truncated ? `${rawText}${BASH_OUTPUT_TRUNCATED_MARKER}` : rawText;
            return withCloudCompatibleToolResponse({
                tool_name: BashToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    exit_code: res.exit_code,
                    timed_out: res.timed_out,
                    duration_ms: res.duration_ms,
                    output_truncated: res.output_truncated,
                    dispatched_locally: false,
                    local_dispatch_skip_reason: outcome.reason,
                },
            }, {
                stdout: res.stdout ?? '',
                stderr: res.stderr ?? '',
                interrupted: res.timed_out === true,
                isImage: false,
            });
        }
        async executeInBackground(ctx, input, signal) {
            // Per-user rollout gate. archon-server's assembler ships the gray-release
            // decision as AgentConfig.background_task_enabled; when it is not strictly
            // true (pre-rollout / non-allowlisted user) we reject run_in_background and
            // let the model fall back to a synchronous bash run. This is independent of
            // the deployment-level `this.background` wiring below.
            if (ctx.parentAgentConfig?.background_task_enabled !== true) {
                this.background?.metrics?.recordBackgroundTaskTool({
                    tool: 'bash',
                    mode: 'background',
                    result: 'background_not_enabled',
                });
                const text = '<bash_error>Background bash execution is not enabled for this user</bash_error>';
                return {
                    tool_name: BashToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: { status: 'background_not_enabled', is_error: true },
                };
            }
            if (!this.background) {
                const text = '<bash_error>Background bash execution is not enabled</bash_error>';
                return {
                    tool_name: BashToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: { status: 'background_not_enabled', is_error: true },
                };
            }
            const envVars = collectSecretEnvVars(ctx.secretStore);
            const executionRefJson = stringifyJson({
                backend: 'archon-server.shell-job',
            });
            let started;
            try {
                started = await this.background.taskClient.start({
                    kind: BackgroundTaskKind.Bash,
                    owner_session_id: ctx.sessionId,
                    owner_turn_id: ctx.turnId,
                    ...(ctx.toolCallId ? { tool_call_id: ctx.toolCallId } : {}),
                    // The command and environment are sent only to StartShellJob below.
                    // Background-task metadata is listable/persistent, so it stays opaque.
                    description: 'Background bash task',
                    execution_ref_json: executionRefJson,
                }, signal);
            }
            catch {
                if (signal?.aborted)
                    throw new Error('Operation aborted');
                logger.error(`[cloud-bash] stage=background_start code=CLOUD_BASH_BACKGROUND_START_FAILED session_id=${ctx.sessionId} turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId ?? 'none'}`);
                this.background.metrics?.recordBackgroundTaskTool({
                    tool: 'bash',
                    mode: 'background',
                    result: 'background_start_failed',
                });
                const text = '<bash_error>CLOUD_BASH_BACKGROUND_START_FAILED: Failed to start background bash task</bash_error>';
                return {
                    tool_name: BashToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: { status: 'background_start_failed' },
                };
            }
            const taskId = started.task.taskId;
            let shellJob;
            try {
                shellJob = await this.background.shellJobClient.start({
                    task_id: taskId,
                    session_id: ctx.sessionId,
                    command: input.command,
                    ...(input.timeout ? { timeout_seconds: input.timeout } : {}),
                    execution_policy: ShellExecutionPolicy.ReusePersistent,
                    ...(envVars ? { env_vars: envVars } : {}),
                }, signal);
            }
            catch {
                if (signal?.aborted)
                    throw new Error('Operation aborted');
                logger.error(`[cloud-bash] stage=shell_job_start code=CLOUD_BASH_SHELL_JOB_START_FAILED session_id=${ctx.sessionId} turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId ?? 'none'} task_id=${taskId}`);
                await this.background.taskClient
                    .finish({
                    task_id: taskId,
                    lease_token: started.leaseToken,
                    status: BackgroundTaskStatus.Failed,
                    execution_ref_json: executionRefJson,
                    last_error_json: stringifyJson({
                        message: 'Failed to start background bash task',
                        code: 'SHELL_JOB_START_FAILED',
                    }),
                }, undefined)
                    .catch(() => {
                    logger.warn(`[cloud-bash] stage=background_finish code=CLOUD_BASH_FINISH_AFTER_START_FAILURE_FAILED session_id=${ctx.sessionId} turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId ?? 'none'} task_id=${taskId}`);
                });
                const text = `<bash_error>CLOUD_BASH_SHELL_JOB_START_FAILED: Failed to start background bash task ${taskId}</bash_error>`;
                this.background.metrics?.recordBackgroundTaskTool({
                    tool: 'bash',
                    mode: 'background',
                    result: 'background_start_failed',
                });
                return {
                    tool_name: BashToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: { task_id: taskId, status: 'background_start_failed', is_error: true },
                };
            }
            const outputRef = outputRefForShellJob(taskId, shellJob);
            const shellExecutionRefJson = executionRefForShellJob(shellJob);
            void this.runBackgroundShellJob({
                ctx,
                taskId,
                leaseToken: started.leaseToken,
                shellJob,
                outputRef,
                executionRefJson: shellExecutionRefJson,
            });
            logger.info(`[cloud-bash] stage=background_dispatch code=CLOUD_BASH_BACKGROUND_STARTED session_id=${ctx.sessionId} turn_id=${ctx.turnId} tool_call_id=${ctx.toolCallId ?? 'none'} task_id=${taskId} sandbox_job_id=${shellJob.sandbox_job_id}`);
            this.background.metrics?.recordBackgroundTaskTool({
                tool: 'bash',
                mode: 'background',
                result: 'background_started',
            });
            const text = `<bash_background>\nBackground bash task ${taskId} started.\nUse task_query, task_output, and task_stop with this task_id.\n</bash_background>`;
            return {
                tool_name: BashToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    task_id: taskId,
                    status: 'background_started',
                    lease_until: started.leaseUntil,
                    sandbox_job_id: shellJob.sandbox_job_id,
                    ...(shellJob.sandbox_id ? { sandbox_id: shellJob.sandbox_id } : {}),
                    ...(outputRef ? { output_ref: outputRef } : {}),
                    dispatched_locally: false,
                },
            };
        }
        async runBackgroundShellJob(args) {
            const background = this.background;
            if (!background)
                return;
            const intervalMs = positiveMs(background.heartbeatIntervalMs) ?? DEFAULT_BACKGROUND_HEARTBEAT_INTERVAL_MS;
            const maxRunMs = positiveMs(background.maxRunMs) ?? DEFAULT_BACKGROUND_MAX_RUN_MS;
            const startedAt = Date.now();
            let job = args.shellJob;
            let outputRef = args.outputRef;
            let executionRefJson = args.executionRefJson;
            let stopRequested = false;
            let timedOut = false;
            logger.info(`[cloud-bash] stage=background_runner_start code=CLOUD_BASH_RUNNER_STARTED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId} sandbox_job_id=${job.sandbox_job_id}`);
            try {
                while (true) {
                    const heartbeat = await background.taskClient
                        .heartbeat({
                        task_id: args.taskId,
                        lease_token: args.leaseToken,
                        ...(outputRef ? { output_ref: outputRef } : {}),
                        ...(job.sandbox_id ? { sandbox_id: job.sandbox_id } : {}),
                        ...(job.sandbox_job_id ? { sandbox_job_id: job.sandbox_job_id } : {}),
                        execution_ref_json: executionRefJson,
                    })
                        .catch(() => {
                        logger.warn(`[cloud-bash] stage=background_heartbeat code=CLOUD_BASH_HEARTBEAT_FAILED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId}`);
                        return undefined;
                    });
                    if (heartbeat &&
                        !stopRequested &&
                        (heartbeat.abortRequested || heartbeat.status === 'stopping')) {
                        stopRequested = true;
                        await background.shellJobClient
                            .stop(args.taskId, 'Background task stop requested')
                            .catch(() => {
                            logger.warn(`[cloud-bash] stage=background_stop code=CLOUD_BASH_STOP_SHELL_JOB_FAILED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId}`);
                        });
                    }
                    const latest = await background.shellJobClient.get(args.taskId).catch(() => {
                        logger.warn(`[cloud-bash] stage=background_poll code=CLOUD_BASH_GET_SHELL_JOB_FAILED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId}`);
                        return undefined;
                    });
                    if (latest) {
                        job = latest;
                        outputRef = outputRefForShellJob(args.taskId, job) ?? outputRef;
                        executionRefJson = executionRefForShellJob(job);
                        if (isTerminalShellJobStatus(job.status))
                            break;
                    }
                    if (Date.now() - startedAt >= maxRunMs) {
                        timedOut = true;
                        stopRequested = true;
                        await background.shellJobClient
                            .stop(args.taskId, `Background bash exceeded maxRunMs=${maxRunMs}`)
                            .catch(() => {
                            logger.warn(`[cloud-bash] stage=background_timeout code=CLOUD_BASH_TIMEOUT_STOP_FAILED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId}`);
                        });
                        break;
                    }
                    await sleep(intervalMs);
                }
                const status = timedOut
                    ? BackgroundTaskStatus.Canceled
                    : toBackgroundTaskStatus(job.status, stopRequested);
                const lastErrorJson = lastErrorForShellJob(job, status, timedOut);
                logger.info(`[cloud-bash] stage=background_runner_finish code=CLOUD_BASH_RUNNER_FINISHED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId}`);
                background.metrics?.recordBackgroundTaskRunnerFinish({
                    kind: 'bash',
                    status: backgroundTaskStatusLabel(status),
                    reason: timedOut ? 'timeout' : stopRequested ? 'stopped' : 'normal',
                    durationMs: Date.now() - startedAt,
                });
                await background.taskClient.finish({
                    task_id: args.taskId,
                    lease_token: args.leaseToken,
                    status,
                    ...(outputRef ? { output_ref: outputRef } : {}),
                    execution_ref_json: executionRefJson,
                    ...(job.sandbox_id ? { sandbox_id: job.sandbox_id } : {}),
                    ...(job.sandbox_job_id ? { sandbox_job_id: job.sandbox_job_id } : {}),
                    ...(lastErrorJson ? { last_error_json: lastErrorJson } : {}),
                });
            }
            catch {
                logger.error(`[cloud-bash] stage=background_runner code=CLOUD_BASH_RUNNER_FAILED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId}`);
                background.metrics?.recordBackgroundTaskRunnerFinish({
                    kind: 'bash',
                    status: 'failed',
                    reason: 'error',
                    durationMs: Date.now() - startedAt,
                });
                await background.taskClient
                    .finish({
                    task_id: args.taskId,
                    lease_token: args.leaseToken,
                    status: BackgroundTaskStatus.Failed,
                    ...(outputRef ? { output_ref: outputRef } : {}),
                    execution_ref_json: executionRefJson,
                    ...(job.sandbox_id ? { sandbox_id: job.sandbox_id } : {}),
                    ...(job.sandbox_job_id ? { sandbox_job_id: job.sandbox_job_id } : {}),
                    last_error_json: stringifyJson({
                        message: 'Background bash runner failed',
                        code: 'RUNNER_FAILED',
                    }),
                })
                    .catch(() => {
                    logger.warn(`[cloud-bash] stage=background_finish code=CLOUD_BASH_FINISH_AFTER_RUNNER_FAILURE_FAILED session_id=${args.ctx.sessionId} turn_id=${args.ctx.turnId} tool_call_id=${args.ctx.toolCallId ?? 'none'} task_id=${args.taskId}`);
                });
            }
        }
    };
    return CloudBashTool = _classThis;
})();
export { CloudBashTool };
/**
 * Trailing marker appended to a sandbox bash result when the server reports
 * `output_truncated=true`. Placed at the end of `text` so it survives the
 * downstream `tool-result-truncation` head+tail rewrap whenever any tail
 * budget is available, giving the model an explicit "tail dropped" signal
 * in the visible-text channel (not just the `details` side channel that
 * pi-agent does not pass back into the model prompt).
 */
const BASH_OUTPUT_TRUNCATED_MARKER = '\n\n[bash: output truncated by sandbox-control (per-stream cap; tail dropped). Re-run with a narrower command or pipe through `head`/`tail` to retrieve specific regions.]';
function positiveMs(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function stringifyJson(value) {
    return JSON.stringify(value);
}
function isTerminalShellJobStatus(status) {
    return (status === ShellJobStatus.Succeeded ||
        status === ShellJobStatus.Failed ||
        status === ShellJobStatus.Canceled ||
        status === ShellJobStatus.Lost);
}
function toBackgroundTaskStatus(status, stopRequested) {
    if (stopRequested || status === ShellJobStatus.Canceled)
        return BackgroundTaskStatus.Canceled;
    if (status === ShellJobStatus.Succeeded)
        return BackgroundTaskStatus.Succeeded;
    return BackgroundTaskStatus.Failed;
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
function outputRefForShellJob(taskId, job) {
    if (job.output_ref)
        return job.output_ref;
    if (!job.sandbox_job_id)
        return undefined;
    return stringifyJson({
        taskId,
        kind: 'sandbox_job',
        uri: `sandbox-job://${job.sandbox_job_id}`,
    });
}
function executionRefForShellJob(job) {
    return stringifyJson({
        backend: 'archon-server.shell-job',
        sandbox_job_id: job.sandbox_job_id,
        ...(job.sandbox_id ? { sandbox_id: job.sandbox_id } : {}),
        shell_job_status: job.status,
    });
}
function lastErrorForShellJob(job, status, timedOut) {
    if (timedOut) {
        return stringifyJson({ message: 'Background bash exceeded maxRunMs', code: 'TIMEOUT' });
    }
    if (status === BackgroundTaskStatus.Succeeded)
        return undefined;
    if (job.status === ShellJobStatus.Lost) {
        return stringifyJson({
            message: 'Shell job lost',
            code: 'SHELL_JOB_LOST',
        });
    }
    if (job.status === ShellJobStatus.Failed) {
        return stringifyJson({ message: 'Background bash shell job failed', code: 'SHELL_JOB_FAILED' });
    }
    return undefined;
}
function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}
//# sourceMappingURL=cloud-bash.js.map