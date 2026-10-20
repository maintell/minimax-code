import { createHash } from 'node:crypto';
import { ConversationTurnRejectedError, } from '@mavis/conversation-contract';
import { makeId } from '../api/host-helpers.js';
import { observeSteerCompletion } from '../api/conversation-steer.js';
export async function startConversationBackgroundTaskDeliveryTurn(input) {
    const { host, conversation, ownerSessionId, tasks, batchTaskIds, observedTerminalCount, holdAtAdmission, } = input;
    let held;
    try {
        const requestedTurnId = makeId('turn_task_delivery');
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
        observeSteerCompletion(steered, {
            sessionId: ownerSessionId,
            producer: 'Local background task delivery',
            ...(host.matrixLogger ? { matrixLogger: host.matrixLogger } : {}),
        });
        // A fail-closed activated ingress can resolve after its pre-delivery hook
        // withdrew the message, with a completion that later rejects. Observe it
        // before returning the held result so that rejection never leaks.
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
    return {
        sessionId: input.ownerSessionId,
        source: 'background-task',
        requestedTurnId: input.requestedTurnId,
        producerId: 'background-task-delivery',
        idempotencyKey: batchDeliveryIdentity(input.batchTaskIds),
        receiptAliases: input.tasks.map((task) => backgroundTaskNotificationReceiptId(task.taskId)),
        message: {
            content: buildBackgroundTaskDeliveryPrompt(input.tasks),
            attachments: [],
            hideUserMessage: true,
            origin: {
                kind: 'background-task-terminal',
                taskIds: input.tasks.map((task) => task.taskId),
                observedTerminalCount: input.observedTerminalCount,
            },
        },
    };
}
/**
 * Turn ingress receipt id of one Task's terminal notification. The runtime binds it to the
 * exact Turn that admitted or joined the delivery, so readers can tell whether that
 * notification has settled without trusting process memory.
 */
export function backgroundTaskNotificationReceiptId(taskId) {
    return `background-task-notification:${taskId}`;
}
function batchDeliveryIdentity(taskIds) {
    if (taskIds.length === 1 && taskIds[0])
        return taskIds[0];
    const digest = createHash('sha256')
        .update(JSON.stringify([...taskIds].sort()))
        .digest('hex');
    return `background-task-batch:${digest}`;
}
export function buildBackgroundTaskDeliveryPrompt(tasks) {
    return [
        '<background-task-finished>',
        'Local background tasks have finished in this conversation.',
        ...tasks.map((task) => {
            const description = task.description
                ? ` description="${escapeXmlAttribute(task.description)}"`
                : '';
            const endedAt = task.endedAt === undefined ? '' : ` ended_at_ms="${task.endedAt}"`;
            return `  <task task_id="${escapeXmlAttribute(task.taskId)}" status="${task.status}"${description}${endedAt}/>`;
        }),
        'Use task_output with each task_id to read the results, then report the relevant results to the user as a normal assistant reply in this conversation.',
        'Do not mention this internal notice unless it is necessary to explain the results.',
        '</background-task-finished>',
    ].join('\n');
}
function escapeXmlAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
//# sourceMappingURL=conversation-delivery.js.map