import { AgentHostDependencyUnavailableError, assertAgentHostCapabilityAvailable, } from '../agent-host/index.js';
/**
 * Flattens the public lease-bound control into the kernel control. The kernel
 * awaits every call, so Promise results pass through without another wrapper.
 * Missing required operations fail closed before the Turn starts, exactly like
 * the kernel's own control check.
 */
function toAgentHostScopedTurnControl(control) {
    const tail = control?.toolResultTail;
    assertAgentHostCapabilityAvailable('turn-control', [
        control?.drainSteering,
        control?.tryBeginClose,
        control?.cancelClose,
        control?.sealAbnormalTerminal,
        tail?.open,
        tail?.closeAndClaim,
        tail?.ack,
    ].every((operation) => typeof operation === 'function'));
    return {
        setBackgroundTaskWaiting: control.setBackgroundTaskWaiting
            ? (waiting) => control.setBackgroundTaskWaiting?.(waiting)
            : undefined,
        setComputerUseAvailable: control.setComputerUseAvailable
            ? (available) => control.setComputerUseAvailable?.(available)
            : undefined,
        steeringSignal: control.steeringSignal ? () => control.steeringSignal?.() : undefined,
        drainSteering: () => control.drainSteering(),
        ackSteering: (messages) => control.ackSteering(messages),
        restoreSteering: (messages) => control.restoreSteering(messages),
        tryBeginClose: (options) => control.tryBeginClose(options),
        cancelClose: () => control.cancelClose(),
        sealAbnormalTerminal: () => control.sealAbnormalTerminal(),
        openToolResultTail: () => tail.open(),
        closeAndClaimToolResultTail: (toolCallId) => tail.closeAndClaim(toolCallId),
        ackToolResultTail: (toolCallId) => tail.ack(toolCallId),
    };
}
/** Run scopes arrive already bound to their lease, so the kernel lookup returns that control. */
export function bindScopedTurnControl(control) {
    return { scope: () => toAgentHostScopedTurnControl(control) };
}
/** Compaction never runs Turn callbacks; any Turn-control lookup is a wiring error. */
export const COMPACTION_TURN_CONTROL = Object.freeze({
    scope: () => {
        throw new AgentHostDependencyUnavailableError('turn-control');
    },
});
//# sourceMappingURL=turn-control.js.map