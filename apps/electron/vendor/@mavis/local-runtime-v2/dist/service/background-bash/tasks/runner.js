import { createBackgroundTaskId } from '../../../infra/legacy-db/background-task-contracts.js';
import { createLocalSubagentTaskRow } from './subagent-task-row.js';
import { persistLocalSubagentTaskTerminal } from '../delivery/terminal.js';
import { taskTurnId } from './turn-id.js';
import { createSubagentFinishTelemetrySink } from '../../agent/index.js';
import { logger } from '../../../infra/logging/logger.js';
import { resolveV2SessionArtifactPathsSync } from '../../../infra/legacy-db/v2-session-artifacts.js';
import { isSubagentConcurrencyLimitRejection, localTaskAdmissionFailure, logTaskAdmissionRejectedAfterPrecheck, precheckTaskConcurrency, readTaskOccupancy, runInjectedConversationTaskTurn, } from '../shared-task/injected-conversation-task-turn.js';
import { requireTaskConversation } from '../shared-task/local-task-host.js';
import { normalizeLocalTaskInput, taskModelSelectionFor } from '../shared-task/local-task-input.js';
import { resolveLocalTaskAgentTarget, taskSessionOwner, } from '../shared-task/local-task-subagents.js';
import { admitBackgroundTask } from './lifecycle.js';
export async function startBackgroundLocalTask(input) {
    if (input.signal?.aborted)
        throw new Error('Operation aborted');
    const controller = new AbortController();
    const admission = admitBackgroundTask(input.host, (reason) => controller.abort(reason));
    try {
        return await startAdmittedBackgroundLocalTask(input, admission, controller.signal);
    }
    finally {
        admission.release();
    }
}
async function startAdmittedBackgroundLocalTask(input, admission, shutdownSignal) {
    const prepared = await prepareAdmittedTask(input, admission, shutdownSignal);
    if ('result' in prepared)
        return prepared.result;
    return startTaskTurn(prepared.setup, admission);
}
async function prepareAdmittedTask(input, admission, shutdownSignal) {
    const taskInput = normalizeLocalTaskInput(input.taskInput);
    requireTaskConversation(input.host);
    const target = await resolveLocalTaskAgentTarget(input.host, taskInput.agent_name, input.toolCtx.pluginAgents);
    throwIfShuttingDown(shutdownSignal);
    if (!target) {
        return { result: { status: 'failed', errorMessage: `Unknown agent: ${taskInput.agent_name}` } };
    }
    // Admission needs the child Session to find its parent, so a full parent is
    // checked here first to avoid leaving an empty child Session behind.
    const precheckFailure = await precheckTaskConcurrency({
        conversation: input.host.runtimeConversation,
        parentSessionId: input.parentSession.sessionId,
        requestedAgentName: target.requestedName,
    });
    if (precheckFailure)
        return { result: { status: 'failed', ...precheckFailure } };
    const taskId = createBackgroundTaskId();
    admission.identify(taskId);
    const turnId = taskTurnId(taskId);
    await createLocalSubagentTaskRow({
        host: input.host,
        taskId,
        turnId,
        executionMode: 'background',
        ownerSessionId: input.parentSession.sessionId,
        toolCtx: input.toolCtx,
        taskInput,
        target,
    });
    if (shutdownSignal.aborted) {
        return {
            result: await cancelAdmittedTaskSetup({ input, target, taskId, turnId, shutdownSignal }),
        };
    }
    return createAdmittedTaskSession({ input, target, taskInput, taskId, turnId, shutdownSignal });
}
async function createAdmittedTaskSession(input) {
    const { input: startInput, target, taskInput, taskId, turnId, shutdownSignal } = input;
    let childSession;
    try {
        childSession = await startInput.host.agentRoutes.createSession({
            ...taskSessionOwner(target),
            workspaceDir: startInput.parentSession.workspaceDir || startInput.host.resolveDefaultWorkspaceDir(),
            sessionType: 'branch',
            sessionKind: 'task',
            parentSessionId: startInput.parentSession.sessionId,
            title: taskInput.description,
            visibility: 'hidden',
            purpose: `local-background-task:${taskId}`,
            runLocation: startInput.parentSession.runLocation,
            appMode: startInput.parentSession.appMode,
            isDefaultWorkspace: startInput.parentSession.isDefaultWorkspace,
            ...(taskModelSelectionFor(taskInput)
                ? { taskModelSelection: taskModelSelectionFor(taskInput) }
                : {}),
        });
        if (!shutdownSignal.aborted) {
            await startInput.host.backgroundTaskService.patch(taskId, {
                status: 'running',
                startedAt: startInput.host.nowMs(),
                metadata: {
                    childSessionId: childSession.sessionId,
                    subTurnId: turnId,
                    agentName: target.resolvedAgentName,
                },
            });
            if (!shutdownSignal.aborted) {
                return {
                    setup: { input: startInput, target, taskId, turnId, childSession, shutdownSignal },
                };
            }
        }
    }
    catch (error) {
        if (!shutdownSignal.aborted) {
            return { result: await failAdmittedTaskSetup({ ...input, childSession, error }) };
        }
    }
    // Shutdown won somewhere in setup. The canceled terminal is written once and
    // outside the try, so a failed write reaches the caller instead of being
    // caught and written again.
    return {
        result: await cancelAdmittedTaskSetup({
            input: startInput,
            target,
            taskId,
            turnId,
            childSession,
            shutdownSignal,
        }),
    };
}
/**
 * The row exists but the task never reached its start ACK, so the owner is
 * told synchronously through <task_error task_id> and the row is closed here
 * instead of waiting for a background delivery that will never run.
 */
