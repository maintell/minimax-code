import { runawayGuardExtension } from '@mavis/agent-extension';
import { resolveRunawayGuardConfig } from '@mavis/config';
import { createProductionRunawayGuardToolPolicies } from './tool-policy.js';
import { createRunawayGuardObserver } from './observation.js';
/** Config/file/Eval ownership stays in the host; the extension is process-neutral. */
export function createProductionRunawayGuardExtension(options) {
    const emit = createRunawayGuardObserver(options);
    const local = readBestEffort(options.readLocalConfig);
    return runawayGuardExtension({
        toolPolicies: createProductionRunawayGuardToolPolicies(),
        readVerifiedProgress: options.readVerifiedProgress,
        isEnabled: () => resolveRunawayGuardConfig(local, readBestEffort(options.readRemoteConfig)).enabled,
        shouldRemind: (ctx) => ctx.turnIntent?.kind !== 'goal-verifier',
        onSignal: (value) => emit('runaway_guard_signal', value),
        onReminder: (value) => emit('runaway_guard_reminder_injected', value),
        onTurnSummary: (value) => emit('runaway_guard_turn_summary', value),
    });
}
function readBestEffort(read) {
    try {
        return read?.();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=extension.js.map