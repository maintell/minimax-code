import { getRuntimeRegion, getRuntimeBuildEnv } from '@mavis/config';
import { createAgentSessionPorts } from '../agent/agent-application.js';
import { createRuntimeSessionComposition, createRuntimeAgentReferenceProjection, } from './runtime-services-composition.js';
import { GlobalInstructions } from '../../service/turn-system/index.js';
import { channelModelInvalidReceiptText } from '../../service/channel-system/index.js';
import { initializeComputerUseProductCapabilities } from '../../service/computer-use/index.js';
import { resolveRuntimeMiniAppOptions } from '../../service/miniapp/index.js';
import { resolvePluginServiceLogger } from './plugin-service-logger.js';
import { LocalPromptSnapshotSource } from '../../service/agent/index.js';
import { initializeRuntimePromptSupport, } from '../../service/prompt-config/index.js';
/** Keeps Prompt-specific wiring outside the shared service composition flow. */
export async function initializeRuntimeServicePromptSupport(input) {
    const local = await input.agentService.frozenPromptSource?.();
    const support = await initializeRuntimePromptSupport({
        // Hotfix: keep package prompts paired with this client, including when an
        // existing profile explicitly enables auto-update. Do not bind old disk caches.
        enabled: false,
        dataDir: input.dataDir,
        ...(input.promptConfigKey ? { promptConfigKey: input.promptConfigKey } : {}),
        plugin: input.plugin,
        agentService: input.agentService,
        snapshotFactory: {
            create: (options) => new LocalPromptSnapshotSource(options),
        },
        ...(input.promptFileReader ? { promptFileReader: input.promptFileReader } : {}),
    });
    return local ? { ...support, promptSnapshots: local } : support;
}
export async function createRuntimePromptSessionSupport(input) {
    const { options, safety, nowMs, writeGlobalEvent, inspector, browserUse } = input;
    const globalInstructions = new GlobalInstructions(options.dataDir);
    const promptSupport = await initializeRuntimeServicePromptSupport({
        ...options,
        promptConfig: options.compatibility.promptConfig,
        plugin: options.compatibility.plugin,
    });
    const { promptSnapshots, internalTurnPromptReads } = promptSupport;
    const agentSessionPorts = createAgentSessionPorts(options.agentService);
    const serviceLogger = resolvePluginServiceLogger(options.logger);
    const productionSessionComposition = createRuntimeSessionComposition({
        // IM MR2/MR3: the pre-queue channel model rejection text is owned by the
        // v2 channel system copy; products no longer inject a v1 formatter.
        options: { ...options, formatChannelModelInvalid: channelModelInvalidReceiptText },
        dependencies: {
            baseProduct: {
                ...options.compatibility.agentHost,
                ...initializeComputerUseProductCapabilities({
                    baseToolSources: options.compatibility.agentHost.toolSources,
                    preferences: options.computerUsePreferences,
                    selectionScope: () => {
                        const principalId = options.compatibility.plugin
                            .authContextGetter()
                            ?.realUserID?.trim();
                        return principalId
                            ? { principalId, deployment: `${getRuntimeRegion()}-${getRuntimeBuildEnv()}` }
                            : undefined;
                    },
                    client: options.computerUseClient,
                    readSessionTitle: async (sessionId) => (await productionSessionComposition.sessionSystem.sessions.repository.get(sessionId))
                        ?.title,
                    logger: options.logger,
                }),
            },
            safety,
            logger: serviceLogger,
            nowMs,
            publishGlobalEvent: writeGlobalEvent,
            agentSessionPorts,
            agentReferenceProjection: createRuntimeAgentReferenceProjection(options.compatibility, options.agentService, serviceLogger),
            inspector,
            internalTurnPromptReads,
            miniappAvailable: resolveRuntimeMiniAppOptions(options) !== undefined,
            browserUse,
            promptSnapshots,
            globalInstructions,
        },
    });
    return { globalInstructions, promptSupport, productionSessionComposition, agentSessionPorts };
}
//# sourceMappingURL=runtime-prompt-support.js.map