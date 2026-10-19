import { isQuestionnaireResponseInput, isRewindableQuestionnaireResponseInput, } from '../input-navigation/text.js';
import { commitSessionRewind } from './transaction.js';
export function createSessionRewindCapability(input) {
    const nowMs = input.nowMs ?? Date.now;
    return {
        planInclusive: async ({ sessionId, fromMessageId }) => {
            const messages = (await input.messages.list(sessionId)).messages;
            const target = messages.findIndex((message) => message.msg_id === fromMessageId);
            if (target < 0)
                throw new Error(`Rewind target user message not found: ${sessionId}/${fromMessageId}`);
            const targetMessage = messages[target];
            if (!targetMessage ||
                targetMessage.role !== 'user' ||
                !fromMessageId.startsWith('msg-user-v1-')) {
                throw new Error(`Rewind target must be a committed user message: ${fromMessageId}`);
            }
            const deleted = messages.slice(target);
            const retainedTurnIds = new Set(messages.slice(0, target).flatMap((message) => (message.turnId ? [message.turnId] : [])));
            const affectedTurnIds = [
                ...new Set(deleted.flatMap((message) => (message.turnId ? [message.turnId] : []))),
            ];
            return {
                deletedMessageIds: deleted.flatMap((message) => (message.msg_id ? [message.msg_id] : [])),
                affectedTurnIds,
                ...(targetMessage.turnId ? { targetTurnId: targetMessage.turnId } : {}),
                subsequentUserMessageIds: deleted
                    .slice(1)
                    .flatMap((message) => message.role === 'user' && isExternalUserMessageId(message.msg_id)
                    ? [message.msg_id]
                    : []),
                partiallyRetainedTurnIds: affectedTurnIds.filter((turnId) => retainedTurnIds.has(turnId)),
                targetIsQuestionnaireResponse: isQuestionnaireResponseInput(targetMessage),
                targetQuestionnaireResponseRewindEligible: isRewindableQuestionnaireResponseInput(targetMessage),
            };
        },
        commit: async (request) => {
            const result = commitSessionRewind(input.db, nowMs, request);
            const session = await input.sessions.update(request.sessionId, {
                status: 'idle',
                errorMessage: undefined,
                errorCode: undefined,
                errorSource: undefined,
                errorDetail: undefined,
                errorProviderId: undefined,
            });
            if (!session) {
                throw new Error(`Session disappeared after Rewind commit: ${request.sessionId}`);
            }
            return result;
        },
    };
}
function isExternalUserMessageId(value) {
    return typeof value === 'string' && value.startsWith('msg-user-v1-');
}
//# sourceMappingURL=service.js.map