/**
 * Every run shares the Session ports of `compaction` (history, events,
 * artifacts keep their ordering state per object) and adds its lease-bound
 * Turn control.
 */
export function createLocalRunScopes(compaction, turnControl) {
    return {
        compaction,
        run: (lease, beforeCapabilityCapture) => ({
            ...compaction,
            host: {
                ...compaction.host,
                control: liftLocalTurnControl(turnControl.scope(lease)),
                ...(beforeCapabilityCapture
                    ? { hooks: { ...compaction.host.hooks, beforeCapabilityCapture } }
                    : {}),
            },
        }),
    };
}
/**
 * Desktop Turn control answers in-process. Each call runs synchronously when
 * invoked and its result is wrapped in an already-settled Promise, so every
 * Host critical section stays atomic.
 */
function liftLocalTurnControl(control) {
    return {
        setBackgroundTaskWaiting: control.setBackgroundTaskWaiting &&
            ((waiting) => control.setBackgroundTaskWaiting?.(waiting)),
        setComputerUseAvailable: control.setComputerUseAvailable &&
            ((available) => control.setComputerUseAvailable?.(available)),
        steeringSignal: control.steeringSignal && (() => control.steeringSignal?.()),
        drainSteering: async () => control.drainSteering(),
        ackSteering: async (messages) => control.ackSteering(messages),
        restoreSteering: async (messages) => control.restoreSteering(messages),
        tryBeginClose: async (options) => control.tryBeginClose(options),
        cancelClose: async () => control.cancelClose(),
        sealAbnormalTerminal: async () => control.sealAbnormalTerminal(),
        toolResultTail: {
            open: async () => control.openToolResultTail(),
            closeAndClaim: async (toolCallId) => control.closeAndClaimToolResultTail(toolCallId),
            ack: async (toolCallId) => control.ackToolResultTail(toolCallId),
        },
    };
}
//# sourceMappingURL=local-host-binding.js.map