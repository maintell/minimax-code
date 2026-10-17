import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { channelContextFromMessageContext } from '../interaction/channel-context.js';
import { json } from '../delivery/legacy-http/http-helpers.js';
/** Builds the injected port; one facade per subsystem, assembled exactly once. */
export function buildHostChannelFacadePort(input) {
    const { subsystem, wire } = input;
    const infra = subsystem.channelBridgeInfra;
    const runner = subsystem.channelRunner;
    logger.info({ agentName: wire.agentName, owner: 'local-runtime-v2' }, 'Host channel facade port assembled over the v2 subsystem');
    return {
        listBindingSessionIds: async () => [
            ...new Set((await infra.bindingStore.list()).map((binding) => binding.sessionId)),
        ],
        deleteBindingsBySession: (sessionId) => infra.bindingStore.deleteBySession(sessionId),
        permissionOutbound: subsystem.channelPermissionBridge,
        forgetPermissionSession: (sessionId) => subsystem.channelPermissionBridge.forgetSession(sessionId),
        // v2 adaptation: the runner's delivery API takes an input object.
        deliverReplyFromMessages: ({ ctx, messages, sessionId, workspaceDir, error }) => runner.deliverReplyFromMessages({
            ctx: channelContextFromMessageContext(ctx),
            messages,
            sessionId,
            ...(workspaceDir !== undefined ? { workspaceDir } : {}),
            ...(error !== undefined ? { error } : {}),
        }),
        notifyTurnStart: (ctx) => runner.notifyTurnStart(channelContextFromMessageContext(ctx)),
        notifyTurnEnd: (ctx) => runner.notifyTurnEnd(channelContextFromMessageContext(ctx)),
        sendQuestionnaireMessage: async ({ ctx, text, questionnaire, sessionId }) => {
            const converted = channelContextFromMessageContext(ctx);
            const client = runner.clients.get(converted);
            if (!client?.sendMessage)
                return 'unavailable';
            await client.sendMessage({ ctx: converted, text, questionnaire, sessionId });
            return 'sent';
        },
        sendChannelText: async ({ ctx, text, sessionId }) => {
            await runner.clients.get(ctx).sendText({
                ctx,
                text,
                ...(sessionId ? { sessionId } : {}),
            });
        },
        isChannelConfigured: async (platform, agentName) => {
            const api = platformApiForConfigCheck(subsystem, platform);
            return (await api.configCheck(agentName)).configured === true;
        },
        routeAgentIm: async (agentName, method) => {
            // v2 adaptation: the copy returns the structured result; the facade
            // maps it back to the exact legacy Response at this HTTP edge.
            const result = await infra.routeAgentIm(agentName, method);
            return json(result.body, { status: result.status });
        },
        buildAgentChannelConfig: (agentName) => infra.buildAgentChannelConfig(agentName),
        startChannelSubsystem: () => subsystem.startChannelSubsystem(),
        shutdownChannelSubsystem: async () => {
            // Mirrors the v1 shutdown helper: sweep every adapter, isolate failures.
            for (const adapter of infra.adapterRegistry.list()) {
                if (!adapter.shutdown)
                    continue;
                try {
                    await adapter.shutdown();
                }
                catch (err) {
                    logger.warn({
                        err,
                        platform: adapter.platform,
                        clientName: adapter.clientName,
                        stage: 'channel_shutdown',
                    }, 'Channel adapter shutdown failed (continuing sweep)');
                }
            }
        },
    };
}
/** Cron config gate resolves the same per-platform legacy Api instances. */
function platformApiForConfigCheck(subsystem, platform) {
    if (platform === 'telegram')
        return subsystem.telegramChannelApi;
    if (platform === 'wechat')
        return subsystem.wechatChannelApi;
    return subsystem.feishuChannelApi;
}
//# sourceMappingURL=host-facade.js.map