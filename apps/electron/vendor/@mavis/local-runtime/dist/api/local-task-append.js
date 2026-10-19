import { randomUUID } from 'node:crypto';
import { ConversationTurnRejectedError, isRuntimeConversationShutdownError, isRuntimeConversationUnavailableError, } from '@mavis/conversation-contract';
import { createBackgroundTaskId, isTerminalTaskStatus, } from '../background-task/domain.js';
import { taskIdFromTurnId, taskTurnId } from '../background-task/turn-id.js';
import { isLocalDirectTaskPurpose } from '../sessions/session-policy.js';
import { admitAppendActivation, createAppendTaskRow, persistActivatedAppendAdmissionFailure, registerAppendCompletion, } from './local-task-append-lifecycle.js';
import { isSubagentConcurrencyLimitRejection, localTaskAdmissionFailure, SUBAGENT_CONCURRENCY_LIMIT_ERROR_CODE, } from './injected-conversation-task-turn.js';
/**
 * Failure contract of `task_append`. The code/status pair is what the desktop
 * tool renders back to the model, so it stays stable and enumerated.
 */
export class LocalTaskAppendError extends Error {
    status;
    code;
    taskId;
    constructor(message, details) {
        super(message);
        this.name = 'LocalTaskAppendError';
        this.status = details.status;
        this.code = details.code;
        this.taskId = details.taskId;
    }
}
export function buildLocalTaskAppendAdapter(host) {
    return {
        append: (toolCtx, input, signal) => withAppendOutcomeLog(host, toolCtx, input, () => appendLocalTask({ host, toolCtx, input, signal })),
    };
}
/**
 * Single observation point for the whole `task_append` admission funnel. Every
 * enumerated rejection is thrown from a different guard, so logging them here
 * keeps one line per outcome — with the `code` that distinguishes them — instead
 * of scattering a log next to each `throw`. A non-`LocalTaskAppendError` escape
 * is logged too: it means the failure was not part of the declared contract.
 */
