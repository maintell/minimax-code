import { createCompactionReplaceMetadata, readCompactionTokenUsage, readPostCompactionContextUsage, } from './context-compaction.js';
export function createManualCompactionChange(input, previousMessages, result, attemptId) {
    return {
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        reason: 'replaceMessages',
        messages: cloneCompactionMessages(result.replacementMessages),
        previousMessages: cloneCompactionMessages(previousMessages),
        metadata: createCompactionReplaceMetadata(result, 'manual', attemptId),
        operation: {
            id: `agent-host:${input.lease.turnId}:history:compaction:${encodeURIComponent(result.compactionId)}`,
            kind: 'compaction',
        },
    };
}
function cloneCompactionMessages(messages) {
    return [...messages];
}
export function createCompactionLifecycleMetadata(result, phase, attemptId) {
    const contextUsage = readPostCompactionContextUsage(result.contextUsage);
    const tokenUsage = readCompactionTokenUsage(result.tokenUsage);
    return {
        attemptId,
        compactionId: result.compactionId,
        method: result.method,
        strategyVersion: result.strategyVersion,
        phase,
        messagesBefore: result.messagesBefore,
        messagesAfter: result.messagesAfter,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        serializedBytesBefore: result.serializedBytesBefore,
        serializedBytesAfter: result.serializedBytesAfter,
        ...(result.hmidOverflowRecovered ? { hmidOverflowRecovered: true } : {}),
        ...(contextUsage === undefined ? {} : { contextUsage }),
        ...(tokenUsage === undefined ? {} : { tokenUsage }),
    };
}
//# sourceMappingURL=compaction-history.js.map