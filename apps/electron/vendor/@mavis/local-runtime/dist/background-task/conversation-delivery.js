import { createHash } from 'node:crypto';
import { ConversationTurnRejectedError, } from '@mavis/conversation-contract';
import { makeId } from '../api/host-helpers.js';
import { observeSteerCompletion } from '../api/conversation-steer.js';
export async function startConversationBackgroundTaskDeliveryTurn(input) {
    const { host, conversation, ownerSessionId, tasks, batchTaskIds, observedTerminalCount } = input;
    try {
        const requestedTurnId = makeId('turn_task_delivery');
        const steered = await conversation.ingress.steer(buildBackgroundTaskDeliveryInput({
            ownerSessionId,
            tasks,
            batchTaskIds,
            observedTerminalCount,
            requestedTurnId,
        }));
        // Delivery only needs the admission ACK; the owner Turn keeps running.
        observeSteerCompletion(steered, {
            sessionId: ownerSessionId,
            producer: 'Local background task delivery',
            ...(host.matrixLogger ? { matrixLogger: host.matrixLogger } : {}),
        });
        return 'delivered';
    }
    catch (error) {
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
export function buildBackgroundTaskDeliveryInput(input) {
    return {
        sessionId: input.ownerSessionId,
        source: 'background-task',
        requestedTurnId: input.requestedTurnId,
        producerId: 'background-task-delivery',
        idempotencyKey: batchDeliveryIdentity(input.batchTaskIds),
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