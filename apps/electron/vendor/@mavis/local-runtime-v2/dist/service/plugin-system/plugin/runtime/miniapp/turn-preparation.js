import { detectPluginReferencesForMessages } from '@mavis/system-reminder';
import { pluginMcpNameKey } from '@mavis/mcp';
import { MAX_RUNNING_MINIAPP_SERVICES, miniAppBusyReason } from '../../../../miniapp/index.js';
import { PluginSystemError } from '../../../errors.js';
/** Resolves only explicitly selected, enabled MiniApp managed MCP dependencies. */
export async function prepareMiniAppTurn(miniApps, input, readCurrent) {
    const requiredMcpServers = await prepareReferencedMiniApps(miniApps, input);
    if (requiredMcpServers.length === 0)
        return;
    input.signal?.throwIfAborted();
    const assertReady = () => {
        const current = readCurrent();
        for (const required of requiredMcpServers) {
            if (!miniApps.isAcceptedMiniAppRunning(required.pluginName)) {
                throw dependencyError('miniapp_unavailable');
            }
            assertManagedEndpointReady({ ...current, miniApps }, required);
        }
    };
    assertReady();
    return assertReady;
}
async function prepareReferencedMiniApps(miniApps, input) {
    const messages = input.messages.map(({ content }) => ({
        content: miniAppDependencyText(content),
    }));
    if (!messages.some(({ content }) => /(?:^|\s)@/u.test(content.normalize('NFKC'))))
        return [];
    input.signal?.throwIfAborted();
    const selected = await resolveReferencedMiniApps(miniApps, messages);
    input.signal?.throwIfAborted();
    if (selected.length > MAX_RUNNING_MINIAPP_SERVICES)
        throw dependencyError('miniapp_dependency_limit');
    if (selected.length === 0)
        return [];
    try {
        await Promise.all(selected.map(async ({ candidate }) => {
            input.signal?.throwIfAborted();
            await miniApps.ensureStarted({ pluginId: candidate.pluginId, signal: input.signal });
        }));
        input.signal?.throwIfAborted();
        return Object.freeze(selected.flatMap(({ candidate }) => candidate.mcpEndpoints.map(({ id }) => Object.freeze({ pluginName: candidate.pluginId, serverName: id }))));
    }
    catch (error) {
        input.signal?.throwIfAborted();
        throw normalizeStartupFailure(error);
    }
}
/**
 * Drop canonical evidence wrappers, including truncated tails. Match case exactly:
 * the UI only escapes canonical closing sentinels inside quoted text.
 */
function miniAppDependencyText(content) {
    return content.replace(/<(user-provided-context|mavis-chat-context|html-selection-context|deployed-website-context)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gu, ' ');
}
async function resolveReferencedMiniApps(miniApps, messages) {
    const accepted = miniApps.listAcceptedMiniApps();
    let available;
    try {
        available = await miniApps.listAvailableDefinitions();
    }
    catch {
        // Catalog availability must not turn an ordinary Plugin reference into a Node dependency.
        available = accepted;
    }
    const definitions = available.map((definition) => {
        if (!miniApps.isAcceptedMiniAppRunning(definition.candidate.pluginId))
            return definition;
        return (accepted.find(({ candidate }) => candidate.pluginId === definition.candidate.pluginId) ??
            definition);
    });
    const referenced = detectPluginReferencesForMessages(messages, '', definitions.map((definition) => ({
        ...definition,
        name: definition.candidate.pluginId,
        appTools: [],
        mcpTools: [],
        skills: [],
    })));
    return referenced.filter(({ candidate }) => candidate.mcpEndpoints.length > 0);
}
function assertManagedEndpointReady(input, required) {
    const { snapshot } = input;
    const endpoint = snapshot.mcpServers.find(({ pluginName, server }) => pluginName === required.pluginName && server.name === required.serverName);
    const failed = snapshot.diagnostics.some((diagnostic) => diagnostic.pluginName === required.pluginName &&
        diagnostic.capabilityName === required.serverName &&
        (diagnostic.code === 'MCP_SERVER_LIST_FAILED' || diagnostic.code === 'MCP_SERVER_WARMING'));
    if (!endpoint?.managedIdentity || failed) {
        throw dependencyError('miniapp_mcp_unavailable');
    }
    const tools = snapshot.turnCapabilities.runtimeToolBindings.filter((binding) => binding.kind === 'mcp' &&
        binding.pluginName === required.pluginName &&
        binding.source === required.serverName);
    const serverKey = pluginMcpNameKey(endpoint.source, required.pluginName, required.serverName);
    const inventory = input.inventory?.find(({ serverName }) => serverName === serverKey);
    // Match each remote identity once; public aliases are allocated by the MCP runtime.
    const names = new Set(inventory?.tools.map(({ name }) => name));
    const complete = inventory &&
        tools.length === inventory.tools.length &&
        tools.every(({ mcpToolName }) => mcpToolName !== undefined && names.delete(mcpToolName));
    if (!complete) {
        throw dependencyError('miniapp_mcp_unavailable');
    }
    if (!input.miniApps.isAcceptedMcpEndpointCurrent(required.pluginName, endpoint.managedIdentity)) {
        throw dependencyError('miniapp_unavailable');
    }
}
function normalizeStartupFailure(error) {
    if (miniAppBusyReason(error) === 'capacity_busy') {
        return dependencyError('miniapp_capacity_busy', error);
    }
    if (error instanceof PluginSystemError &&
        ['MINIAPP_NOT_AVAILABLE', 'MINIAPP_NOT_ACCEPTED', 'PLUGIN_NOT_ENABLED'].includes(error.code)) {
        return dependencyError('miniapp_unavailable', error);
    }
    return dependencyError('miniapp_start_failed', error);
}
function dependencyError(marker, cause) {
    return new Error(marker, cause === undefined ? undefined : { cause });
}
//# sourceMappingURL=turn-preparation.js.map