import { createMiniAppLocalMcpTools } from '../../service/mcp/index.js';
import { resolveSeededBuiltinSkillsDir, } from '../../service/skill/index.js';
import { createExtensionMcpTargets, initializePluginExtension, } from '../../service/plugin-extension/index.js';
import { settleInBackground, } from '../../service/plugin-system/index.js';
import { createPluginExtensionAgentSpawn } from './plugin-extension-agent-spawn.js';
import { createPluginExtensionSessionFacts } from './plugin-extension-session-facts.js';
import { createPluginExtensionSessionUsage, } from './plugin-extension-session-usage.js';
export function composeRuntimePluginExtension(input, plugin, mcpRuntime) {
    return composePluginExtension({
        ...input,
        modelConfig: { read: input.product.preparation.configBuilder.config },
        sessionModel: (sessionId) => input.modelProviderApplication.sessionModel(sessionId),
    }, plugin, mcpRuntime);
}
/**
 * Extension previews and install over the Plugin MCP pool, the user-configured MCP
 * runtime and the Agent's permission rules; deleted sessions arrive on the global event bus.
 * `turnObserver` joins the turn system's best-effort observers: committed frames reach the
 * observe events after the turn published them, detached from the turn. The turn's in-process
 * content handle rides along; the projector reads it only for an event a hook listens to.
 */
export function composePluginExtension(input, plugin, mcpRuntime) {
    const { options } = input;
    const agents = createPluginExtensionAgentSpawn({
        taskHost: options.compatibility.extensionTaskHost,
        sessions: input.sessionSystem.sessions.repository,
        questionnaires: options.compatibility.peripherals.questionnaires,
        permissions: options.compatibility.peripherals.permissions,
        pluginAgents: (sessionId) => plugin.sessionPluginAgents(sessionId),
        config: input.modelConfig.read,
    });
    const service = initializePluginExtension({
        agentSpawn: agents.port,
        spawnedAnswer: agents.spawnedAnswer,
        modelResolver: input.preparation,
        dataDir: options.dataDir,
        builtinSkillsDir: resolveSeededBuiltinSkillsDir(options.compatibility.skillRuntime.configGetter()),
        db: options.db,
        names: {
            assertPreviewNameAvailable: (pluginId) => plugin.assertPreviewNameAvailable(pluginId),
            effectivePluginTier: (pluginId) => plugin.effectivePluginTier(pluginId),
        },
        mcpTargets: createExtensionMcpTargets({
            plugin: plugin.pluginMcpCalls,
            configured: createMiniAppLocalMcpTools(mcpRuntime),
        }),
        permission: options.compatibility.extensionPermission,
        sessionExists: async (sessionId) => (await input.sessionSystem.sessions.repository.get(sessionId)) != null,
        sessionParent: async (sessionId) => (await input.sessionSystem.sessions.repository.get(sessionId))?.parentSessionId,
        sessionFacts: createPluginExtensionSessionFacts({
            repository: input.sessionSystem.sessions.repository,
            sessionModel: input.sessionModel,
        }),
        sessionUsage: createPluginExtensionSessionUsage({
            sessions: input.sessionSystem.sessions.repository,
            messages: input.sessionSystem.messages.repository,
            sessionModel: input.sessionModel,
            resolver: input.preparation,
            modelConfig: input.modelConfig,
        }),
        sessionOverlay: plugin.sessionPreviews,
        installed: plugin.installedExtensions,
    });
    const unsubscribe = options.eventBus.subscribe({
        next: (event) => {
            if (event.type === 'session.deleted') {
                settleInBackground(service.onSessionDeleted(event.payload.sessionId));
            }
            else if (event.type === 'session.finish' ||
                event.type === 'session.error' ||
                event.type === 'session.abort') {
                // The turn has ended; a reload never swaps a preview under a running turn.
                settleInBackground(service.onTurnEnded(event.payload.sessionId));
            }
        },
    });
    return {
        ...service,
        turnObserver: {
            observesTurnContent: (sessionId) => service.observesTurnContent(sessionId),
            observeRuntimeEvent: ({ context, event, content }) => service.observeTurnFrame({
                sessionId: context.sessionId,
                turnId: context.turnId,
                event,
                ...(content ? { content } : {}),
            }),
        },
        close: async () => {
            unsubscribe();
            await service.close();
        },
    };
}
//# sourceMappingURL=plugin-extension-composition.js.map