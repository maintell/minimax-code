import { PluginHookTranscript } from '@mavis/agent-tools/plugin-hooks';
import { PluginHookRunner } from '@mavis/plugin-hooks';
import { initializeHookConfigService, } from '../../service/hook-config/index.js';
import { requireTurnSystem, } from '../../service/turn-system/index.js';
import { createRuntimePluginAuthContextNotifier, } from './runtime-services-lifecycle.js';
/**
 * Builds the harness Plugin Hook config: the Host-owned command runner, the
 * file-backed vendor transcripts, the user / project config hooks merged ahead
 * of Plugin hooks, the enabled Plugin resolver, SessionEnd fencing and Hook
 * observation.
 */
export function createRuntimePluginHookConfig(input, plugin, 
/** Read at SessionEnd time: the harness owning the hooks is built inside the TurnSystem. */
readTurnSystem) {
    const { dataDir, logger, metrics } = input.options;
    const hookConfig = initializeHookConfigService({
        dataDir,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(logger ? { logger } : {}),
    });
    return {
        harness: {
            runner: new PluginHookRunner(),
            createTranscript: (transcript) => PluginHookTranscript.create(transcript),
            configSource: hookConfig.turnHooks,
            enabledPluginNames: () => plugin.enabledHookPluginNames(),
            sessionEndFence: createRuntimePluginHookSessionEndFence(() => requireTurnSystem(readTurnSystem())),
            ...(logger ? { logger } : {}),
            ...(metrics ? { metrics } : {}),
            runtime: 'desktop',
            deferredExecutionReason: 'PreToolUse Plugin Hook requested deferred execution, which Desktop does not support.',
        },
        hookConfig: hookConfig.management,
    };
}
function createRuntimePluginHookSessionEndFence(readTurnSystem) {
    return {
        run: async (fenceInput) => {
            const turnSystem = readTurnSystem();
            const tryRunExclusive = turnSystem.sessionLifecycle.tryRunExclusive;
            if (!tryRunExclusive) {
                return { status: 'executed', result: await fenceInput.operation() };
            }
            const attempt = await tryRunExclusive(fenceInput.sessionId, async (maintenanceSignal) => {
                const ownershipClaimId = fenceInput.sessionOwnershipClaim;
                if (!ownershipClaimId)
                    return { status: 'superseded' };
                const latestOwnership = await turnSystem.pluginHookSessionOwnership.latest(fenceInput.sessionId);
                if (latestOwnership?.ownershipClaimId !== ownershipClaimId) {
                    return { status: 'superseded' };
                }
                const latest = await turnSystem.inspection?.latestTurnActivity?.(fenceInput.sessionId);
                if (fenceInput.reason === 'idle_timeout' && fenceInput.idleSinceMs !== undefined) {
                    if (latest && latest.activityAtMs > fenceInput.idleSinceMs) {
                        return { status: 'deferred', latestActivityAtMs: latest.activityAtMs };
                    }
                }
                const sessionEndClaimId = `${ownershipClaimId}:session-end`;
                const claimed = await turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd({
                    sessionId: fenceInput.sessionId,
                    ownershipClaimId,
                    sessionEndClaimId,
                    reason: fenceInput.reason,
                });
                if (claimed.status !== 'claimed')
                    return { status: 'superseded' };
                try {
                    return {
                        status: 'executed',
                        result: await fenceInput.operation(maintenanceSignal),
                    };
                }
                finally {
                    await turnSystem.pluginHookSessionOwnership.completeSessionEnd({
                        sessionId: fenceInput.sessionId,
                        ownershipClaimId,
                        sessionEndClaimId,
                    });
                }
            });
            return attempt.acquired ? attempt.value : { status: 'deferred' };
        },
    };
}
/** Auth lifecycle of Plugin Hooks; logout ends their Sessions through the harness lifecycle. */
export function createRuntimePluginHookAuthNotifier(input) {
    const { plugin, turnSystem } = input;
    return createRuntimePluginAuthContextNotifier({
        authContextChanged: () => plugin.authContextChanged(),
        enabledHookPluginNames: () => plugin.enabledHookPluginNames(),
        abortSession: (sessionId) => turnSystem.turns.abort({ sessionId, reason: 'logout' }),
        endAllSessionsForLogout: async (enabledPluginNames, abortSession) => {
            await turnSystem.pluginHooks?.endAllForLogout(enabledPluginNames, abortSession);
        },
    });
}
//# sourceMappingURL=runtime-plugin-hook-composition.js.map