async function failAdmittedTaskSetup(input) {
    const { taskId, turnId, childSession, error } = input;
    await persistLocalSubagentTaskTerminal({
        host: input.input.host,
        taskId,
        result: { failure: error },
        delivery: 'already-delivered',
    });
    return {
        status: 'failed',
        taskId,
        ...(childSession ? { subSessionId: childSession.sessionId } : {}),
        subTurnId: turnId,
        errorMessage: error instanceof Error ? error.message : String(error),
    };
}
async function startTaskTurn(setup, admission) {
    const { input, target, taskId, turnId, childSession: startedChildSession, shutdownSignal, } = setup;
    const requireImmediateAdmission = input.host.useImmediateTaskAdmission === true;
    let admitted = false;
    let resolveAdmission;
    let rejectAdmission;
    const admissionAck = requireImmediateAdmission
        ? new Promise((resolve, reject) => {
            resolveAdmission = resolve;
            rejectAdmission = reject;
        })
        : undefined;
    const execution = runBackgroundLocalTaskTurn({
        host: input.host,
        taskId,
        childSession: startedChildSession,
        turnId,
        prompt: normalizeLocalTaskInput(input.taskInput).prompt,
        target,
        requestedAgentName: target.requestedName,
        toolCtx: input.toolCtx,
        signal: shutdownSignal,
        requireImmediateAdmission,
        allowQueue: !requireImmediateAdmission,
        ...(requireImmediateAdmission
            ? {
                onAdmitted: () => {
                    admitted = true;
                    resolveAdmission();
                },
            }
            : {}),
    });
    const settled = (async () => {
        try {
            await execution;
            if (admissionAck && !admitted) {
                rejectAdmission(new Error('Task child Turn finished before admission.'));
            }
        }
        catch (error) {
            warnTaskRunnerFailure(setup, error);
            if (admissionAck && !admitted) {
                rejectAdmission(error);
                return;
            }
            throw error;
        }
    })();
    if (admissionAck) {
        try {
            await admissionAck;
        }
        catch (error) {
            await settled;
            return failTaskAdmission(setup, error);
        }
    }
    admission.bind(settled);
    const concurrency = await readTaskOccupancy(input.host.runtimeConversation, input.parentSession.sessionId);
    return {
        status: 'started',
        taskId,
        subSessionId: startedChildSession.sessionId,
        subTurnId: turnId,
        ...(concurrency
            ? { concurrency: { active: concurrency.active, limit: concurrency.limit } }
            : {}),
    };
}
function warnTaskRunnerFailure(setup, error) {
    try {
        setup.input.host.matrixLogger?.warn({ sessionId: setup.childSession.sessionId, turnId: setup.turnId }, `Local background task runner failed after error handling: ${error instanceof Error ? error.message : String(error)}`);
    }
    catch {
        // Diagnostics must not prevent admission failure reporting or shutdown drain.
    }
}
async function failTaskAdmission(setup, error) {
    const { input, target, taskId, turnId, childSession, shutdownSignal } = setup;
    input.toolCtx.pluginSubagentLifecycle?.cancel(childSession.sessionId);
    if (shutdownSignal.aborted)
        return cancelAdmittedTaskSetup(setup);
    const concurrencyRejected = isSubagentConcurrencyLimitRejection(error);
    const occupancy = concurrencyRejected
        ? await readTaskOccupancy(input.host.runtimeConversation, input.parentSession.sessionId)
        : undefined;
    if (concurrencyRejected) {
        logTaskAdmissionRejectedAfterPrecheck({
            parentSessionId: input.parentSession.sessionId,
            taskId,
            childSessionId: childSession.sessionId,
            occupancy,
        });
    }
    const admissionFailure = localTaskAdmissionFailure(error, occupancy);
    const failure = {
        status: 'failed',
        requestedAgentName: target.requestedName,
        resolvedAgentName: target.resolvedAgentName,
        taskId,
        subSessionId: childSession.sessionId,
        subTurnId: turnId,
        ...admissionFailure,
    };
    await persistLocalSubagentTaskTerminal({
        host: input.host,
        taskId,
        result: failure,
        delivery: 'already-delivered',
    });
    return {
        status: 'failed',
        taskId,
        subSessionId: childSession.sessionId,
        subTurnId: turnId,
        ...admissionFailure,
    };
}
async function cancelAdmittedTaskSetup(input) {
    const errorMessage = abortReason(input.shutdownSignal);
    const result = {
        status: 'aborted',
        requestedAgentName: input.target.requestedName,
        resolvedAgentName: input.target.resolvedAgentName,
        taskId: input.taskId,
        subTurnId: input.turnId,
        ...(input.childSession ? { subSessionId: input.childSession.sessionId } : {}),
        errorMessage,
    };
    await persistLocalSubagentTaskTerminal({
        host: input.input.host,
        taskId: input.taskId,
        result,
        delivery: 'already-delivered',
    });
    return {
        status: 'failed',
        taskId: input.taskId,
        subTurnId: input.turnId,
        ...(input.childSession ? { subSessionId: input.childSession.sessionId } : {}),
        errorMessage,
    };
}
function throwIfShuttingDown(signal) {
    if (signal.aborted)
        throw new Error(abortReason(signal));
}
function abortReason(signal) {
    return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}
