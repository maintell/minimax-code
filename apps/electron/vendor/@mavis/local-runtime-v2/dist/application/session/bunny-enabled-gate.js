import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { ConversationTurnRejectedError, } from '@mavis/conversation-contract';
const BUNNY_DISABLED_REJECTION = 'policy:bunny-disabled';
/**
 * Pauses the automatic messages Bunny's own owners send into a Bunny session
 * (task reports) while the Bunny beta switch is off. The
 * sender sees an ordinary turn rejection: reports stay held and are delivered
 * after the switch is back on, nothing is dropped from storage. Messages to a
 * task session and user-authored submissions are never gated here.
 */
export function gateBunnyCommunication(conversation, enabled) {
    const ingress = conversation.ingress;
    const submit = async (input) => {
        if (input.source === 'communication' && !enabled()) {
            const target = await conversation.query.getSession(input.sessionId);
            if (target && isBunnyAgentName(target.agentName))
                throw new ConversationTurnRejectedError(input.sessionId, BUNNY_DISABLED_REJECTION);
        }
        return ingress.submit(input);
    };
    // Forward every other ingress method untouched, including ones on a class prototype.
    const gated = new Proxy(ingress, {
        get(target, property) {
            if (property === 'submit')
                return submit;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return {
        query: conversation.query,
        lifecycle: conversation.lifecycle,
        maintenance: conversation.maintenance,
        ...(conversation.taskConcurrency ? { taskConcurrency: conversation.taskConcurrency } : {}),
        ingress: gated,
    };
}
//# sourceMappingURL=bunny-enabled-gate.js.map