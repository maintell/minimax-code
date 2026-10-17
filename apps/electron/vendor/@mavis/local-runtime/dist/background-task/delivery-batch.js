import { buildBackgroundTaskDeliveryInput } from './conversation-delivery.js';
export const MAX_TASKS_PER_DELIVERY_BATCH = 32;
export const MAX_DELIVERY_INPUT_BYTES = 8 * 1_024;
const MAX_DESCRIPTION_BYTES = 256;
const MAX_GENERATED_TURN_ID = `turn_task_delivery_${'0'.repeat(32)}`;
// 内部通知预算，不代表任意模型的剩余上下文保证；正常 Task ID 为 bg_ + UUID（39 字节）。
// 只缩短通知预览，完整描述与结果仍保存在 Task 中。
export function createDeliveryTaskPreview(task) {
    const preview = {
        taskId: task.taskId,
        ownerSessionId: task.ownerSessionId,
        kind: task.kind,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
        ...(task.description
            ? { description: truncateUtf8(task.description, MAX_DESCRIPTION_BYTES) }
            : {}),
    };
    if (deliveryInputBytes([preview]) <= MAX_DELIVERY_INPUT_BYTES)
        return preview;
    delete preview.description;
    if (deliveryInputBytes([preview]) <= MAX_DELIVERY_INPUT_BYTES)
        return preview;
    // 不截断 opaque Task/Session 身份，也不发送超限的单条通知。
    throw new RangeError(`Background task notice identity exceeds ${MAX_DELIVERY_INPUT_BYTES} bytes (task ID: ${Buffer.byteLength(task.taskId, 'utf8')} bytes)`);
}
/** 按 FIFO 取下一批，再冻结成员；每批同时满足任务数量与序列化字节预算。 */
export function selectDeliveryBatch(pending) {
    const selected = [];
    for (const task of pending.values()) {
        if (selected.length >= MAX_TASKS_PER_DELIVERY_BATCH)
            break;
        if (deliveryInputBytes([...selected, task]) > MAX_DELIVERY_INPUT_BYTES)
            break;
        selected.push(task);
    }
    return selected.sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0);
}
function deliveryInputBytes(tasks) {
    const ownerSessionId = tasks[0]?.ownerSessionId ?? '';
    const input = buildBackgroundTaskDeliveryInput({
        ownerSessionId,
        tasks,
        batchTaskIds: tasks.map((task) => task.taskId),
        observedTerminalCount: Number.MAX_SAFE_INTEGER,
        requestedTurnId: MAX_GENERATED_TURN_ID,
    });
    return Buffer.byteLength(JSON.stringify(input), 'utf8');
}
function truncateUtf8(value, maxBytes) {
    const characters = [];
    let bytes = 0;
    for (const character of value) {
        const size = Buffer.byteLength(character, 'utf8');
        if (bytes + size > maxBytes) {
            while (bytes > maxBytes - 3)
                bytes -= Buffer.byteLength(characters.pop() ?? '', 'utf8');
            return `${characters.join('')}…`;
        }
        characters.push(character);
        bytes += size;
    }
    return characters.join('');
}
//# sourceMappingURL=delivery-batch.js.map