async function runBackgroundLocalTaskTurn(input) {
    const result = await executeBackgroundTaskTurn(input);
    if ('failure' in result || result.status !== 'succeeded') {
        input.toolCtx.pluginSubagentLifecycle?.cancel(input.childSession.sessionId);
    }
    await persistLocalSubagentTaskTerminal({
        host: input.host,
        taskId: input.taskId,
        result,
        delivery: 'schedule',
    });
}
async function executeBackgroundTaskTurn(input) {
    let admitted = false;
    let result;
    try {
        const conversation = requireTaskConversation(input.host);
        const pluginStartContext = await input.toolCtx.pluginSubagentLifecycle?.start({
            childSessionId: input.childSession.sessionId,
            childTurnId: input.turnId,
            agentId: input.childSession.sessionId,
            agentType: input.target.resolvedAgentName,
            agentTranscriptPath: resolveV2SessionArtifactPathsSync(input.host.configGetter().dataDir, input.childSession.sessionId, { createdAtMs: input.childSession.createdAtMs }).display,
        }, input.signal);
        throwIfShuttingDown(input.signal);
        result = await runInjectedConversationTaskTurn({
            conversation,
            childSession: input.childSession,
            turnId: input.turnId,
            prompt: appendPluginHookContext(input.prompt, pluginStartContext),
            source: 'background-task',
            allowQueue: input.allowQueue,
            signal: input.signal,
            requestedAgentName: input.requestedAgentName,
            resolvedAgentName: input.target.resolvedAgentName,
            ...trustedVerifierRole(input.target),
            onFinish: createSubagentFinishTelemetrySink(input.host, input.target.canonicalRole ?? input.target.resolvedAgentName, 'background'),
            ...(input.onAdmitted
                ? {
                    onAdmitted: () => {
                        admitted = true;
                        input.onAdmitted?.();
                    },
                }
                : {}),
        });
    }
    catch (error) {
        if (input.requireImmediateAdmission && !admitted)
            throw error;
        result = taskTurnFailure(input, error);
    }
    if (input.requireImmediateAdmission && !admitted) {
        const message = taskTurnErrorMessage(result);
        throw new Error(message || 'Task child Turn did not reach admission.');
    }
    return result;
}
function trustedVerifierRole(target) {
    return target.canonicalRole === 'verifier' && target.trustedBuiltin
        ? { agentRole: 'verifier' }
        : {};
}
function taskTurnFailure(input, error) {
    if (!input.signal.aborted)
        return { failure: error };
    try {
        logger.warn({
            taskId: input.taskId,
            sessionId: input.childSession.sessionId,
            turnId: input.turnId,
            error,
        }, 'Local background task caught an error during shutdown');
    }
    catch {
        // Diagnostics must not prevent canceled task persistence or shutdown drain.
    }
    return {
        status: 'aborted',
        requestedAgentName: input.requestedAgentName,
        resolvedAgentName: input.target.resolvedAgentName,
        subSessionId: input.childSession.sessionId,
        subTurnId: input.turnId,
        errorMessage: abortReason(input.signal),
    };
}
function taskTurnErrorMessage(result) {
    if ('failure' in result)
        return result.failure instanceof Error ? result.failure.message : String(result.failure);
    return result.errorMessage;
}
function appendPluginHookContext(prompt, context) {
    return context?.trim()
        ? `${prompt}\n\n<plugin-hook-context>\n${context.trim()}\n</plugin-hook-context>`
        : prompt;
}
//# sourceMappingURL=runner.js.map