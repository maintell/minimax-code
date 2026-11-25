import { randomUUID } from 'node:crypto';
import { settleInBackground } from '../../infra/async/settle.js';
import { isAssignedByBunny } from '../session-system/index.js';
/** Task history event: a background task the task started finished after the task closed. */
const TASK_BACKGROUND_FINISHED = 'task.background_finished';
/**
 * Background commands and subagents a Bunny task started that finish after the task
 * closed (review passed, cancelled, ...). Their results do not reopen a task someone
 * closed: they are recorded in its history, nothing runs in the task Session, and Bunny's
 * main conversation is woken with a `background_task` reason saying which closed task's
 * background task finished and where its result is (6.1, 6.2). Open tasks and every
 * other Session keep the ordinary delivery (6.3).
 *
 * A task closed only because Bunny's review Turn ended without a conclusion
 * (`completion.automatic`) was not done: its result takes the ordinary delivery too,
 * which starts a round in the task, and that round reopens it.
 */
export class ClosedTaskBackgroundService {
    options;
    constructor(options) {
        this.options = options;
    }
    /**
     * Takes the finished background tasks of a closed Bunny task; returns false, leaving
     * them to the ordinary delivery, for any other owner. Repeating a call records each
     * background task once and wakes Bunny under the same idempotency key, so a delivery
     * retried after a failure neither duplicates the record nor loses the wake.
     */
    async deliver(ownerSessionId, finished) {
        if (finished.length === 0)
            return false;
        const assignment = await this.options.tasks.get(ownerSessionId);
        if (!assignment?.completion || !isAssignedByBunny(assignment))
            return false;
        if (reopensOnBackgroundResult(assignment.completion))
            return false;
        for (const task of finished) {
            await this.options.tasks.appendEvent(ownerSessionId, {
                type: TASK_BACKGROUND_FINISHED,
                payload: backgroundPayload(task),
                dedupeKey: `${TASK_BACKGROUND_FINISHED}:${task.taskId}`,
            });
        }
        await this.wake(ownerSessionId, assignment, finished);
        return true;
    }
    async wake(ownerSessionId, assignment, finished) {
        const target = await this.options.agents.currentRoot(assignment.assignerAgentName);
        const session = await this.options.sessions.get(ownerSessionId);
        const title = session?.title?.trim() || ownerSessionId;
        const taskIds = finished.map((task) => task.taskId);
        const names = finished.map((task) => task.description?.trim() || task.taskId);
        const steered = await this.options.conversation.ingress.steer({
            sessionId: target,
            source: 'background-task',
            // The trusted background producer keeps the origin, which marks the input as a
            // background-task wake even when it joins a running Turn.
            producerId: 'background-task-delivery',
            idempotencyKey: `closed-task-background:${ownerSessionId}:${[...taskIds].sort().join(',')}`,
            requestedTurnId: `turn_closed_task_background_${randomUUID()}`,
            activationDisplayContent: finished
                .map((task, index) => `Background task “${names[index]}” of closed task “${title}”: ${task.status}.`)
                .join('\n'),
            message: {
                content: renderClosedTaskBackground({
                    title,
                    taskSessionId: ownerSessionId,
                    completion: assignment.completion,
                    finished,
                }),
                attachments: [],
                hideUserMessage: true,
                origin: {
                    kind: 'background-task-terminal',
                    taskIds,
                    // `tasks` is the display snapshot the conversation shows as a background-task
                    // notice row; without it the wake reads as a message the user typed.
                    tasks: finished.map((task, index) => ({
                        taskId: task.taskId,
                        name: names[index],
                        status: task.status,
                    })),
                    // A task dispatched from an IM chat: this wake's final reply is also sent there.
                    ...(assignment.originChannel ? { replyChannel: assignment.originChannel } : {}),
                },
            },
        });
        if (steered.mode !== 'activated')
            return;
        settleInBackground((async () => {
            try {
                await steered.completion;
            }
            catch (error) {
                this.options.logger.warn({ error: error instanceof Error ? error.message : String(error), sessionId: target }, 'Closed-task background wake Turn failed');
            }
        })());
    }
}
/** Only a closure nobody decided on gives way to the task's own late results. */
function reopensOnBackgroundResult(completion) {
    return (completion.automatic === true &&
        completion.state === 'completed' &&
        completion.by === 'assigner' &&
        completion.reason === 'review_passed');
}
/** Identifiers, enums and times only, like every task history payload. */
function backgroundPayload(task) {
    const childSessionId = task.metadata?.['childSessionId'];
    return {
        backgroundTaskId: task.taskId,
        kind: task.kind,
        status: task.status,
        ...(task.endedAt === undefined ? {} : { endedAtMs: task.endedAt }),
        ...(typeof childSessionId === 'string' && childSessionId ? { childSessionId } : {}),
    };
}
/** @internal Exported for focused tests. */
export function renderClosedTaskBackground(input) {
    const closure = input.completion
        ? [input.completion.state, input.completion.reason].filter(Boolean).join(', ')
        : 'closed';
    return [
        '<closed-task-background-finished>',
        `Task "${escapeXml(input.title)}" (session_id="${escapeXml(input.taskSessionId)}") was already closed (${escapeXml(closure)}) when these background tasks it started finished:`,
        ...input.finished.map((task) => `  ${renderTask(task)}`),
        'The task stays closed: the result is recorded in its task history and nothing ran in the task session.',
        "Read a background command's result from its output_file, and a background subagent's reply with the session_messages tool on its session_id.",
        'Decide yourself whether to tell the user, send the task more work, or say nothing.',
        '</closed-task-background-finished>',
    ].join('\n');
}
function renderTask(task) {
    const childSessionId = task.metadata?.['childSessionId'];
    const attributes = [
        `task_id="${escapeXml(task.taskId)}"`,
        `kind="${escapeXml(task.kind)}"`,
        `status="${escapeXml(task.status)}"`,
        ...(task.description ? [`description="${escapeXml(task.description)}"`] : []),
        ...(task.endedAt === undefined ? [] : [`ended_at_ms="${task.endedAt}"`]),
        ...(task.outputRef?.uri ? [`output_file="${escapeXml(task.outputRef.uri)}"`] : []),
        ...(typeof childSessionId === 'string' && childSessionId
            ? [`session_id="${escapeXml(childSessionId)}"`]
            : []),
    ];
    return `<task ${attributes.join(' ')}/>`;
}
function escapeXml(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
//# sourceMappingURL=closed-task-background.service.js.map