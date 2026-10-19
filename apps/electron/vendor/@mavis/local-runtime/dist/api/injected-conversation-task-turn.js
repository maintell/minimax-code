import { ConversationTurnRejectedError } from '@mavis/conversation-contract';
import { parseModelVerdict, } from '@mavis/agent-tools/desktop';
export async function runInjectedConversationTaskTurn(input) {
    const taskIdentity = {
        requestedAgentName: input.requestedAgentName ?? input.resolvedAgentName ?? 'unknown',
        ...(input.resolvedAgentName ? { resolvedAgentName: input.resolvedAgentName } : {}),
        subSessionId: input.childSession.sessionId,
    };
    let finishNotified = false;
    const notifyFinish = (result) => {
        if (finishNotified)
            return;
        finishNotified = true;
        try {
            input.onFinish?.(result);
        }
        catch {
            // Observability callbacks are best-effort and must never alter the task result.
        }
    };
    const makeResult = (result) => ({ ...taskIdentity, ...result });
    if (input.signal?.aborted) {
        const result = makeResult({
            status: 'aborted',
            subTurnId: input.turnId,
            errorMessage: 'Operation aborted',
        });
        notifyFinish(result);
        return result;
    }
    let acceptedTurnId = input.turnId;
    try {
        const accepted = await input.conversation.ingress.submit({
            sessionId: input.childSession.sessionId,
            source: input.source,
            allowQueue: input.allowQueue ?? true,
            requestedTurnId: input.turnId,
            clientRequestId: `task-turn:${input.turnId}`,
            message: {
                content: input.prompt,
                attachments: [],
                ...(input.origin === undefined ? {} : { origin: input.origin }),
            },
        });
        acceptedTurnId = accepted.turnId;
        input.onAdmitted?.(accepted.turnId);
        const result = await awaitTaskCompletion(input, accepted);
        const finalText = result.messages
            .filter((message) => message.role === 'assistant' && message.text)
            .map((message) => message.text)
            .join('\n')
            .trim();
        const verification = buildConversationVerification({
            agentRole: input.agentRole,
            finalText,
            result,
        });
        const taskResult = makeResult({
            status: result.status === 'completed'
                ? 'succeeded'
                : result.status === 'aborted'
                    ? 'aborted'
                    : 'failed',
            subTurnId: accepted.turnId,
            ...(finalText ? { finalText } : {}),
            ...(verification ? { verification } : {}),
            ...(result.status === 'completed'
                ? {}
                : { errorMessage: result.error ?? `Conversation turn ${result.status}` }),
        });
        notifyFinish(taskResult);
        return taskResult;
    }
    catch (error) {
        notifyFinish(makeResult({
            status: 'failed',
            subTurnId: acceptedTurnId,
            errorMessage: error instanceof Error ? error.message : String(error),
        }));
        throw error;
    }
}
export const SUBAGENT_CONCURRENCY_LIMIT_ERROR_CODE = 'SUBAGENT_CONCURRENCY_LIMIT';
export function isSubagentConcurrencyLimitRejection(error) {
    return (error instanceof ConversationTurnRejectedError &&
        error.reason === 'policy:subagent:concurrency-limit');
}
export function localTaskAdmissionFailure(error) {
    if (isSubagentConcurrencyLimitRejection(error)) {
        return {
            errorMessage: 'This parent Session has reached its configured child-Agent concurrency limit. Wait for one to finish, then retry.',
            errorCode: SUBAGENT_CONCURRENCY_LIMIT_ERROR_CODE,
        };
    }
    return { errorMessage: error instanceof Error ? error.message : String(error) };
}
function buildConversationVerification(input) {
    if (input.agentRole !== 'verifier')
        return undefined;
    const observation = input.result.committedFacts?.fileChangeObservation;
    return {
        ...(input.result.status === 'completed'
            ? (() => {
                const modelVerdict = parseModelVerdict(input.finalText);
                return modelVerdict ? { modelVerdict } : {};
            })()
            : {}),
        fileChange: observation?.fileChange ?? 'recording_failed',
        ...(observation?.changedFiles ? { changedFiles: [...observation.changedFiles] } : {}),
        observationNotes: observation?.observationNotes
            ? [...observation.observationNotes]
            : ['local_turn_diff_not_started'],
    };
}
/** Covers cancellation both during admission and while queued/running. */
async function awaitTaskCompletion(input, accepted) {
    const { signal } = input;
    if (!signal)
        return accepted.completion;
    let abortOperation;
    let rejectAbort;
    const abortFailure = new Promise((_, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => {
        if (abortOperation)
            return;
        abortOperation = cancelAcceptedTask(input, accepted.turnId);
        void abortOperation.catch(rejectAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // AbortSignal does not replay an event emitted while submit() was pending.
    if (signal.aborted)
        onAbort();
    let outcome;
    try {
        outcome = { succeeded: true, result: await Promise.race([accepted.completion, abortFailure]) };
    }
    catch (error) {
        outcome = { succeeded: false, error };
    }
    finally {
        // 先关闭监听，再等待已有取消；避免完成边界之后又启动未被 drain 的操作。
        signal.removeEventListener('abort', onAbort);
    }
    try {
        await abortOperation;
    }
    catch (error) {
        if (!outcome.succeeded && error !== outcome.error) {
            throw new AggregateError([outcome.error, error], 'Task completion and cancellation failed');
        }
        throw error;
    }
    if (!outcome.succeeded)
        throw outcome.error;
    return outcome.result;
}
async function cancelAcceptedTask(input, turnId) {
    const { ingress } = input.conversation;
    const sessionId = input.childSession.sessionId;
    const failures = [];
    try {
        const queued = await ingress.findQueuedByClientRequestId(sessionId, `task-turn:${input.turnId}`);
        if (queued)
            await ingress.cancelQueued(sessionId, queued.itemId);
    }
    catch (error) {
        failures.push(error);
    }
    // 队列存储失败不能跳过精确 abort：已 claim 的子 Turn 仍可能继续执行。
    try {
        await ingress.abort(sessionId, 'lifecycle', turnId);
    }
    catch (error) {
        failures.push(error);
    }
    if (failures.length === 1)
        throw failures[0];
    if (failures.length > 1) {
        throw new AggregateError(failures, 'Task queue cancellation and exact Turn abort failed');
    }
}
//# sourceMappingURL=injected-conversation-task-turn.js.map