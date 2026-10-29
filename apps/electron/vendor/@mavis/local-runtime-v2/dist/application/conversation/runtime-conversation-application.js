import { createConversationApplication, DirectSendDeliveryService, QueueSteerWorkflow, TurnContinuationDeliveryService, } from './index.js';
export function createRuntimeConversationApplication(options) {
    const directSend = new DirectSendDeliveryService({
        turns: options.turnSystem.turns,
        queue: options.sessionSystem.queue.committed,
        stream: options.sessionSystem.stream,
        activation: options.sessionSystem.sessions.activation,
        workspaceGate: { prepareForSessionStart: options.prepareForSessionStart },
    });
    const queueSteer = new QueueSteerWorkflow({
        queue: options.sessionSystem.queue.committed,
        turn: options.turnSystem.turns,
        control: options.turnSystem.queueSteer,
        stream: options.sessionSystem.stream,
        activation: options.sessionSystem.sessions.activation,
        workspaceGate: { prepareForSessionStart: options.prepareForSessionStart },
    });
    const continuation = new TurnContinuationDeliveryService({
        turns: options.turnSystem.turns,
        stream: options.sessionSystem.stream,
        queryCollapse: {
            resolve: (sessionId, turnId) => options.queryCollapseKeys.queryKeyForContinuation(sessionId, turnId),
            start: (request) => options.sessionSystem.queryCollapse.state.start(request),
        },
    });
    return createConversationApplication({
        directSend,
        continuation,
        turn: options.turnSystem.turns,
        queue: options.sessionSystem.queue.committed,
        stream: options.sessionSystem.stream,
        sessionReader: options.sessionSystem.sessions.query,
        sideChats: options.sessionSystem.sideChats,
        attachmentRegistration: options.attachmentRegistration,
        threadGoal: { pauseActiveForAbort: options.pauseActiveForAbort },
        steer: (input) => options.runtimeConversation.ingress.steer(input),
        queueSteer,
        ...(options.turnSystem.inspection ? { turnInspection: options.turnSystem.inspection } : {}),
        ...(options.metrics ? { metrics: options.metrics } : {}),
    });
}
//# sourceMappingURL=runtime-conversation-application.js.map