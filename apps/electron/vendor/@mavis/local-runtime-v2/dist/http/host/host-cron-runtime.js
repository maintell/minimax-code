import { settleInBackground } from '../../service/plugin-system/index.js';
import { createLocalCronRuntime, buildLocalCronChannelDelivery, } from '../../service/cron/index.js';
function buildHostCronRuntime(host, options) {
    const { runQueuedTurn, metricsReporter, cronConsumerEnabled, startupExecutionPolicy } = options;
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
        listAllSessions: (agentName, listOptions) => host.listAllSessions(agentName, listOptions),
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
const unavailableCronResponse = async () => new Response(JSON.stringify({ error: 'Runtime Conversation is unavailable' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' },
});
/** `LocalRuntimeApiHost` 构造期的兼容 Cron 装配。 */
export function createHostCronRuntime(host, options, owner) {
    return buildHostCronRuntime({
        cronStore: host.cronStore,
        agentRoutes: host.agentRoutes,
        queueStore: owner.queueStore,
        // Turn 计时归 V2 Goal owner，Host 不再登记活动 Turn；兼容 Cron 也不执行 Turn
        // （runQueuedTurn 固定返回 503），因此这里没有 Host 侧的活动 Turn。
        sessionTurns: { has: () => false },
        nowMs: host.nowMs,
        agentName: host.agentName,
        requireChannelPort: (capability) => host.requireChannelPort(capability),
        configGetter: () => ({ dataDir: host.configGetter().dataDir }),
        resolveDefaultWorkspaceDir: () => host.resolveDefaultWorkspaceDir(),
        getSessionById: (sessionId) => host.getSessionById(sessionId),
        listAllSessions: (agentName, listOptions) => host.listAllSessions(agentName, listOptions),
        updateSession: (sessionId, fields) => updateSessionForCron(host, sessionId, fields),
        deleteSession: (sessionId) => host.deleteSession(sessionId),
        deleteMessageState: (sessionId) => deleteMessageStateForCron(host, sessionId),
        emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
        lockOwner: owner.lockOwner,
        runtimeMode: owner.runtimeMode,
        capabilities: owner.capabilities,
    }, {
        runQueuedTurn: unavailableCronResponse,
        metricsReporter: options.metricsReporter,
        cronConsumerEnabled: host.runtimeConversation ? options.cronConsumerEnabled : false,
        startupExecutionPolicy: options.startupExecutionPolicy,
    });
}
function updateSessionForCron(host, sessionId, fields) {
    return host.runtimeConversation
        ? host.runtimeConversation.lifecycle.updateSession(sessionId, fields)
        : host.controller.updateSession(sessionId, fields);
}
async function deleteMessageStateForCron(host, sessionId) {
    await host.messageStore?.deleteSession(sessionId);
}
export function startHostCronRuntime(runtime, emitBusEvent) {
    if (!runtime.cronConsumerEnabled)
        return;
    settleInBackground(runHostCronStartup(runtime, emitBusEvent));
}
async function runHostCronStartup(runtime, emitBusEvent) {
    try {
        await runtime.ensureStarted('host_init');
    }
    catch (err) {
        emitBusEvent('cron.startup_failed', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
function buildHostCronChannelDelivery(host) {
    // Channel 在 Host 构造后才绑定；Cron 只在触发投递时解析 port。
    return buildLocalCronChannelDelivery({
        channel: {
            sendChannelText: (input) => host.requireChannelPort('cron delivery').sendChannelText(input),
            isChannelConfigured: (platform, agentName) => host.requireChannelPort('cron delivery gate').isChannelConfigured(platform, agentName),
        },
    });
}
//# sourceMappingURL=host-cron-runtime.js.map