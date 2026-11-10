import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pluginMcpNameKey } from '@mavis/mcp';
import { pluginIdKey } from '@mavis/shared';
import { PluginSnapshotBuilder } from './snapshot-builder.js';
export function readOfficialPluginInstallations(repository, scope) {
    if (!scope)
        return [];
    try {
        return repository.loadOfficialState(scope)?.installations ?? [];
    }
    catch {
        return [];
    }
}
/** Reads package state while retaining a last-good local package during partial writes. */
export async function readPluginSnapshotInputs(input) {
    const scanned = await input.packageStorage.scanLocalPackages();
    const localPackages = scanned.filter((entry) => !input.buildOptions.excludedLocalRoots?.has(entry.plugin.rootPath));
    const scannedRoots = new Set(localPackages.map((entry) => entry.plugin.rootPath));
    // An unlinked folder still exists, so only a registered linked root keeps its last good copy.
    const linkedRoots = input.desiredSnapshot.localPlugins.some((previous) => previous.ownership === 'linked')
        ? new Set(await input.packageStorage.listLinkedRoots())
        : new Set();
    for (const previous of input.desiredSnapshot.localPlugins) {
        if (scannedRoots.has(previous.rootPath) ||
            input.buildOptions.excludedLocalRoots?.has(previous.rootPath) ||
            (previous.ownership === 'linked' && !linkedRoots.has(previous.rootPath)) ||
            !(await isExistingLocalPluginDirectory(previous.rootPath))) {
            continue;
        }
        localPackages.push(lastGoodLocalPackage(previous));
        scannedRoots.add(previous.rootPath);
    }
    const localRoots = new Set(localPackages.map((entry) => entry.plugin.rootPath));
    if (input.pruneMissingLocalPlugins) {
        input.repository.pruneMissingLocalPlugins(localRoots);
        await pruneRemovedLocalMiniAppPermissions(input, localPackages);
    }
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
        localPackages: input.source.localPlugins.map(lastGoodLocalPackage),
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
/**
 * Manifest names whose effective Plugin stops being effective when `next`
 * replaces `current`: it was removed or disabled, or another PluginId took the
 * name over. Shadowed copies are never effective, so changing them is silent.
 * An effective Plugin keeps its PluginId across updates, including official
 * updates that move it to a new content-addressed cache root.
 */
export function deactivatedPluginNames(current, next) {
    const nextOwners = new Map(next.enabledPlugins.map((plugin) => [nameKey(plugin.name), pluginIdKey(plugin.id)]));
    return current.enabledPlugins
        .filter((plugin) => nextOwners.get(nameKey(plugin.name)) !== pluginIdKey(plugin.id))
        .map((plugin) => plugin.name);
}
function nameKey(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
/** Rebuilds from the authored package so each build re-applies the engines gate. */
function lastGoodLocalPackage(projection) {
    return {
        plugin: projection.authoredPlugin ?? projection.plugin,
        contentDigest: projection.contentDigest,
        id: projection.id,
        ownership: projection.ownership,
        ...(projection.unavailableReason ? { unavailableReason: projection.unavailableReason } : {}),
    };
}
/**
 * Clears local switches only once the plugin directory is gone. A package that exists but no
 * longer reads (a manifest the Agent broke, a field this Host does not know) keeps them, so
 * fixing it does not silently re-enable what the user switched off.
 */
async function pruneRemovedLocalMiniAppPermissions(input, localPackages) {
    const scannedNames = new Set(localPackages.map(({ plugin }) => plugin.name));
    for (const pluginId of input.repository.listLocalMiniAppPermissionOwners()) {
        if (scannedNames.has(pluginId))
            continue;
        const root = input.packageStorage.localPluginRoot(pluginId);
        if (path.basename(root) === pluginId && (await isExistingLocalPluginDirectory(root)))
            continue;
        input.repository.deleteMiniAppPermissions(pluginId, 'local');
    }
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