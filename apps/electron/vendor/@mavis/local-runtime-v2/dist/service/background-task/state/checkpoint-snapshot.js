import { logger } from '@mavis/shared/local-runtime-logging/logger';
import { BACKGROUND_TASK_CHECKPOINT_DETAILS_HINT, isTerminalTaskStatus, } from '@mavis/background-task/local';
const TASK_LIMIT = 8;
const STATE_MAX_BYTES = 4_096;
const TEXT_LIMIT = 120;
const RESULT_LIMIT = 200;
export async function captureBackgroundTaskCheckpointSnapshot(input) {
    const { ownerSessionId, capturedAtMs, store, outputStore } = input;
    try {
        const tasks = [];
        let cursor;
        do {
            const page = await store.list({
                ownerSessionId,
                kinds: ['subagent'],
                orderBy: 'updated_at',
                order: 'desc',
                limit: 500,
                ...(cursor ? { cursor } : {}),
            });
            tasks.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor);
        const counts = {
            queued: 0,
            running: 0,
            stopping: 0,
            succeeded: 0,
            failed: 0,
            canceled: 0,
            lost: 0,
        };
        tasks.forEach((task) => {
            counts[task.status] += 1;
        });
        const candidates = [...tasks].sort(compareTasks).slice(0, TASK_LIMIT);
        const items = [];
        for (const task of candidates) {
            const item = await captureItem(task, outputStore);
            const nextItems = [...items, item];
            const candidate = snapshot(capturedAtMs, counts, tasks.length, nextItems);
            if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= STATE_MAX_BYTES) {
                items.push(item);
            }
        }
        return snapshot(capturedAtMs, counts, tasks.length, items);
    }
    catch {
        warnCheckpoint({ event: 'background_task_checkpoint_capture_failed', ownerSessionId }, 'Local background task checkpoint snapshot could not be captured');
        return undefined;
    }
}
async function captureItem(task, outputStore) {
    const agentName = readMetadataText(task, 'agentName');
    const executionMode = readExecutionMode(task);
    if (hasInvalidMetadata(task, agentName, executionMode)) {
        warnCheckpoint({
            event: 'background_task_checkpoint_metadata_invalid',
            taskId: task.taskId,
            ownerSessionId: task.ownerSessionId,
        }, 'Local background task checkpoint metadata was omitted');
    }
    const description = truncateText(task.description, TEXT_LIMIT);
    const lastError = task.status === 'failed' ? truncateText(task.lastError?.message, TEXT_LIMIT) : undefined;
    const finalResultPreview = await readFinalResultPreview(task, outputStore);
    return {
        taskId: task.taskId,
        status: task.status,
        ...(agentName ? { agentName } : {}),
        ...(executionMode ? { executionMode } : {}),
        updatedAtMs: task.updatedAt,
        delivered: task.deliveredAt !== undefined,
        ...(description ? { description } : {}),
        ...(lastError ? { lastError } : {}),
        ...(finalResultPreview ? { finalResultPreview } : {}),
    };
}
function snapshot(capturedAtMs, counts, total, items) {
    return {
        capturedAtMs,
        total,
        counts,
        omitted: total - items.length,
        textFieldsAreUntrusted: true,
        detailsHint: BACKGROUND_TASK_CHECKPOINT_DETAILS_HINT,
        items,
    };
}
function compareTasks(left, right) {
    return (taskPriority(left) - taskPriority(right) ||
        right.updatedAt - left.updatedAt ||
        left.taskId.localeCompare(right.taskId));
}
function taskPriority(task) {
    if (!isTerminalTaskStatus(task.status))
        return 0;
    return task.deliveredAt === undefined ? 1 : 2;
}
function readMetadataText(task, key) {
    return truncateText(task.metadata?.[key], TEXT_LIMIT);
}
function readExecutionMode(task) {
    const value = task.metadata?.['executionMode'];
    return value === 'foreground' || value === 'background' || value === 'append' ? value : undefined;
}
function hasInvalidMetadata(task, agentName, executionMode) {
    const metadata = task.metadata;
    if (metadata === undefined)
        return false;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
        return true;
    return ((Object.hasOwn(metadata, 'agentName') && agentName === undefined) ||
        (Object.hasOwn(metadata, 'executionMode') && executionMode === undefined));
}
function truncateText(value, limit) {
    if (typeof value !== 'string')
        return undefined;
    const text = value.trim();
    return text ? text.slice(0, limit) : undefined;
}
function warnCheckpoint(fields, message) {
    try {
        logger.warn(fields, message);
    }
    catch {
        // Checkpoint diagnostics are best effort and must never affect compaction.
    }
}
async function readFinalResultPreview(task, outputStore) {
    let finalResultPreview;
    if (isTerminalTaskStatus(task.status) && task.outputRef) {
        try {
            const output = await outputStore.read(task.taskId, {
                stream: 'final_result',
                limitBytes: RESULT_LIMIT * 4,
            });
            finalResultPreview = truncateText(output.content, RESULT_LIMIT);
        }
        catch {
            warnCheckpoint({
                event: 'background_task_checkpoint_output_read_failed',
                taskId: task.taskId,
                ownerSessionId: task.ownerSessionId,
            }, 'Local background task checkpoint output could not be read');
        }
    }
    return finalResultPreview;
}
//# sourceMappingURL=checkpoint-snapshot.js.map