async function withAppendOutcomeLog(host, toolCtx, input, run) {
    const logCtx = { sessionId: toolCtx.sessionId, turnId: toolCtx.turnId };
    try {
        const result = await run();
        host.matrixLogger?.info(logCtx, `task_append ${result.mode}: source=${input.taskId} task=${result.taskId}`);
        return result;
    }
    catch (error) {
        if (error instanceof LocalTaskAppendError) {
            host.matrixLogger?.warn(logCtx, `task_append rejected ${error.code} (${error.status}) for task ${error.taskId}: ${error.message}`);
        }
        else {
            host.matrixLogger?.warn(logCtx, `task_append failed outside its error contract for task ${input.taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
    }
}
async function appendLocalTask(args) {
    const { host, toolCtx } = args;
    const sourceTaskId = args.input.taskId.trim();
    const content = args.input.content.trim();
    if (!sourceTaskId) {
        throw appendError('task_append requires a task_id.', {
            status: 400,
            code: 'INVALID_ARGUMENT',
            taskId: sourceTaskId,
        });
    }
    if (!content) {
        throw appendError('task_append content must not be empty after trimming.', {
            status: 400,
            code: 'INVALID_ARGUMENT',
            taskId: sourceTaskId,
        });
    }
    const conversation = requireAppendConversation(host, sourceTaskId);
    const sourceTask = requireAppendableTask(await host.backgroundTaskService.get(sourceTaskId), toolCtx, sourceTaskId);
    const childSessionId = sourceTask.childSessionId;
    const childSession = await getChildSession(conversation, childSessionId, sourceTaskId);
    requireDirectTaskChild(childSession, toolCtx, sourceTaskId);
    throwIfAbortedBeforeAdmission(args.signal, sourceTaskId);
    const candidateTaskId = createBackgroundTaskId();
    const requestedTurnId = taskTurnId(candidateTaskId);
    let admittedTaskId;
    let createdCandidateTaskRow = false;
    let admission;
    let steered;
    try {
        steered = await steerChild({
            conversation,
            sessionId: childSessionId,
            toolCtx,
            content,
            requestedTurnId,
            sourceTaskId,
            preDelivery: {
                accept: async ({ mode, turnId }) => {
                    if (mode === 'steered') {
                        admittedTaskId = await resolveActiveTaskId(host, turnId, {
                            toolCtx,
                            childSessionId,
                            sourceTaskId,
                        });
                        return;
                    }
                    // The activation admission has not registered a controller yet. A
                    // task row failure can therefore reject it without a hidden Turn.
                    if (turnId !== requestedTurnId || taskIdFromTurnId(turnId) !== candidateTaskId) {
                        throw appendError(`task_append could not map the activated Turn back to a task: ${turnId}`, { status: 409, code: 'TASK_APPEND_ACTIVE_TURN_UNMAPPED', taskId: sourceTaskId });
                    }
                    // Claimed before the row exists, so a Session stop cascade can stop it.
                    admission = admitAppendActivation(host, candidateTaskId, childSessionId);
                    try {
                        await createAppendTaskRow({
                            host,
                            taskId: candidateTaskId,
                            turnId: requestedTurnId,
                            sourceTask,
                            childSessionId,
                            toolCtx,
                        });
                        createdCandidateTaskRow = true;
                        admittedTaskId = candidateTaskId;
                    }
                    catch (error) {
                        admission.release('row_persist_failed');
                        host.matrixLogger?.warn({ sessionId: childSessionId, turnId: requestedTurnId }, `task_append could not persist task ${candidateTaskId} before Turn delivery: ${error instanceof Error ? error.message : String(error)}`);
                        throw appendError(`task_append could not persist its task row before Turn delivery: ${error instanceof Error ? error.message : String(error)}`, { status: 500, code: 'TASK_APPEND_PERSIST_FAILED', taskId: sourceTaskId });
                    }
                },
            },
        });
    }
    catch (error) {
        if (createdCandidateTaskRow) {
            await persistActivatedAppendAdmissionFailure({
                host,
                taskId: candidateTaskId,
                childSessionId,
                turnId: requestedTurnId,
                error,
            });
        }
        // After the terminal write above, the order the cascade's re-read relies on.
        admission?.release('activation_failed');
        throw error;
    }
    if (steered.mode === 'duplicate') {
        return {
            taskId: await resolveActiveTaskId(host, steered.turnId, {
                toolCtx,
                childSessionId,
                sourceTaskId,
                allowTerminal: true,
            }),
            mode: steered.mode,
        };
    }
    if (!admittedTaskId) {
        throw appendError(`task_append admission did not produce a task mapping: ${steered.turnId}`, {
            status: 409,
            code: 'TASK_APPEND_ACTIVE_TURN_UNMAPPED',
            taskId: sourceTaskId,
        });
    }
    if (steered.mode === 'activated') {
        registerAppendCompletion({
            host,
            taskId: admittedTaskId,
            turnId: steered.turnId,
            childSessionId,
            completion: steered.completion,
            sourceTask,
            admission,
        });
    }
    return { taskId: admittedTaskId, mode: steered.mode };
}
function requireAppendConversation(host, sourceTaskId) {
    if (!host.runtimeConversation) {
        throw appendError('Runtime Conversation is unavailable for task_append.', {
            status: 503,
            code: 'TASK_APPEND_UNAVAILABLE',
            taskId: sourceTaskId,
        });
    }
    return host.runtimeConversation;
}
/** §8.1: the task row itself decides whether this caller may append at all. */
function requireAppendableTask(task, toolCtx, sourceTaskId) {
    if (!task) {
        throw appendError(`Local background task not found: ${sourceTaskId}`, {
            status: 404,
            code: 'TASK_NOT_FOUND',
            taskId: sourceTaskId,
        });
    }
    if (task.ownerSessionId !== toolCtx.sessionId) {
        throw appendError(`Local background task is owned by another session: ${sourceTaskId}`, {
            status: 403,
            code: 'TASK_APPEND_FORBIDDEN',
            taskId: sourceTaskId,
        });
    }
    if (task.kind !== 'subagent') {
        throw appendError(`Local background task cannot be appended to: ${sourceTaskId}`, {
            status: 409,
            code: 'TASK_APPEND_UNSUPPORTED',
            taskId: sourceTaskId,
        });
    }
    const childSessionId = task.metadata?.childSessionId;
    if (typeof childSessionId !== 'string' || !childSessionId) {
        throw appendError(`Local background task has no child session: ${sourceTaskId}`, {
            status: 409,
            code: 'TASK_APPEND_UNSUPPORTED',
            taskId: sourceTaskId,
        });
    }
    return { ...task, childSessionId };
}
async function getChildSession(conversation, childSessionId, sourceTaskId) {
    const child = await conversation.query.getSession(childSessionId).catch((error) => {
        throw toAppendFailure(error, sourceTaskId);
    });
    if (!child) {
        throw appendError(`Task child session not found: ${childSessionId}`, {
            status: 404,
            code: 'TASK_CHILD_NOT_FOUND',
            taskId: sourceTaskId,
        });
    }
    return child;
}
/**
 * §8.2: task metadata alone is not trusted. The Session V2 facts must still
 * describe a caller-owned, unarchived direct task child.
 */
function requireDirectTaskChild(child, toolCtx, sourceTaskId) {
    const isDirectTaskChild = child.parentSessionId === toolCtx.sessionId &&
        child.sessionType === 'branch' &&
        child.sessionKind === 'task' &&
        isLocalDirectTaskPurpose(child.purpose);
    if (!isDirectTaskChild) {
        throw appendError(`Task child session is not a direct task child of this session: ${child.sessionId}`, { status: 409, code: 'TASK_CHILD_INVALID', taskId: sourceTaskId });
    }
    if (child.archived) {
        throw appendError(`Task child session is archived: ${child.sessionId}`, {
            status: 409,
            code: 'TASK_CHILD_ARCHIVED',
            taskId: sourceTaskId,
        });
    }
}
function throwIfAbortedBeforeAdmission(signal, sourceTaskId) {
    if (!signal?.aborted)
        return;
    throw appendError('task_append was aborted before Turn admission.', {
        status: 409,
        code: 'TASK_APPEND_ABORTED',
        taskId: sourceTaskId,
    });
}
async function steerChild(args) {
    try {
        return await args.conversation.ingress.steer({
            sessionId: args.sessionId,
            source: 'task',
            producerId: args.toolCtx.sessionId,
            idempotencyKey: appendIdempotencyKey(args.toolCtx),
            requestedTurnId: args.requestedTurnId,
            message: { content: args.content, attachments: [] },
            preDelivery: args.preDelivery,
        });
    }
    catch (error) {
        throw toAppendFailure(error, args.sourceTaskId);
    }
}
/**
 * §7.4: stable per tool call. Content is deliberately excluded so a replay of
 * one call is a duplicate while two distinct calls are both admitted. The UUID
 * fallback only exists for legacy fixtures without a toolCallId.
 */
function appendIdempotencyKey(toolCtx) {
    return `task-append:${toolCtx.turnId}:${toolCtx.toolCallId ?? randomUUID()}`;
}
/**
 * §7.2/§7.3: the returned Turn id is only a reversible index. The task row read
 * by primary key stays authoritative, and a Turn that cannot be mapped to a
 * runnable task row of this caller and child is rejected rather than guessed.
 */
async function resolveActiveTaskId(host, turnId, context) {
    const activeTaskId = taskIdFromTurnId(turnId);
    const activeTask = activeTaskId ? await host.backgroundTaskService.get(activeTaskId) : undefined;
    const mapped = activeTaskId !== undefined &&
        activeTask !== undefined &&
        activeTask.ownerSessionId === context.toolCtx.sessionId &&
        activeTask.kind === 'subagent' &&
        activeTask.metadata?.childSessionId === context.childSessionId &&
        (context.allowTerminal || !isTerminalTaskStatus(activeTask.status));
    if (!mapped || activeTaskId === undefined) {
        throw appendError(`task_append could not map the active Turn to a task of this session: ${turnId}`, { status: 409, code: 'TASK_APPEND_ACTIVE_TURN_UNMAPPED', taskId: context.sourceTaskId });
    }
    return activeTaskId;
}
function toAppendFailure(error, sourceTaskId) {
    if (error instanceof LocalTaskAppendError)
        return error;
    if (error instanceof ConversationTurnRejectedError) {
        return mapTurnRejection(error, sourceTaskId);
    }
    if (isRuntimeConversationUnavailableError(error) || isRuntimeConversationShutdownError(error)) {
        return appendError('Runtime Conversation is unavailable for task_append.', {
            status: 503,
            code: 'TASK_APPEND_UNAVAILABLE',
            taskId: sourceTaskId,
        });
    }
    return error;
}
function mapTurnRejection(error, sourceTaskId) {
    if (isSubagentConcurrencyLimitRejection(error)) {
        return appendError(localTaskAdmissionFailure(error).errorMessage, {
            status: 409,
            code: SUBAGENT_CONCURRENCY_LIMIT_ERROR_CODE,
            taskId: sourceTaskId,
        });
    }
    if (error.reason === 'invalid-session') {
        return appendError(`Task child session not found: ${error.sessionId}`, {
            status: 404,
            code: 'TASK_CHILD_NOT_FOUND',
            taskId: sourceTaskId,
        });
    }
    if (error.reason === 'session-deleting') {
        return appendError(`Task child session is being deleted: ${error.sessionId}`, {
            status: 409,
            code: 'TASK_CHILD_DELETING',
            taskId: sourceTaskId,
        });
    }
    return appendError(`task_append admission was rejected: ${error.sessionId} (${error.reason})`, {
        status: 409,
        code: 'TASK_APPEND_REJECTED',
        taskId: sourceTaskId,
    });
}
function appendError(message, details) {
    return new LocalTaskAppendError(message, details);
}
//# sourceMappingURL=local-task-append.js.map