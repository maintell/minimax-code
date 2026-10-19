export function successfulTaskOutputReadTaskId(input) {
    if (input.toolName !== 'task_output' || input.isError === true)
        return undefined;
    const details = readRecord(input.details);
    if (isFailedRead(details))
        return undefined;
    const args = readRecord(input.args);
    return nonEmptyString(args.task_id) ?? nonEmptyString(details.task_id);
}
function isFailedRead(details) {
    return (details.is_error === true ||
        details.cancelled === true ||
        details.status === 'cancelled' ||
        ['failed', 'cancel', 'cancelled', 'canceled'].includes(String(details.decision)));
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function nonEmptyString(value) {
    return typeof value === 'string' && value ? value : undefined;
}
/** Incremental reads while running must not suppress a later terminal notification. */
export function successfulTerminalTaskOutputReadTaskId(input) {
    const status = readRecord(input.details).status;
    return ['succeeded', 'failed', 'canceled', 'lost'].includes(String(status))
        ? successfulTaskOutputReadTaskId(input)
        : undefined;
}
//# sourceMappingURL=task-output-read.js.map