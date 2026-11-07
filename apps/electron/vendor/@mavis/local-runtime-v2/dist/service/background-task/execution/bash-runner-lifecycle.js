export async function raceCompletionWithSoftYield(completion, softYieldMs) {
    let timer;
    try {
        return await Promise.race([
            completion,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(undefined), Math.max(0, softYieldMs));
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
export function recordBashMetrics(host, sessionId, completion, executionMode) {
    const labels = { executionMode, status: completion.status };
    try {
        host.metricsClient?.counter('bash_execution_total', 1, labels);
        host.metricsClient?.histogram('bash_duration_ms', completion.durationMs, labels);
        host.metricsClient?.histogram('bash_output_bytes', completion.outputBytes, labels);
    }
    catch (error) {
        warnMetricFailure(host, { sessionId, turnId: completion.taskId }, `Failed to record local bash metrics: ${formatError(error)}`);
    }
    try {
        host.recordSessionBashCompletion?.(sessionId, {
            endedAt: completion.endedAt,
            durationMs: completion.durationMs,
        });
    }
    catch (error) {
        warnMetricFailure(host, { sessionId, turnId: completion.taskId }, `Failed to record local bash completion correlation: ${formatError(error)}`);
    }
}
export function recordSoftYieldMetric(host, taskId, durationMs, outcome) {
    try {
        host.metricsClient?.histogram('bash_foreground_soft_yield_ms', durationMs, { outcome });
    }
    catch (error) {
        warnMetricFailure(host, { sessionId: 'local-bash-metrics', turnId: taskId }, `Failed to record local bash soft-yield metric: ${formatError(error)}`);
    }
}
export function managedBashAbortError(signal, fallback) {
    if (signal?.reason instanceof Error && signal.reason.name === 'AbortError')
        return signal.reason;
    const error = new Error(signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason ?? fallback), signal?.reason instanceof Error ? { cause: signal.reason } : undefined);
    error.name = 'AbortError';
    return error;
}
export function logRunnerFailure(host, sessionId, taskId, error) {
    host.matrixLogger?.warn({ sessionId, turnId: taskId }, `Local background bash runner failed after error handling: ${formatError(error)}`);
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function warnMetricFailure(host, context, message) {
    try {
        host.matrixLogger?.warn(context, message);
    }
    catch {
        // Metrics and diagnostics are both optional. Neither may alter Bash
        // execution or prevent the independent completion correlation hook.
    }
}
//# sourceMappingURL=bash-runner-lifecycle.js.map