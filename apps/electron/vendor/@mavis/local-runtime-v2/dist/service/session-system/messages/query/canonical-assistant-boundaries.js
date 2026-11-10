import { Role } from '@mavis/agent-core/protocol/agent-message';
export async function projectCanonicalAssistantBoundaries(options, input) {
    const canonicalMessageIds = canonicalAssistantMessageIds(input.change);
    if (canonicalMessageIds.length === 0)
        return;
    try {
        const displayMessages = await options.messages.listTurn(input.context.sessionId, input.context.turnId);
        const assistants = displayMessages.filter(isCanonicalAssistantDisplayMessage);
        if (assistants.length < canonicalMessageIds.length)
            return;
        const targets = assistants.slice(-canonicalMessageIds.length);
        await Promise.all(targets.flatMap((message, index) => {
            const canonicalMessageId = canonicalMessageIds[index];
            return canonicalMessageId
                ? [
                    options.messages.upsert({
                        sessionId: input.context.sessionId,
                        turnId: input.context.turnId,
                        message: {
                            ...message,
                            canonical_message_id: canonicalMessageId,
                        },
                    }),
                ]
                : [];
        }));
    }
    catch {
        // The canonical commit is authoritative. This Display-side Fork anchor is
        // best-effort and old rows retain the next-User compatibility boundary.
    }
}
function canonicalAssistantMessageIds(change) {
    const messages = change.messages;
    const identities = change.committedIdentityVector;
    if (change.reason !== 'messageDelta' ||
        !messages ||
        !identities ||
        identities.length < messages.length) {
        return [];
    }
    const offset = identities.length - messages.length;
    return messages.flatMap((message, index) => {
        const identity = identities[offset + index];
        return message.role === Role.Assistant && typeof identity === 'string' && identity.length > 0
            ? [identity]
            : [];
    });
}
function isCanonicalAssistantDisplayMessage(message) {
    return (message.role === Role.Assistant &&
        !(typeof message.kind === 'string' && message.kind.length > 0) &&
        !(typeof message.displayKind === 'string' && message.displayKind.length > 0));
}
//# sourceMappingURL=canonical-assistant-boundaries.js.map