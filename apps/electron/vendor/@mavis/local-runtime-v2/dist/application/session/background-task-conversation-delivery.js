import { settleInBackground } from '../../service/plugin-system/index.js';
import { buildBackgroundTaskDeliveryPrompt } from '../../service/background-task/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { ConversationTurnRejectedError, } from '@mavis/conversation-contract';
import { backgroundTaskNotificationReceiptId, } from '@mavis/agent-tools/desktop';
export async function startConversationBackgroundTaskDeliveryTurn(input) {
    const { host, conversation, ownerSessionId, tasks, batchTaskIds, observedTerminalCount, holdAtAdmission, } = input;
    let held;
    try {
        const requestedTurnId = `turn_task_delivery_${randomUUID()}`;
        const steered = await conversation.ingress.steer({
            ...buildBackgroundTaskDeliveryInput({
                ownerSessionId,
                tasks,
                batchTaskIds,
                observedTerminalCount,
                requestedTurnId,
            }),
            ...(holdAtAdmission
                ? {
                    preDelivery: {
                        accept: (admission) => {
                            held = holdAtAdmission(admission);
                            if (held)
                                throw new BackgroundDeliveryWithheldError(held);
                        },
                    },
                }
                : {}),
        });
        // Delivery only needs the admission ACK; the owner Turn keeps running.
        if (steered.mode === 'activated') {
            settleInBackground((async () => {
                try {
                    await steered.completion;
                }
                catch (error) {
                    host.matrixLogger?.warn({ sessionId: ownerSessionId, turnId: steered.turnId }, `Background task delivery Turn failed: ${String(error)}`);
                }
            })());
        }
        if (held)
            return held;
        return 'delivered';
    }
    catch (error) {
        if (held)
            return held;
        if (error instanceof ConversationTurnRejectedError)
            return 'busy';
        try {
            host.matrixLogger?.warn({ sessionId: ownerSessionId, turnId: batchDeliveryIdentity(batchTaskIds) }, `Local background task delivery failed for ${batchTaskIds.join(', ')}: ${error instanceof Error ? error.message : String(error)}`);
        }
        catch {
            // Diagnostic failures must not change the transport result or abandon retries.
        }
        return 'failed';
    }
}
class BackgroundDeliveryWithheldError extends Error {
    result;
    name = 'AbortError';
    constructor(result) {
        super('Background task delivery was withheld at final admission');
        this.result = result;
    }
}
export function buildBackgroundTaskDeliveryInput(input) {
    const displayTasks = input.tasks
        .filter((task) => task.kind === 'bash')
        .map((task) => ({
        taskId: task.taskId,
        name: task.description?.trim() || task.taskId,
        status: task.status,
    }));
    return {
        sessionId: input.ownerSessionId,
        source: 'background-task',
        requestedTurnId: input.requestedTurnId,
        producerId: 'background-task-delivery',
        idempotencyKey: batchDeliveryIdentity(input.batchTaskIds),
        receiptAliases: input.tasks.map((task) => backgroundTaskNotificationReceiptId(task.taskId)),
        ...(displayTasks.length
            ? {
                activationDisplayContent: displayTasks
                    .map((task) => `Background task “${task.name}”: ${task.status}.`)
                    .join('\n'),
            }
            : {}),
        message: {
            content: buildBackgroundTaskDeliveryPrompt(input.tasks),
            attachments: [],
            hideUserMessage: true,
            origin: {
                kind: 'background-task-terminal',
                taskIds: input.tasks.map((task) => task.taskId),
                observedTerminalCount: input.observedTerminalCount,
                ...(displayTasks.length ? { tasks: displayTasks } : {}),
            },
        },
    };
}
function batchDeliveryIdentity(taskIds) {
    if (taskIds.length === 1 && taskIds[0])
        return taskIds[0];
    const digest = createHash('sha256')
        .update(JSON.stringify([...taskIds].sort()))
        .digest('hex');
    return `background-task-batch:${digest}`;
}
//# sourceMappingURL=background-task-conversation-delivery.js.map