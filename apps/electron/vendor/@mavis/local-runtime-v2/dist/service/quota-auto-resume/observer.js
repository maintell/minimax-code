import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { ProtocolErrorCode } from '@mavis/protocol';
import { quotaAutoResumeTurnKey as turnKey } from './contracts.js';
/**
 * Bridges AgentHost Turn facts to the auto-resume owner: a started Turn means
 * the user is attending the Session again, and a terminal Turn carries the
 * product quota code the settlement needs. The quota fact is kept here because
 * the settlement hook only receives the Turn's terminal status.
 */
export class QuotaAutoResumeTurnObserver {
    service;
    quotaFailures = new Set();
    constructor(service) {
        this.service = service;
    }
    async observeRuntimeEvent(input) {
        const status = lifecycleStatus(input.event);
        if (!status)
            return;
        if (status === 'running') {
            await this.guard(() => this.service.noteTurnStarted(input.context));
            return;
        }
        if (status === 'failed' && isQuotaExceeded(input.event)) {
            this.quotaFailures.add(turnKey(input.context));
        }
    }
    /** Post-settlement participant: never rejects, so a Turn outcome cannot change. */
    settlement = {
        settle: async (input) => {
            const quotaExceeded = this.quotaFailures.delete(turnKey(input));
            await this.guard(() => this.service.settleTurn({ ...input, quotaExceeded }));
        },
    };
    async guard(run) {
        try {
            await run();
        }
        catch {
            // Auto-resume is best effort: any failure leaves today's failed Turn as is.
        }
    }
}
function isQuotaExceeded(event) {
    return event.payload.error?.code === ProtocolErrorCode.USAGE_LIMIT_EXCEEDED;
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
//# sourceMappingURL=observer.js.map