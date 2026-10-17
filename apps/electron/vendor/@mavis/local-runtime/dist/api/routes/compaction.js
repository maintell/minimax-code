import { json } from '../host-helpers.js';
/**
 * Compatibility HTTP adapter only. Compaction execution belongs to the
 * injected V2 Conversation maintenance owner.
 */
export async function requestConversationCompaction(conversation, session, body) {
    const outcome = await conversation.maintenance.compact({
        sessionId: session.sessionId,
        agentName: session.agentName,
        ...(readOptionalString(body.customInstructions)
            ? { customInstructions: readOptionalString(body.customInstructions) }
            : {}),
        ...(readOptionalString(body.reason) ? { reason: readOptionalString(body.reason) } : {}),
    });
    return json(compactionOutcomeToResponseBody(outcome), { status: outcome.status });
}
function compactionOutcomeToResponseBody(outcome) {
    if (outcome.success) {
        return {
            success: true,
            sessionId: outcome.sessionId,
            compactionId: outcome.compactionId,
            messagesBefore: outcome.messagesBefore,
            messagesAfter: outcome.messagesAfter,
            tokensBefore: outcome.tokensBefore,
            tokensAfter: outcome.tokensAfter,
        };
    }
    return {
        success: false,
        error: outcome.error,
        code: outcome.code,
    };
}
function readOptionalString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
//# sourceMappingURL=compaction.js.map