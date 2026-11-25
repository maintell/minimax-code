import { createHarness, } from '@mavis/harness';
/** Creates the desktop runtime's one Harness and binds it to the in-process Turn owner. */
export function createLocalHarness(dependencies, scopes) {
    const harness = createHarness(dependencies);
    return {
        host: bindLocalAgentHost(harness, scopes),
        lifecycle: harness.lifecycle,
        history: harness.history,
    };
}
/** Each run gets a scope bound to its own accepted lease and publication guard. */
function bindLocalAgentHost(harness, scopes) {
    return {
        run: async ({ beforeCapabilityCapture, ...input }) => settledOutcome(await harness.run({ ...input, scope: scopes.run(input.lease, beforeCapabilityCapture) })),
        compact: async (input) => harness.compact({ ...input, scope: scopes.compaction }),
    };
}
/**
 * Desktop runs pass no `yieldSignal` under unbounded limits, so a yielded
 * outcome rejects the run. The Turn owner gets the outcome without the
 * engine's live `continuationHint`.
 */
function settledOutcome(outcome) {
    if (outcome.status === 'yielded') {
        throw new Error(`Desktop Harness run yielded (${outcome.reason}); desktop runs never yield.`);
    }
    return withoutContinuationHint(outcome);
}
function withoutContinuationHint({ continuationHint: _continuationHint, ...outcome }) {
    return outcome;
}
//# sourceMappingURL=local-agent-host-binding.js.map