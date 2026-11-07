import { formatBashExecutionOutcome, readBashExecutionOutcome, } from '@mavis/agent-tools/desktop';
import { BackgroundBashOutputWriter } from './bash-output-writer.js';
export async function settleFailedBackgroundBash(input, output, result, options) {
    const { startedAt, watchdogTimedOut } = options;
    const execution = failedExecution(input, output, result, options);
    const errorText = formatBashExecutionOutcome(execution);
    const text = watchdogTimedOut || execution.reason === 'output_limit'
        ? `${result.text}\n\n${errorText}`
        : result.text;
    const status = execution.status === 'canceled' ? 'canceled' : 'failed';
    const statusText = watchdogTimedOut ? errorText : `Background bash ${status}: ${errorText}`;
    const terminalText = failureOutput(output.streamedOutput, result.text === errorText, text, statusText);
    const outputRef = await output.settleFailure(terminalText);
    const completed = withTaskOutputReceipt({ text, details: { ...result.details, execution } }, output, outputRef, input.taskId);
    const details = completed.details;
    const terminal = await settleBackgroundBashTask({
        host: input.host,
        output,
        taskId: input.taskId,
        startedAt,
        status,
        outputRef,
        lastError: {
            message: status === 'canceled' ? (execution.cancellationReason ?? errorText) : errorText,
            code: failureCode(execution),
        },
        metadata: { bashDetails: details, outputBytes: output.outputBytes },
    });
    return {
        taskId: input.taskId,
        status,
        text: completed.text,
        details,
        isError: true,
        endedAt: terminal.endedAt,
        durationMs: terminal.durationMs,
        outputBytes: output.outputBytes,
    };
}
export function withTaskOutputReceipt(result, writer, outputRef, taskId) {
    const facts = writer.describePersistence(outputRef);
    const details = { ...result.details };
    delete details.fullOutputPath;
    const fullOutputPath = facts.persistence === 'complete' && outputRef?.kind === 'file' ? outputRef.uri : undefined;
    const truncated = details.truncation?.truncated;
    const receipt = outputReceipt(facts.persistence, !!truncated, taskId);
    return {
        ...result,
        text: receipt ? `${result.text}\n\n${receipt}` : result.text,
        details: {
            ...details,
            ...(fullOutputPath ? { fullOutputPath } : {}),
            ...(details.processOutput
                ? {
                    processOutput: { ...details.processOutput, rawOutputPath: fullOutputPath },
                }
                : {}),
            output: { ...details.output, ...facts },
        },
    };
}
export async function settleBackgroundBashTask(input) {
    const endedAt = input.host.nowMs();
    const durationMs = Math.max(0, endedAt - input.startedAt);
    const completion = await input.host.backgroundTaskService.patchIfNotTerminal(input.taskId, {
        status: input.status,
        endedAt,
        ...(input.outputRef ? { outputRef: input.outputRef } : {}),
        lastError: input.lastError,
        metadata: {
            ...input.metadata,
            stopError: undefined,
            durationMs,
            cacheTtlExceeded: durationMs >= 300_000,
        },
    });
    if (!completion.patched) {
        try {
            await patchTerminalBashResult(input.host, input.taskId, input.outputRef, input.metadata);
        }
        catch (error) {
            input.output.warn('patch terminal', error);
        }
    }
    return { endedAt, durationMs };
}
async function patchTerminalBashResult(host, taskId, outputRef, metadata) {
    const existing = await host.backgroundTaskService.get(taskId);
    if (!existing)
        return;
    await host.backgroundTaskService.patch(taskId, {
        ...(outputRef ? { outputRef } : {}),
        metadata: { ...metadata, stopError: undefined },
        endedAt: existing.endedAt ?? host.nowMs(),
    });
}
function failedExecution(input, output, result, { watchdogTimedOut, maxRunMs }) {
    const observed = readBashExecutionOutcome(result.details);
    const execution = {
        ...(observed ?? {
            status: 'failed',
            reason: 'unknown',
            exitCode: null,
            message: result.text,
        }),
    };
    if (output.limitError &&
        input.controller.signal.reason === output.limitError &&
        observed?.reason !== 'command_timeout') {
        Object.assign(execution, {
            status: 'failed',
            reason: 'output_limit',
            errorCode: 'BASH_OUTPUT_LIMIT',
            message: output.limitError.message,
            cancellationReason: undefined,
        });
    }
    else if (watchdogTimedOut) {
        Object.assign(execution, {
            status: 'failed',
            reason: 'watchdog_timeout',
            errorCode: 'TIMEOUT',
            message: `Background bash timed out after ${maxRunMs}ms (exceeded maxRunMs)`,
        });
    }
    else if (!observed && input.controller.signal.aborted) {
        execution.status = 'canceled';
        execution.reason = 'canceled';
    }
    return execution;
}
function failureOutput(streamed, sameError, text, statusText) {
    if (streamed)
        return `\n<bash_status>${statusText}</bash_status>\n`;
    return sameError ? statusText : `${text}\n\n${statusText}`;
}
function failureCode(execution) {
    if (execution.errorCode)
        return execution.errorCode;
    if (execution.reason === 'command_timeout')
        return 'BASH_TIMEOUT';
    return execution.status === 'canceled' ? 'BASH_CANCELED' : 'BASH_FAILED';
}
function outputReceipt(persistence, truncated, taskId) {
    if (persistence === 'incomplete')
        return `[Output persistence incomplete; the log may be missing output. Use task_output with task_id=${taskId} for the saved portion; do not assume a complete log.]`;
    return truncated
        ? `[Full output: task_output with task_id=${taskId}; continue with next_offset (log file bytes).]`
        : '';
}
//# sourceMappingURL=bash-task-settlement.js.map