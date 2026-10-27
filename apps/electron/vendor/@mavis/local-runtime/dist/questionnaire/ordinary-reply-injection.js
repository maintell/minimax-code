import { LocalQuestionnaireError } from './errors.js';
import { canQueueReplyBehindActiveTurn, queueReplyBehindActiveTurn } from './reply-fallback.js';
import { serializeQuestionnaireResponseMessage } from './serializer.js';
/**
 * Legacy reply delivery (resume Turn, degrading to the queue front behind an
 * active Turn), moved out of the service class unchanged so the class stays
 * inside the local-runtime layout budget. v2 questionnaires use
 * `deliverV2Answer` instead.
 */
export async function injectOrdinaryQuestionnaireReply(deps, record, reply, continuationIdentityOrAutomatic) {
    const message = {
        content: serializeQuestionnaireResponseMessage(record.request, reply, deps.resolveLocale?.()),
        attachments: [],
        ...(record.request.mode === 'questionnaire' && record.request.purpose !== 'goal'
            ? {
                origin: {
                    kind: 'questionnaire-response',
                    requestId: record.requestId,
                    mode: 'questionnaire',
                    purpose: 'ordinary',
                },
            }
            : {}),
        ...(record.originChannelContext ? { channelContext: record.originChannelContext } : {}),
    };
    const conversation = deps.conversation;
    if (!conversation) {
        throw new LocalQuestionnaireError(503, 'CONVERSATION_UNAVAILABLE', 'Runtime Conversation is unavailable for questionnaire reply');
    }
    const resumeUserInput = conversation.ingress.resumeUserInput?.bind(conversation.ingress);
    if (!resumeUserInput) {
        await conversation.ingress.submit({
            sessionId: record.sessionId,
            source: 'questionnaire',
            allowQueue: true,
            clientRequestId: `questionnaire-reply:${record.requestId}`,
            dedupeKey: `questionnaire-reply:${record.requestId}`,
            message,
        });
        return { completed: true, admissionMode: 'started' };
    }
    const continuationIdentity = typeof continuationIdentityOrAutomatic === 'string'
        ? continuationIdentityOrAutomatic
        : continuationIdentityOrAutomatic
            ? `questionnaire-reply:${record.requestId}`
            : undefined;
    try {
        const admitted = await resumeUserInput({
            sessionId: record.sessionId,
            source: 'questionnaire',
            requestId: record.requestId,
            message,
            ...(continuationIdentity ? { requestedTurnId: continuationIdentity } : {}),
        });
        return { completed: true, admissionMode: admitted.mode };
    }
    catch (err) {
        if (!canQueueReplyBehindActiveTurn(record, err))
            throw err;
        return queueReplyBehindActiveTurn(conversation, record, message);
    }
}
//# sourceMappingURL=ordinary-reply-injection.js.map