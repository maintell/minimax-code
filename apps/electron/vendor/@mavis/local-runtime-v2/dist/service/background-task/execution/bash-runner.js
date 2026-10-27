import { settleInBackground } from '../../../infra/async/settle.js';
import { localBashResultFromError, readBashExecutionOutcome, resolveLocalBashTiming, validateBashCommand, resolveBashDescription, readPermissionExecutionPlan, } from '@mavis/agent-tools/desktop';
import { createBackgroundTaskId } from '@mavis/background-task/local';
import { admitBackgroundTask, shutdownBackgroundTasks } from '../control/lifecycle.js';
import { logRunnerFailure, managedBashAbortError, raceCompletionWithSoftYield, recordBashMetrics, recordSoftYieldMetric, } from './bash-runner-lifecycle.js';
import { BackgroundBashOutputWriter } from './bash-output-writer.js';
import { settleBackgroundBashTask, settleFailedBackgroundBash, withTaskOutputReceipt, } from './bash-task-settlement.js';
import { capBackgroundBashMaxRunMs, resolveBackgroundBashMaxRunMs } from './bash-runner-limits.js';
import { DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR, } from './bash-executor.js';
const activeBackgroundBash = new Map();
export function buildLocalBashAdapter(host, parentSession, executor = DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR) {
    const runManaged = (toolCtx, bashInput, softYieldMs, signal) => runManagedForegroundLocalBash({
        host,
        parentSession,
        toolCtx,
        bashInput,
        softYieldMs,
        signal,
        executor,
    });
    return {
        startBackground: (toolCtx, bashInput, signal) => startBackgroundLocalBash({ host, parentSession, toolCtx, bashInput, signal, executor }),
        runManagedForeground: runManaged,
    };
}
/** @internal Direct runner seam for background Bash integration tests. */
export async function startBackgroundLocalBash(input) {
    if (input.signal?.aborted)
        throw new Error('Operation aborted');
    const controller = new AbortController();
    const abortStarting = () => controller.abort(input.signal?.reason ?? 'Operation aborted');
    const admission = admitBackgroundTask(input.host, (reason) => controller.abort(reason));
    input.signal?.addEventListener('abort', abortStarting, { once: true });
    try {
        const started = await startAdmittedBackgroundLocalBash(input, controller, admission, 'explicit_background');
        observeBackgroundCompletion(input, started, 'explicit_background');
        return {
            status: 'started',
            taskId: started.taskId,
            ...(started.getStartedDetails() ? { details: started.getStartedDetails() } : {}),
        };
    }
    catch (error) {
        admission.release();
        throw error;
    }
    finally {
        input.signal?.removeEventListener('abort', abortStarting);
    }
}
/** @internal Direct runner seam for background Bash integration tests. */
export async function runManagedForegroundLocalBash(input) {
    if (input.signal?.aborted)
        throw managedBashAbortError(input.signal, 'Operation aborted');
    const controller = new AbortController();
    const abortManaged = () => controller.abort(input.signal?.reason ?? 'Operation aborted');
    input.signal?.addEventListener('abort', abortManaged, { once: true });
    const admission = admitBackgroundTask(input.host, (reason) => controller.abort(reason));
    try {
        const started = await startAdmittedBackgroundLocalBash(input, controller, admission, 'managed_foreground');
        const completion = await raceCompletionWithSoftYield(started.settled, input.softYieldMs);
        if (completion) {
            return await completeManagedForeground(input, started.taskId, completion);
        }
        try {
            await input.host.backgroundTaskService.patch(started.taskId, {
                metadata: {
                    executionMode: 'auto_promoted',
                    foregroundSoftYieldMs: input.softYieldMs,
                },
            });
        }
        catch (error) {
            controller.abort(error);
            await started.settled;
            throw error;
        }
        recordSoftYieldMetric(input.host, started.taskId, input.softYieldMs, 'promoted');
        input.signal?.removeEventListener('abort', abortManaged);
        observeBackgroundCompletion(input, started, 'auto_promoted');
        return {
            status: 'auto_promoted',
            taskId: started.taskId,
            ...(started.getStartedDetails() ? { details: started.getStartedDetails() } : {}),
        };
    }
    catch (error) {
        admission.release();
        if (error instanceof Error && error.name === 'AbortError')
            throw error;
        return { status: 'failed', errorMessage: formatError(error) };
    }
    finally {
        input.signal?.removeEventListener('abort', abortManaged);
    }
}
async function startAdmittedBackgroundLocalBash(input, controller, admission, executionMode) {
    validateBashCommand(input.bashInput.command);
    const timing = resolveLocalBashTiming(input.bashInput.timeout, executionMode);
    const taskId = createBackgroundTaskId();
    // Claim the row for this process before it exists durably, so a Session stop
    // cascade can tell "our task" from a row owned by another client process.
    admission.identify(taskId);
    const now = input.host.nowMs();
    const description = resolveBashDescription(input.bashInput.description, input.bashInput.command);
    const maxRunMs = capBackgroundBashMaxRunMs(input.maxRunMs ?? resolveBackgroundBashMaxRunMs(timing.commandTimeoutSeconds));
    let releaseCreation;
    let rejectCreation;
    const created = new Promise((resolve, reject) => {
        releaseCreation = resolve;
        rejectCreation = reject;
    });
    let startedDetails = { description };
    const settled = (async () => {
        try {
            await created;
            return await runBackgroundLocalBashCommand({
                host: input.host,
                parentSession: input.parentSession,
                taskId,
                command: input.bashInput.command,
                permissionExecutionPlan: readPermissionExecutionPlan(input.bashInput),
                description,
                timeout: timing.commandTimeoutSeconds,
                timing,
                maxRunMs,
                executionMode,
                toolCtx: input.toolCtx,
                executor: input.executor ?? DEFAULT_LOCAL_BACKGROUND_BASH_EXECUTOR,
                controller,
                onStartedDetails: (details) => {
                    startedDetails = { ...(startedDetails ?? {}), ...details };
                },
            });
        }
        finally {
            activeBackgroundBash.delete(taskId);
        }
    })();
    admission.bind((async () => {
        await settled;
    })());
    activeBackgroundBash.set(taskId, { controller, settled });
    try {
        await input.host.backgroundTaskService.create({
            taskId,
            kind: 'bash',
            status: 'queued',
            ownerSessionId: input.parentSession.sessionId,
            description,
            toolCallId: input.toolCtx.toolCallId,
            createdAt: now,
            updatedAt: now,
            metadata: {
                parentSessionId: input.parentSession.sessionId,
                workingDirectory: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
                parentTurnId: input.toolCtx.turnId,
                command: input.bashInput.command,
                ...(input.bashInput.timeout ? { timeoutSeconds: input.bashInput.timeout } : {}),
                maxRunMs,
                timing,
                executionMode,
            },
        });
        releaseCreation();
    }
    catch (error) {
        rejectCreation(error);
        throw error;
    }
    return { taskId, settled, getStartedDetails: () => startedDetails };
}
export async function stopBackgroundLocalBashTask(task, reason) {
    if (task.kind !== 'bash')
        return;
    const active = activeBackgroundBash.get(task.taskId);
    if (!active)
        return;
    active.controller.abort(reason ?? 'Background bash stopped');
    await active.settled;
}
/** @internal Process-wide cleanup for legacy background Bash integration fixtures. */
export function abortAllBackgroundLocalBashTasks(reason) {
    const activeTasks = [...activeBackgroundBash.values()];
    for (const active of activeTasks) {
        active.controller.abort(reason ?? 'Background bash reclaimed on exit');
    }
    return activeTasks.length;
}
/** @internal Host-scoped teardown for background Bash integration fixtures. */
export async function abortBackgroundLocalBashTasksForHost(host, reason = 'runtime-shutdown') {
    return shutdownBackgroundTasks(host, reason);
}
async function runBackgroundLocalBashCommand(input) {
    const { controller } = input;
    const startedAt = input.host.nowMs();
    const output = new BackgroundBashOutputWriter(input.host, input.parentSession.sessionId, input.taskId, { onLimit: (error) => controller.abort(error) });
    // Watchdog: cap a runaway/forgotten background task at maxRunMs. Firing
    // aborts the same controller the stop path uses; `timedOut` disambiguates
    // the resulting abort from a user-requested stop so we land failed+TIMEOUT
    // rather than canceled (bash-tool-optimization.md §5).
    const maxRunMs = capBackgroundBashMaxRunMs(input.maxRunMs ?? resolveBackgroundBashMaxRunMs(input.timeout));
    const timing = { ...input.timing };
    input.onStartedDetails({ timing });
    let timedOut = false;
    const watchdog = setTimeout(() => {
        if (controller.signal.aborted)
            return;
        timedOut = true;
        controller.abort('TIMEOUT');
    }, maxRunMs);
    try {
        if (controller.signal.aborted) {
            throw managedBashAbortError(controller.signal, 'Operation aborted before command start');
        }
        const executed = await executeBash(input, output, timing);
        const result = {
            ...executed,
            details: {
                ...executed.details,
                description: input.description,
                timing: { ...timing, ...executed.details?.timing },
            },
        };
        const execution = readBashExecutionOutcome(result.details);
        if (output.limitError || result.isError || (execution && execution.status !== 'succeeded')) {
            return await settleFailedBackgroundBash(input, output, result, {
                startedAt,
                watchdogTimedOut: timedOut,
                maxRunMs,
            });
        }
        const outputRef = await output.settleSuccess(result);
        const completed = withTaskOutputReceipt(result, output, outputRef, input.taskId);
        const terminal = await settleBackgroundBashTask({
            host: input.host,
            output,
            taskId: input.taskId,
            startedAt,
            status: 'succeeded',
            outputRef,
            lastError: undefined,
            metadata: {
                bashDetails: completed.details,
                outputBytes: output.outputBytes,
            },
        });
        try {
            await input.host.backgroundTaskService.finalizeOutput(input.taskId, completed.text);
        }
        catch (error) {
            output.warn('finalize', error);
        }
        return {
            taskId: input.taskId,
            status: 'succeeded',
            text: completed.text,
            details: completed.details,
            endedAt: terminal.endedAt,
            durationMs: terminal.durationMs,
            outputBytes: output.outputBytes,
        };
    }
    catch (error) {
        const failed = failedBashResult(input, error, { timing, output });
        return await settleFailedBackgroundBash(input, output, failed, {
            startedAt,
            watchdogTimedOut: timedOut,
            maxRunMs,
        });
    }
    finally {
        clearTimeout(watchdog);
    }
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
async function completeManagedForeground(input, taskId, completion) {
    try {
        await input.host.backgroundTaskService.markDelivered(input.parentSession.sessionId, [taskId]);
        await input.host.backgroundTaskService.patch(taskId, {
            metadata: { executionMode: 'managed_foreground', completionOrigin: 'foreground' },
        });
    }
    catch (error) {
        input.host.matrixLogger?.warn({ sessionId: input.parentSession.sessionId, turnId: taskId }, `Failed to persist managed bash foreground delivery latch: ${formatError(error)}`);
    }
    recordBashMetrics(input.host, input.parentSession.sessionId, completion, 'managed_foreground');
    recordSoftYieldMetric(input.host, taskId, completion.durationMs, 'completed');
    if (completion.status === 'canceled') {
        throw Object.assign(managedBashAbortError(input.signal, completion.text), {
            details: completion.details,
        });
    }
    return {
        status: 'completed',
        taskId,
        text: completion.text,
        ...(completion.details ? { details: completion.details } : {}),
        ...(completion.isError ? { isError: true } : {}),
    };
}
function observeBackgroundCompletion(input, started, mode) {
    settleInBackground((async () => {
        try {
            const completion = await started.settled;
            recordBashMetrics(input.host, input.parentSession.sessionId, completion, mode);
            input.host.backgroundTasks.scheduleDelivery(started.taskId);
        }
        catch (error) {
            logRunnerFailure(input.host, input.parentSession.sessionId, started.taskId, error);
        }
    })());
}
function executeBash(input, output, timing) {
    const { controller } = input;
    return input.executor.execute({
        identity: {
            operationClass: input.executionMode,
            invocationId: input.taskId,
            sessionId: input.parentSession.sessionId,
            turnId: input.toolCtx.turnId,
            ...(input.toolCtx.toolCallId ? { toolCallId: input.toolCtx.toolCallId } : {}),
            taskId: input.taskId,
            ...(input.toolCtx.forceReadOnlyFilesystem ? { forceReadOnlyFilesystem: true } : {}),
        },
        workspaceRoot: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
        command: input.command,
        ...(input.permissionExecutionPlan
            ? { permissionExecutionPlan: input.permissionExecutionPlan }
            : {}),
        timeout: input.timeout,
        signal: controller.signal,
        onPreflightComplete: async () => {
            if (controller.signal.aborted) {
                throw managedBashAbortError(controller.signal, 'Operation aborted before command start');
            }
            await input.host.backgroundTaskService.patch(input.taskId, {
                status: 'running',
                startedAt: input.host.nowMs(),
            });
        },
        onOutput: output.push,
        onDetails: (details) => {
            Object.assign(timing, details.timing);
            input.onStartedDetails({ ...details, timing: { ...timing } });
        },
    });
}
function failedBashResult(input, error, { timing, output }) {
    const { controller } = input;
    const failed = localBashResultFromError(error, controller.signal);
    failed.details = {
        ...failed.details,
        description: input.description,
        timing: { ...timing, ...failed.details?.timing },
    };
    if (output.streamedOutput &&
        !readBashExecutionOutcome(error && typeof error === 'object' && 'details' in error ? error.details : undefined)) {
        failed.text = `${output.streamedTextForError}\n${failed.text}`;
    }
    return failed;
}
//# sourceMappingURL=bash-runner.js.map