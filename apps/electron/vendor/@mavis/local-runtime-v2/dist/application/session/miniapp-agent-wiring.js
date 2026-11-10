import { ownsElectronRuntimeCapabilities } from '../agent/runtime-browser-use-composition.js';
import { settleInBackground } from '../../service/plugin-system/index.js';
import { createMiniAppAgentGateway, createMiniAppAgentSessionPorts, resolveMiniAppRoot, } from '../../service/miniapp/index.js';
import { resolvePluginServiceLogger } from './plugin-service-logger.js';
/** Created before the turn system: its permission gate consults the gateway's listeners. */
export function createRuntimeMiniAppAgent(input, logger) {
    return createMiniAppAgentGateway({ dataDir: input.options.dataDir, logger, nowMs: input.nowMs });
}
export function bindMiniAppAgentSessions(gateway, input, turnSystem, sessionApplications) {
    gateway.bind(createMiniAppAgentSessionPorts({
        records: input.sessionSystem.sessions.records,
        lifecycle: sessionApplications.sessionApplications.session.lifecycle,
        repository: input.sessionSystem.sessions.repository,
        turns: turnSystem.turns,
        queue: input.sessionSystem.queue.committed,
        stream: input.sessionSystem.stream,
        messages: input.sessionSystem.messages.repository,
        questionnaires: input.options.compatibility.peripherals.questionnaires,
        permissions: input.options.compatibility.peripherals.permissions,
        eventBus: input.options.eventBus,
        logger: resolvePluginServiceLogger(input.options.logger),
        modelConfig: input.product.preparation.configBuilder.config,
        models: { list: () => input.modelProviderApplication.list() },
        agents: sessionApplications.agentApplication,
        nowMs: input.nowMs,
    }));
}
/**
 * A main-Agent call of a Mini App's managed MCP tool holds that plugin for the calling turn (the
 * Turn system releases it when the turn settles) and counts as user attention. The hold is taken
 * synchronously, before the call runs, so it always lands before that turn's release.
 *
 * A Mini App's own work is neither: page `tool.request` calls (`miniapp:` session ids, whose
 * turn id never settles) are skipped outright; for its Agent sessions (`miniAppOrigin`) and their
 * delegated children the background root lookup drops the hold again. A failed lookup keeps the
 * hold (released at settle) and records no attention.
 */
export function createMainAgentMiniAppToolCallObserver(input) {
    return (call) => {
        if (call.sessionId.startsWith('miniapp:'))
            return;
        const hold = { sessionId: call.sessionId, turnId: call.turnId, pluginId: call.pluginName };
        input.memory.holdForToolCall(hold);
        settleInBackground(classifyToolCallSession(input, hold));
    };
}
async function classifyToolCallSession(input, hold) {
    let ownedByMiniApp;
    try {
        ownedByMiniApp = (await resolveMiniAppRoot(input, hold.sessionId)) !== undefined;
    }
    catch (error) {
        input.logger.warn({ pluginId: hold.pluginId, sessionId: hold.sessionId, error }, 'Mini App tool call session lookup failed; the turn keeps the plugin until it settles');
        return;
    }
    if (ownedByMiniApp)
        input.memory.releaseToolCallHold(hold);
    else
        input.memory.recordAttention(hold.pluginId);
}
/** Only the Electron owner runs Mini Apps, so only its app version gates `engines.mcode`. */
export function miniAppHostVersion(options) {
    const version = ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)
        ? options.compatibility.plugin.appVersion
        : undefined;
    return version ? { miniAppHostVersion: version } : {};
}
//# sourceMappingURL=miniapp-agent-wiring.js.map