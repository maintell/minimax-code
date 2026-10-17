import { createLocalCronRuntime, buildLocalCronChannelDelivery, } from '../cron/index.js';
export function buildHostCronRuntime(host, runQueuedTurn, metricsReporter, cronConsumerEnabled, startupExecutionPolicy) {
    return createLocalCronRuntime({
        cronStore: host.cronStore,
        agentRoutes: host.agentRoutes,
        queueStore: host.queueStore,
        activePiTurns: host.sessionTurns,
        runQueuedTurn,
        nowMs: host.nowMs,
        dataDir: () => host.configGetter().dataDir,
        primaryAgentName: host.agentName,
        ...(host.resolveAgentReadScope ? { resolveAgentReadScope: host.resolveAgentReadScope } : {}),
        ...(host.resolveAgentWriteTarget
            ? { resolveAgentWriteTarget: host.resolveAgentWriteTarget }
            : {}),
        ...(host.resolveAgentExecutionTarget
            ? { resolveAgentExecutionTarget: host.resolveAgentExecutionTarget }
            : {}),
        resolveDefaultWorkspaceDir: () => host.resolveDefaultWorkspaceDir(),
        getSessionById: (id) => host.getSessionById(id),
        listAllSessions: (agentName, options) => host.listAllSessions(agentName, options),
        updateSession: (id, fields) => host.updateSession(id, fields),
        deleteSession: (id) => host.deleteSession(id),
        deleteMessageState: (id) => host.deleteMessageState(id),
        channelDelivery: buildHostCronChannelDelivery(host),
        emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
        runtimeOwnerKind: host.lockOwner.ownerKind,
        runtimeOwnerId: host.lockOwner.ownerId,
        runtimeMode: host.runtimeMode,
        capabilities: host.capabilities,
        startupExecutionPolicy,
        cronConsumerEnabled: cronConsumerEnabled ?? (host.lockOwner.ownerKind !== 'cli' && !host.capabilities.cliEmbedded),
        ...(metricsReporter ? { metricsReporter } : {}),
    });
}
export function startHostCronRuntime(runtime, emitBusEvent) {
    if (!runtime.cronConsumerEnabled)
        return;
    void runtime.ensureStarted('host_init').catch((err) => {
        emitBusEvent('cron.startup_failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    });
}
function buildHostCronChannelDelivery(host) {
    // Lazy port resolution: in external composition the channel subsystem is
    // bound AFTER host construction, and cron only sends when a schedule fires.
    return buildLocalCronChannelDelivery({
        channel: {
            sendChannelText: (input) => host.requireChannelPort('cron delivery').sendChannelText(input),
            isChannelConfigured: (platform, agentName) => host.requireChannelPort('cron delivery gate').isChannelConfigured(platform, agentName),
        },
    });
}
//# sourceMappingURL=host-cron-runtime.js.map