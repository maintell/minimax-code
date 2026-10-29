import { initializeBackgroundTaskService, buildLocalBashAdapter, stopBackgroundLocalBashTask, createChildBashLifecycle, admitBackgroundTask, abortAdmittedBackgroundTask, beginBackgroundTaskShutdown, drainBackgroundTasks, openUserStopWindow, isTaskDeliverySuppressed, attributeTaskRowRound, } from '../../service/background-task/index.js';
import { closeLocalBackgroundTaskDelivery, scheduleLocalBackgroundTaskDelivery, } from './background-task-delivery.js';
import { createUserStopCascade } from './background-task-user-stop-cascade.js';
export function prepareBackgroundTasks(input) {
    let host;
    let abortChild;
    let publish;
    const requireHost = () => {
        if (!host)
            throw new Error('Background task runtime is not bound');
        return host;
    };
    const owner = initializeBackgroundTaskService({
        ...input,
        onChanged: (task) => publish?.(task),
        onTerminal: (task) => requireHost().wakeSessionQueueAfterDependencyRelease(task.ownerSessionId),
        // Subagent task rows are created before their child round is submitted or
        // delivered, so the Goal owner learns the pairing before its first request.
        // The owner binds late, so it is read on every creation.
        onCreated: (task) => attributeTaskRowRound(host?.subSessionRoundAttribution, task),
        stopRuntime: async (task, reason) => {
            abortAdmittedBackgroundTask(requireHost(), task.taskId, reason ?? (task.kind === 'bash' ? 'Background bash stopped' : 'Background task stopped'));
            if (task.kind === 'bash') {
                await stopBackgroundLocalBashTask(task, reason);
                return;
            }
            const childSessionId = task.metadata?.childSessionId;
            const subTurnId = task.metadata?.subTurnId;
            if (typeof childSessionId !== 'string' || typeof subTurnId !== 'string')
                throw new Error('Background task execution owner is unknown');
            if (!abortChild)
                throw new Error('Background task Turn owner is unavailable');
            const result = await abortChild({
                sessionId: childSessionId,
                reason: 'lifecycle',
                turnId: subTurnId,
            });
            if (result.status === 'abort-timeout' || result.status === 'turn-mismatch')
                throw new Error(`Child task stop incomplete: ${result.status}`);
        },
    });
    return {
        ...owner,
        bindTurnAbort(abort) {
            abortChild = abort;
        },
        async close() {
            if (!host)
                return;
            closeLocalBackgroundTaskDelivery(host);
            beginBackgroundTaskShutdown(host);
            await drainBackgroundTasks(host);
        },
        suppressDelivery(taskId, sessionId) {
            const bound = requireHost();
            const window = openUserStopWindow(bound, sessionId, bound.nowMs());
            window.registerTargets([taskId]);
            window.close();
        },
        bindPublisher(writer) {
            publish = writer;
        },
        createRuntime(boundHost) {
            if (host)
                throw new Error('Background task runtime already bound');
            host = boundHost;
            return {
                service: owner.service,
                buildBashAdapter: (session, executor) => buildLocalBashAdapter(boundHost, session, executor),
                admit: (abort) => admitBackgroundTask(boundHost, abort),
                scheduleDelivery: (taskId) => scheduleLocalBackgroundTaskDelivery(boundHost, taskId),
                isDeliverySuppressed: (taskId) => isTaskDeliverySuppressed(boundHost, taskId),
                beginShutdown: () => {
                    closeLocalBackgroundTaskDelivery(boundHost);
                    beginBackgroundTaskShutdown(boundHost);
                },
                drain: () => drainBackgroundTasks(boundHost),
                createChildBashLifecycle: (child) => createChildBashLifecycle(owner.service, child),
                createUserStopCascade: (pauseActiveGoal) => createUserStopCascade({ host: boundHost, pauseActiveGoal }),
            };
        },
    };
}
//# sourceMappingURL=background-task-composition.js.map