import { ChannelFinalReplyObserver } from './delivery/channel-final-reply-observer.js';
import { ChannelTurnLifecycle } from './delivery/channel-turn-lifecycle.js';
/** Initializes the v2 owner for Channel ingress, routing and delivery capabilities. */
function initializeChannelSystem(options) {
    const turnLifecycle = new ChannelTurnLifecycle({ typing: options.product.typing });
    return {
        turnLifecycle,
        terminalReplies: new ChannelFinalReplyObserver({
            messages: options.messages,
            sessions: options.sessions,
            delivery: options.product.finalReplies,
            turnLifecycle,
        }),
    };
}
export function initializeOptionalChannelSystem(enabled, options) {
    return enabled ? initializeChannelSystem(options) : undefined;
}
//# sourceMappingURL=initialize.js.map