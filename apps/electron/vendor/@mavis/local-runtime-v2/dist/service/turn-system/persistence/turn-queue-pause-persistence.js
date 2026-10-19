import { and, desc, eq } from 'drizzle-orm';
import { turnIngress } from '../../../infra/db/schema/turn.js';
export function publishQueueFacts(options, facts) {
    try {
        options.priorityFence.publishCommitted(facts);
    }
    catch {
        // Queue facts project committed state best-effort; authoritative reads converge later.
    }
}
export function persistedTurnConsumesQueuePause(db, sessionId) {
    const row = db
        .select({ inputMetadataJson: turnIngress.inputMetadataJson })
        .from(turnIngress)
        .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.status, 'accepted')))
        .orderBy(desc(turnIngress.acceptedSequence))
        .limit(1)
        .get();
    if (!row)
        return false;
    try {
        const metadata = JSON.parse(row.inputMetadataJson);
        return Boolean(metadata &&
            typeof metadata === 'object' &&
            !Array.isArray(metadata) &&
            metadata.consumeQueuePause === true);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=turn-queue-pause-persistence.js.map