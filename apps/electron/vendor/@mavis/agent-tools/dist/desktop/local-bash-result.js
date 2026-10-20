import { BashExecutionError, } from '@earendil-works/pi-coding-agent/tools';
export function localBashResultFromPi(result) {
    const details = (result.details ?? {});
    const execution = readBashExecutionOutcome(details);
    return {
        text: result.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n'),
        details,
        ...(execution && execution.status !== 'succeeded' ? { isError: true } : {}),
    };
}
export function localBashResultFromError(error, signal) {
    const details = error instanceof BashExecutionError ? error.details : {};
    const cause = error instanceof BashExecutionError ? error.cause : error;
    const causeRecord = cause && typeof cause === 'object' ? cause : undefined;
    const errorCode = typeof causeRecord?.code === 'string' ? causeRecord.code : undefined;
    const preflight = errorCode?.startsWith('SANDBOX_') &&
        (causeRecord?.stage === undefined ||
            ['init', 'parse', 'invocation', 'pre-spawn'].includes(String(causeRecord.stage)));
    const text = error instanceof Error ? error.message : String(error);
    const execution = {
        status: signal?.aborted ? 'canceled' : 'failed',
        reason: signal?.aborted ? 'canceled' : 'unknown',
        exitCode: null,
        message: text,
        ...(errorCode ? { errorCode } : {}),
        ...details.execution,
        ...(preflight ? { reason: 'preflight_failed' } : {}),
    };
    if (execution.status === 'canceled' && !execution.cancellationReason && signal?.aborted) {
        execution.cancellationReason =
            signal.reason instanceof Error
                ? signal.reason.message
                : typeof signal.reason === 'string'
                    ? signal.reason
                    : undefined;
    }
    return { text, details: { ...details, execution }, isError: true };
}
export function readBashExecutionOutcome(details) {
    if (!details || typeof details !== 'object' || !('execution' in details))
        return undefined;
    const execution = details.execution;
    if (!execution || typeof execution !== 'object')
        return undefined;
    const value = execution;
    if (typeof value.status !== 'string' ||
        !['succeeded', 'failed', 'canceled'].includes(value.status) ||
        typeof value.reason !== 'string' ||
        ![
            'exited',
            'signaled',
            'command_timeout',
            'canceled',
            'spawn_failed',
            'unknown',
            'preflight_failed',
            'watchdog_timeout',
            'output_limit',
        ].includes(value.reason) ||
        !(value.exitCode === null ||
            (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode))) ||
        [value.signal, value.errorCode, value.message, value.cancellationReason].some((field) => field !== undefined && typeof field !== 'string'))
        return undefined;
    return execution;
}
export function formatBashExecutionOutcome(execution) {
    if (execution.message)
        return execution.message;
    if (execution.signal)
        return `Command terminated by signal ${execution.signal}`;
    if (execution.exitCode !== null)
        return `Command exited with code ${execution.exitCode}`;
    return `Command ${execution.status} (${execution.reason})`;
}
//# sourceMappingURL=local-bash-result.js.map