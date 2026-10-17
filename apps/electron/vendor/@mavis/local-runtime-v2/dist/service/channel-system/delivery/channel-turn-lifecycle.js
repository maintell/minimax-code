import { resolveChannelRoute } from './routing.js';
/**
 * Owns the process-local typing lifecycle for accepted Channel Turns.
 *
 * The execution-start fence awaits `beforeExecution`, while terminal delivery
 * calls `end` in a finally block. Product hooks remain best-effort and the
 * active map makes exact in-process retries idempotent.
 */
export class ChannelTurnLifecycle {
    options;
    active = new Map();
    constructor(options) {
        this.options = options;
    }
    async beforeExecution(input) {
        const channelContext = resolveChannelRoute(input.provenance);
        if (!channelContext)
            return;
        const identity = turnIdentity(input);
        if (this.active.has(identity))
            return;
        this.active.set(identity, channelContext);
        await ignoreFailure(() => this.options.typing.start({
            channelContext,
            sessionId: input.sessionId,
        }));
    }
    async end(input) {
        const identity = turnIdentity(input);
        const channelContext = this.active.get(identity);
        if (!channelContext)
            return;
        this.active.delete(identity);
        await ignoreFailure(() => this.options.typing.end({
            channelContext,
            sessionId: input.sessionId,
        }));
    }
}
function turnIdentity(input) {
    return `${input.sessionId}\0${input.turnId}`;
}
async function ignoreFailure(operation) {
    try {
        await operation();
    }
    catch {
        // Typing is user feedback only and must never affect Turn execution or settlement.
    }
}
//# sourceMappingURL=channel-turn-lifecycle.js.map