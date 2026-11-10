import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
export function createSessionTurnLifecycleEvents(input) {
    const { captureAfterTurn, ...options } = input;
    return new SessionTurnLifecycleEventObserver({
        ...options,
        workspaceRevision: { captureAfterTurn },
    });
}
/**
 * Projects committed v2 AgentHost lifecycle facts to the product EventBus.
 *
 * Direct and detached Turns share this observer, so UI, CLI and remote clients
 * see one lifecycle regardless of which ingress admitted the Turn.
 */
export class SessionTurnLifecycleEventObserver {
    options;
    startedTurns = new Map();
    constructor(options) {
        this.options = options;
    }
    async observeRuntimeEvent(input) {
        const status = lifecycleStatus(input.event);
        if (!status)
            return;
        const identity = await this.ensureStarted(input.context);
        if (status === 'running')
            return;
        try {
            await this.recordTerminalMemory(input.context, identity, status, input.event);
            this.publishTerminal(input.context, identity, status, input.event);
            await this.captureWorkspaceRevision(input.context.sessionId);
        }
        finally {
            this.startedTurns.delete(turnKey(input.context));
        }
    }
    async ensureStarted(context) {
        const key = turnKey(context);
        const startedAgent = this.startedTurns.get(key);
        if (startedAgent)
            return startedAgent;
        // Read before the first await: settling the Turn drops its Goal binding,
        // so the terminal event reuses this answer instead of asking again, unless
        // the user's deletion of the Goal detached the Turn in the meantime.
        const goal = goalTurnIdentity(context, this.options.goals);
        const session = await this.options.sessions.get(context.sessionId);
        if (!session) {
            throw new Error(`Session lifecycle event Session not found: ${context.sessionId}`);
        }
        const queueItemIds = context.queueItemIds?.length ? [...context.queueItemIds] : undefined;
        const backgroundTask = backgroundTaskDeliveryIdentity(context);
        this.options.publish({
            type: 'session.start',
            payload: {
                sessionId: context.sessionId,
                agentName: session.agentName,
                turnId: context.turnId,
                turnSequence: context.turnSequence,
                ...(backgroundTask ??
                    (queueItemIds ? { source: 'queued-drain', queueItemIds } : {})),
                ...goal,
            },
        });
        const identity = {
            agentName: session.agentName,
            resourceAgentName: context.resourceAgentName ?? session.agentName,
            memoryWriteEnabled: session.memoryPolicy?.writeEnabled !== false,
            goal,
        };
        this.startedTurns.set(key, identity);
        return identity;
    }
    async recordTerminalMemory(context, identity, status, event) {
        const record = this.options.terminalMemory?.record;
        if (!record || !identity.memoryWriteEnabled)
            return;
        const errorMessage = terminalErrorMessage(event);
        try {
            await record({
                sessionId: context.sessionId,
                turnId: context.turnId,
                agentName: identity.resourceAgentName,
                status: terminalMemoryStatus(status),
                ...(errorMessage ? { errorMessage } : {}),
            });
        }
        catch {
            // Memory bookkeeping is best-effort and cannot replace the terminal lifecycle event.
        }
    }
    async captureWorkspaceRevision(sessionId) {
        const capture = this.options.workspaceRevision?.captureAfterTurn;
        if (!capture)
            return;
        try {
            await capture(sessionId);
        }
        catch {
            // Revision capture is best-effort and cannot affect the Turn outcome.
        }
    }
    publishTerminal(context, identity, status, event) {
        const common = {
            sessionId: context.sessionId,
            agentName: identity.agentName,
            turnId: context.turnId,
            turnSequence: context.turnSequence,
            ...(cronRunIdentity(context) ?? {}),
            ...(backgroundTaskDeliveryIdentity(context) ?? {}),
            // A Turn whose Goal the user deleted ended as an ordinary Turn: clients
            // notify its end like any other Turn's.
            ...(this.options.goals.takeDetachedTurn(context.sessionId, context.turnId)
                ? {}
                : identity.goal),
        };
        if (status === 'completed') {
            this.options.publish({
                type: 'session.finish',
                payload: { ...common, status: 'finished' },
            });
            return;
        }
        if (status === 'aborted') {
            this.options.publish({
                type: 'session.abort',
                payload: { ...common, status: 'aborted' },
            });
            return;
        }
        const error = event.payload.error;
        const message = terminalErrorMessage(event);
        this.options.publish({
            type: 'session.error',
            payload: {
                ...common,
                status: 'error',
                ...(message ? { error: message } : {}),
                ...(typeof error?.code === 'number' ? { errorCode: error.code } : {}),
                ...(error ? { errorSource: 'agent-runtime' } : {}),
                ...(error?.details ? { errorDetail: error.details } : {}),
            },
        });
    }
}
function terminalMemoryStatus(status) {
    if (status === 'completed')
        return 'finished';
    if (status === 'failed')
        return 'error';
    return 'aborted';
}
function terminalErrorMessage(event) {
    return event.payload.error?.message?.trim() || event.payload.stop_reason?.message?.trim();
}
function lifecycleStatus(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS &&
        event.type !== RuntimeEventType.TURN_TERMINAL) {
        return undefined;
    }
    if (event.payload.status === RuntimeEventStatus.RUNNING)
        return 'running';
    if (event.payload.status === RuntimeEventStatus.COMPLETED)
        return 'completed';
    if (event.payload.status === RuntimeEventStatus.FAILED)
        return 'failed';
    return event.payload.status === RuntimeEventStatus.ABORTED ? 'aborted' : undefined;
}
function turnKey(context) {
    return `${context.sessionId}\0${context.turnId}`;
}
function cronRunIdentity(context) {
    if (context.provenance?.source !== 'cron')
        return undefined;
    const sourceContext = context.provenance.sourceContext;
    const cronId = sourceContext?.cronId;
    const runId = sourceContext?.runId;
    if (typeof cronId !== 'string' || !cronId.trim() || typeof runId !== 'string' || !runId.trim()) {
        return undefined;
    }
    return { cronId, cronRunId: runId };
}
function backgroundTaskDeliveryIdentity(context) {
    if (context.provenance?.source !== 'background-task')
        return undefined;
    const origin = context.provenance.sourceContext?.origin;
    if (!origin || typeof origin !== 'object')
        return undefined;
    if (Reflect.get(origin, 'kind') !== 'background-task-terminal')
        return undefined;
    const taskIds = Reflect.get(origin, 'taskIds');
    if (!Array.isArray(taskIds))
        return undefined;
    const taskId = taskIds.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
    return taskId ? { source: 'background-task-delivery', taskId } : undefined;
}
/**
 * The Goal a Goal Turn works for. Clients use it to tell a Goal Turn's
 * lifecycle apart from an ordinary Turn in the same Session: a Goal Turn
 * ending is not a notification of its own (spec §12).
 *
 * A Turn is a Goal Turn when admission bound it to the Goal, whatever source
 * queued it: a reply to the Goal's questionnaire is one, an ordinary reply or
 * a steering Turn is not.
 */
function goalTurnIdentity(context, goals) {
    const goalId = goals.goalIdForTurn(context.sessionId, context.turnId);
    return goalId ? { goalId } : {};
}
//# sourceMappingURL=turn-lifecycle-event-observer.js.map