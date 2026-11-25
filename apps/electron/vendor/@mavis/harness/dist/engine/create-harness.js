import { LocalAgentHost } from '../agent-host/index.js';
import { assertTurnYieldLimits } from '../agent-host/turn-yield/turn-yield-control.js';
import { createHarnessHistory } from './history.js';
import { InFlightCalls } from './kernel/in-flight-calls.js';
import { HarnessInstanceState } from './kernel/instance-state.js';
import { createRunYield, yieldableRunScope } from './kernel/run-yield.js';
import { agentHostCompactionDependencies, agentHostRunDependencies } from './run-dependencies.js';
/**
 * Creates the harness once per composition root. Each run / compaction builds
 * its kernel from the dependencies, its own scope and the instance state; see
 * `LocalAgentHost` for why the per-host commit replay registry does not need
 * to be shared. Both entries are async, so a malformed scope rejects like any
 * kernel failure instead of throwing. A run's scope stays readable to the
 * extensions through `state.runs` until the run settles. `calls` admits both
 * entries until `lifecycle.close()` starts and lets close wait for them.
 * `limits` are checked here, so a bad bound fails the composition root, not a run.
 */
export function createHarness(dependencies) {
    assertTurnYieldLimits(dependencies.limits);
    const state = new HarnessInstanceState(dependencies);
    const calls = new InFlightCalls();
    const options = { compactionAttempts: state.compactionAttempts };
    return {
        run: (runInput) => calls.admit('run', async () => {
            const { scope, yieldSignal, ...input } = runInput;
            const turnYield = createRunYield(dependencies.limits, yieldSignal);
            const runScope = yieldableRunScope(scope, turnYield);
            const release = state.runs.enter(input.lease, runScope);
            try {
                const beforeCapabilityCapture = scope.host.hooks?.beforeCapabilityCapture;
                return await new LocalAgentHost(agentHostRunDependencies(dependencies, runScope, state), {
                    ...options,
                    turnYield,
                }).runYieldable({
                    ...input,
                    ...(beforeCapabilityCapture ? { beforeCapabilityCapture } : {}),
                });
            }
            finally {
                turnYield.dispose();
                release();
            }
        }),
        compact: (compactionInput) => calls.admit('compact', async () => {
            const { scope, ...input } = compactionInput;
            return new LocalAgentHost(agentHostCompactionDependencies(dependencies, scope, state), options).compact(input);
        }),
        history: createHarnessHistory(),
        lifecycle: {
            disposeSession: (sessionId) => state.disposeSession(sessionId),
            close: () => calls.close(() => state.release(), dependencies.closeDrainTimeoutMs),
            pluginHooks: state.pluginHooks,
        },
    };
}
//# sourceMappingURL=create-harness.js.map