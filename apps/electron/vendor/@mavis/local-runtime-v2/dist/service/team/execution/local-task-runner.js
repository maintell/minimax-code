import { createSubagentFinishTelemetrySink } from '../../agent/index.js';
import { createBackgroundTaskId } from '../../../infra/legacy-db/background-task-contracts.js';
import { createLocalSubagentTaskRow, persistLocalSubagentTaskTerminal, taskTurnId, isSubagentConcurrencyLimitRejection, localTaskAdmissionFailure, logTaskAdmissionRejectedAfterPrecheck, precheckTaskConcurrency, readTaskOccupancy, runInjectedConversationTaskTurn, requireTaskConversation, normalizeLocalTaskInput, taskModelSelectionFor, resolveLocalTaskAgentTarget, taskSessionOwner, } from '../../background-bash/index.js';
import { resolveV2SessionArtifactPathsSync } from '../../../infra/legacy-db/v2-session-artifacts.js';
export async function runForegroundLocalTask(input) {
    if (input.signal?.aborted)
        throw new Error('Operation aborted');
    const taskInput = normalizeLocalTaskInput(input.taskInput);
    const conversation = requireTaskConversation(input.host);
    const target = await resolveLocalTaskAgentTarget(input.host, taskInput.agent_name, input.toolCtx.pluginAgents);
    if (!target) {
        // No runnable target, so there is nothing to track: the failure carries no
        // task handle because no task row was ever created.
        return {
            status: 'failed',
            requestedAgentName: taskInput.agent_name,
            errorMessage: `Unknown agent: ${taskInput.agent_name}`,
        };
    }
    // Admission needs the child Session to find its parent, so a full parent is
    // checked here first to avoid leaving an empty child Session behind.
    const precheckFailure = await precheckTaskConcurrency({
        conversation: input.host.runtimeConversation,
        parentSessionId: input.parentSession.sessionId,
        requestedAgentName: target.requestedName,
    });
    if (precheckFailure) {
        return {
            status: 'failed',
            requestedAgentName: target.requestedName,
            resolvedAgentName: target.resolvedAgentName,
            ...precheckFailure,
        };
    }
    return executeForegroundLocalTask(input, taskInput, conversation, target);
}
async function executeForegroundLocalTask(input, taskInput, conversation, target) {
    const agentName = target.resolvedAgentName;
    const taskId = createBackgroundTaskId();
    const turnId = taskTurnId(taskId);
    await createLocalSubagentTaskRow({
        host: input.host,
        taskId,
        turnId,
        executionMode: 'foreground',
        ownerSessionId: input.parentSession.sessionId,
        toolCtx: input.toolCtx,
        taskInput,
        target,
    });
    let childSession;
    let releaseOwnerWaitEdge;
    try {
        childSession = await createForegroundChildSession(input, taskInput, target);
        await input.host.backgroundTaskService.patch(taskId, {
            status: 'running',
            startedAt: input.host.nowMs(),
            metadata: { childSessionId: childSession.sessionId, subTurnId: turnId, agentName },
        });
        await prepareForegroundChild(input, childSession.sessionId, turnId);
        releaseOwnerWaitEdge = input.host.sessionSendWaitGraph?.register(input.parentSession.sessionId, childSession.sessionId);
        notifyChildStarted(input, childSession.sessionId, turnId);
        const pluginStartContext = await input.toolCtx.pluginSubagentLifecycle?.start({
            childSessionId: childSession.sessionId,
            childTurnId: turnId,
            agentId: childSession.sessionId,
            agentType: agentName,
            agentTranscriptPath: resolveV2SessionArtifactPathsSync(input.host.configGetter().dataDir, childSession.sessionId, { createdAtMs: childSession.createdAtMs }).display,
        }, input.signal);
        const result = await runInjectedConversationTaskTurn({
            conversation,
            childSession,
            turnId,
            prompt: appendPluginHookContext(taskInput.prompt, pluginStartContext),
            source: 'task',
            allowQueue: input.host.useImmediateTaskAdmission !== true,
            ...(input.origin === undefined ? {} : { origin: input.origin }),
            requestedAgentName: target.requestedName,
            resolvedAgentName: agentName,
            ...(target.canonicalRole === 'verifier' && target.trustedBuiltin
                ? { agentRole: 'verifier' }
                : {}),
            onFinish: createSubagentFinishTelemetrySink(input.host, target.canonicalRole ?? target.resolvedAgentName, 'foreground'),
            signal: input.signal,
        });
        await finalizeForegroundTask(input.host, taskId, result, turnId);
        if (result.status !== 'succeeded')
            cancelChild(input, childSession.sessionId);
        return { ...result, taskId };
    }
    catch (error) {
        cancelChild(input, childSession?.sessionId);
        const occupancy = await readOccupancyIfLimited(input, error, {
            taskId,
            childSessionId: childSession?.sessionId,
        });
        const failure = buildForegroundFailure({
            error,
            target,
            childSession,
            turnId,
            taskId,
            occupancy,
        });
        await finalizeForegroundTask(input.host, taskId, failure, turnId);
        return failure;
    }
    finally {
        releaseOwnerWaitEdge?.();
    }
}
function createForegroundChildSession(input, taskInput, target) {
    const taskModelSelection = taskModelSelectionFor(taskInput);
    return input.host.agentRoutes.createSession({
        ...taskSessionOwner(target),
        workspaceDir: input.parentSession.workspaceDir || input.host.resolveDefaultWorkspaceDir(),
        sessionType: 'branch',
        sessionKind: 'task',
        parentSessionId: input.parentSession.sessionId,
        title: taskInput.description,
        visibility: 'hidden',
        purpose: `local-task:${input.toolCtx.turnId}:${input.toolCtx.toolCallId ?? 'tool'}`,
        runLocation: input.parentSession.runLocation,
        appMode: input.parentSession.appMode,
        isDefaultWorkspace: input.parentSession.isDefaultWorkspace,
        ...(taskModelSelection ? { taskModelSelection } : {}),
    });
}
/** Trusted hosts prepare the child (for example inherited restrictions) before its first Turn. */
async function prepareForegroundChild(input, childSessionId, turnId) {
    if (!input.prepareChild)
        return;
    await input.prepareChild({ subSessionId: childSessionId, subTurnId: turnId });
    if (input.signal?.aborted)
        throw new Error('Operation aborted');
}
async function readOccupancyIfLimited(input, error, attempt) {
    if (!isSubagentConcurrencyLimitRejection(error))
        return undefined;
    const occupancy = await readTaskOccupancy(input.host.runtimeConversation, input.parentSession.sessionId);
    logTaskAdmissionRejectedAfterPrecheck({
        parentSessionId: input.parentSession.sessionId,
        taskId: attempt.taskId,
        childSessionId: attempt.childSessionId,
        occupancy,
    });
    return occupancy;
}
function buildForegroundFailure(input) {
    const { error, target, childSession, turnId, taskId, occupancy } = input;
    return {
        status: 'failed',
        requestedAgentName: target.requestedName,
        resolvedAgentName: target.resolvedAgentName,
        ...(childSession ? { subSessionId: childSession.sessionId } : {}),
        subTurnId: turnId,
        ...localTaskAdmissionFailure(error, occupancy),
        taskId,
    };
}
function notifyChildStarted(input, subSessionId, subTurnId) {
    try {
        input.onChildStarted?.({ subSessionId, subTurnId });
    }
    catch {
        // Diagnostic observation must never change task execution.
    }
}
function cancelChild(input, sessionId) {
    if (sessionId)
        input.toolCtx.pluginSubagentLifecycle?.cancel(sessionId);
}
function appendPluginHookContext(prompt, context) {
    return context?.trim()
        ? `${prompt}\n\n<plugin-hook-context>\n${context.trim()}\n</plugin-hook-context>`
        : prompt;
}
/**
 * The foreground tool result is already the owner-visible delivery, so the row
 * is latched as delivered and must never produce a second
 * background-task-finished wake-up.
 */
async function finalizeForegroundTask(host, taskId, result, turnId) {
    try {
        await persistLocalSubagentTaskTerminal({
            host,
            taskId,
            result,
            delivery: 'already-delivered',
        });
    }
    catch (error) {
        // Persistence is the only failure that cannot be reported through the task
        // row itself; the run result still reaches the owner synchronously.
        host.matrixLogger?.warn({ sessionId: result.subSessionId ?? '', turnId }, `Local foreground task ${taskId} could not persist its terminal state: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=local-task-runner.js.map