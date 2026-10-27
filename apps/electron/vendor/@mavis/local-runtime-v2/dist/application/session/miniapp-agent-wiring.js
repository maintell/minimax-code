import { ownsElectronRuntimeCapabilities } from '../agent/runtime-browser-use-composition.js';
import { createMiniAppAgentGateway, createMiniAppAgentSessionPorts, } from '../../service/miniapp/index.js';
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
/** Only the Electron owner runs Mini Apps, so only its app version gates `engines.mcode`. */
export function miniAppHostVersion(options) {
    const version = ownsElectronRuntimeCapabilities(options.runtimeOwnerKind)
        ? options.compatibility.plugin.appVersion
        : undefined;
    return version ? { miniAppHostVersion: version } : {};
}
//# sourceMappingURL=miniapp-agent-wiring.js.map