import { initializeHookConfigService, } from '../../service/hook-config/index.js';
import { configureLocalConfigHookSource, configureLocalPluginHookEnabledResolver, configureLocalPluginHookObservability, configureLocalPluginHookSessionEndFence, endAllLocalPluginHookSessionsForLogout, } from '../../service/turn-system/index.js';
import { createRuntimePluginAuthContextNotifier, } from './runtime-services-lifecycle.js';
/**
 * Binds process-local Plugin Hook observation, SessionEnd fencing, auth
 * lifecycle, and the user / project config hooks merged ahead of Plugin hooks.
 */
export function configureRuntimePluginHooks(input) {
    const { plugin, turnSystem } = input;
    const hookConfig = initializeHookConfigService({
        dataDir: input.dataDir,
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        ...(input.logger ? { logger: input.logger } : {}),
    });
    configureLocalConfigHookSource(hookConfig.turnHooks);
    configureLocalPluginHookEnabledResolver(() => plugin.enabledHookPluginNames());
    configureLocalPluginHookSessionEndFence({
        run: async (fenceInput) => {
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
    });
    configureLocalPluginHookObservability({
        ...(input.logger ? { logger: input.logger } : {}),
        ...(input.metrics ? { metrics: input.metrics } : {}),
    });
    const notifyAuthContextChanged = createRuntimePluginAuthContextNotifier({
        authContextChanged: () => plugin.authContextChanged(),
        enabledHookPluginNames: () => plugin.enabledHookPluginNames(),
        abortSession: (sessionId) => turnSystem.turns.abort({ sessionId, reason: 'logout' }),
        endAllSessionsForLogout: endAllLocalPluginHookSessionsForLogout,
    });
    return { notifyAuthContextChanged, hookConfig: hookConfig.management };
}
//# sourceMappingURL=runtime-plugin-hook-composition.js.map