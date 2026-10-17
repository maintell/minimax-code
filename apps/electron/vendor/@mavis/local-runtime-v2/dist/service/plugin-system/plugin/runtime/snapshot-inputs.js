import { lstat } from 'node:fs/promises';
import { pluginMcpNameKey } from '@mavis/mcp';
import { PluginSnapshotBuilder } from './snapshot-builder.js';
/** Reads package state while retaining a last-good local package during partial writes. */
export async function readPluginSnapshotInputs(input) {
    const scanned = await input.packageStorage.scanLocalPackages();
    const localPackages = scanned.filter((entry) => !input.buildOptions.excludedLocalRoots?.has(entry.plugin.rootPath));
    const scannedRoots = new Set(localPackages.map((entry) => entry.plugin.rootPath));
    for (const previous of input.desiredSnapshot.localPlugins) {
        if (scannedRoots.has(previous.rootPath) ||
            input.buildOptions.excludedLocalRoots?.has(previous.rootPath) ||
            !(await isExistingLocalPluginDirectory(previous.rootPath))) {
            continue;
        }
        localPackages.push({ plugin: previous.plugin, contentDigest: previous.contentDigest });
        scannedRoots.add(previous.rootPath);
    }
    const localRoots = new Set(localPackages.map((entry) => entry.plugin.rootPath));
    if (input.pruneMissingLocalPlugins)
        input.repository.pruneMissingLocalPlugins(localRoots);
    const [officialPackages, reservations] = await Promise.all([
        input.buildOptions.officialState
            ? input.packageStorage.restoreOfficialPackagesFromState(input.buildOptions.officialState)
            : input.packageStorage.restoreOfficialPackages(input.scope),
        input.listReservations(),
    ]);
    return { officialPackages, localPackages, reservations };
}
export function buildPluginSnapshotFromInputs(input) {
    return input.builder.build({
        revision: 'plugin-snapshot-candidate',
        officialPackages: input.snapshotInputs.officialPackages,
        localPackages: input.snapshotInputs.localPackages.filter((entry) => !input.buildOptions.excludedLocalRoots?.has(entry.plugin.rootPath)),
        isLocalEnabled: (root) => input.buildOptions.localEnabledOverrides?.get(root) ?? input.isLocalEnabled(root),
        reservations: input.snapshotInputs.reservations,
    });
}
export function buildPluginMarketplaceSnapshot(input) {
    return input.builder.build({
        revision: input.revision,
        officialPackages: input.snapshotInputs.officialPackages,
        localPackages: input.snapshotInputs.localPackages,
        isLocalEnabled: input.isLocalEnabled,
        reservations: input.snapshotInputs.reservations,
    });
}
export function buildCustomOnlySnapshot(input) {
    const inputs = {
        officialPackages: [],
        localPackages: input.source.localPlugins.map((entry) => ({
            plugin: entry.plugin,
            contentDigest: entry.contentDigest,
        })),
        reservations: input.reservations,
    };
    const snapshot = input.builder.build({
        revision: input.revision,
        officialPackages: inputs.officialPackages,
        localPackages: inputs.localPackages,
        isLocalEnabled: input.isLocalEnabled,
        reservations: inputs.reservations,
    });
    return { snapshot, inputs };
}
export function localSnapshotInventory(snapshot, inventory) {
    if (!inventory)
        return undefined;
    const serverNames = new Set(snapshot.mcpServers.map((entry) => pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name)));
    return inventory.filter((entry) => serverNames.has(entry.serverName));
}
export function removedPluginHookNames(current, next) {
    const nextNames = new Set((next.turnCapabilities.hooks ?? []).map((handler) => handler.pluginName));
    return [
        ...new Set((current.turnCapabilities.hooks ?? [])
            .map((handler) => handler.pluginName)
            .filter((pluginName) => !nextNames.has(pluginName))),
    ];
}
async function isExistingLocalPluginDirectory(rootPath) {
    try {
        const stat = await lstat(rootPath);
        return stat.isDirectory() && !stat.isSymbolicLink();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=snapshot-inputs.js.map