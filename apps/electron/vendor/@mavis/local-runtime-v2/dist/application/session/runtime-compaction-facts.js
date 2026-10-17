import { publishSessionCompactionFact } from './fact-ports.js';
export function createRuntimeCompactionFactSink(inspector, publishGlobalEvent) {
    if (!inspector) {
        return { handle: (fact) => publishSessionCompactionFact(publishGlobalEvent, fact) };
    }
    return {
        handle: async (fact) => {
            if (fact.kind === 'completed') {
                try {
                    await inspector.service.recordCompletedCompaction(fact.sessionId, fact.attemptId);
                }
                catch {
                    // Inspector observation must never roll back a committed compaction.
                }
            }
            publishSessionCompactionFact(publishGlobalEvent, fact);
        },
    };
}
//# sourceMappingURL=runtime-compaction-facts.js.map