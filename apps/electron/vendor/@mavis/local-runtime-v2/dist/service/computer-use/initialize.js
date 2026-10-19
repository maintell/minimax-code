import { isComputerUseEnabled, setComputerUseEnabled, } from './state.js';
import { resolveComputerUseSelection, createComputerUsePluginRevocationHandler, } from './session-selection.js';
import { buildComputerUseRuntimeTools } from './tools.js';
/** Bind plugin publication and explicit revocation to the same Computer Use owner. */
export function createComputerUsePluginCallbacks(client, preferences) {
    const revoke = createComputerUsePluginRevocationHandler(preferences);
    const publish = computerUsePluginCapabilitiesChanged(client);
    let revoking = 0;
    return {
        onOfficialPluginRevoked: async (input) => {
            if (input.pluginName !== 'computer-use')
                return;
            revoking += 1;
            const wasEnabled = isComputerUseEnabled();
            setComputerUseEnabled(false);
            try {
                await revoke(input);
            }
            finally {
                revoking -= 1;
                if (wasEnabled)
                    client?.release?.();
            }
        },
        onCapabilitiesChanged: (capabilities) => {
            // Do not reopen admission while the revocation is still being persisted.
            if (!revoking)
                publish(capabilities);
        },
    };
}
/** Project the trusted official Plugin snapshot into the native control lifecycle. */
function computerUsePluginCapabilitiesChanged(client) {
    return (capabilities) => {
        const enabled = Boolean(client &&
            capabilities.plugins.some((plugin) => plugin.name === 'computer-use' &&
                plugin.source === 'official' &&
                plugin.hostCapabilities?.includes('computer-use')));
        const wasEnabled = isComputerUseEnabled();
        setComputerUseEnabled(enabled);
        if (wasEnabled && !enabled)
            client?.release?.();
    };
}
/** Composes the V2-owned Computer Use catalog without leaking it into V1 compatibility. */
export function initializeComputerUseProductCapabilities(input) {
    const preferences = input.preferences;
    return {
        turnRuntimeFacts: {
            // Preflight checks the trusted enabled plugin before resolving session selection.
            ...(input.client && preferences
                ? {
                    resolveComputerUseSelection: async (selection) => {
                        const scope = input.selectionScope?.();
                        if (!scope)
                            return false;
                        const selected = await resolveComputerUseSelection(preferences, selection, scope);
                        const current = input.selectionScope?.();
                        return (selected &&
                            current?.principalId === scope.principalId &&
                            current?.deployment === scope.deployment);
                    },
                }
                : {}),
            snapshot: () => ({ computerUseGloballyEnabled: isComputerUseEnabled() }),
        },
        toolSources: {
            resolve: async (toolInput) => {
                const sources = await input.baseToolSources.resolve(toolInput);
                const nativeTools = sources.nativeTools.filter((tool) => !tool.def.name.startsWith('computer_'));
                if (input.client && toolInput.computerUseActive)
                    await input.client.ensureReady?.();
                const computerTools = input.client && toolInput.computerUseActive
                    ? buildComputerUseRuntimeTools(input.client)
                    : [];
                return {
                    ...sources,
                    nativeTools: [...nativeTools, ...computerTools],
                    cuRuntimeAvailable: computerTools.length > 0,
                };
            },
        },
    };
}
/** Plugin publication owns enablement; preferences only retain per-session selection. */
export async function restoreRuntimeComputerUsePreferences(input) {
    if (!input.client) {
        setComputerUseEnabled(false);
        return {};
    }
    setComputerUseEnabled(false);
    return { computerUsePreferences: input.preferences };
}
/** Probes the isolated driver without changing the surrounding queue decision. */
export async function isComputerUseReadyForQueuedTurn(input) {
    if (!input.requested || !input.client)
        return true;
    try {
        await input.client.ensureReady?.();
        return true;
    }
    catch {
        return false;
    }
}
/** Revoke immediately, before a running turn releases the publication gate. */
export function deactivateComputerUsePlugin(client, pluginName) {
    if (pluginName !== 'computer-use')
        return;
    const wasEnabled = isComputerUseEnabled();
    setComputerUseEnabled(false);
    if (wasEnabled)
        client?.release?.();
}
//# sourceMappingURL=initialize.js.map