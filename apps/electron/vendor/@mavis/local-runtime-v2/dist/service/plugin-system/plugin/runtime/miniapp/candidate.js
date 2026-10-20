import { MINIAPP_AGENT_DEFAULT_CONCURRENCY } from '../../../../miniapp/index.js';
import { PluginSystemError } from '../../../errors.js';
export function sameMiniAppCandidate(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
/** A published definition is running only while the exact process generation remains current. */
export function sameRunningGeneration(current, accepted) {
    return Boolean(current?.processGeneration &&
        accepted.processGeneration &&
        current.pluginId === accepted.pluginId &&
        current.miniAppGeneration === accepted.miniAppGeneration &&
        current.processGeneration === accepted.processGeneration);
}
/** Enabled and valid authored definitions, independent from Host runtime acceptance. */
export function listEnabledMiniAppDefinitions(snapshot) {
    const packages = [
        ...snapshot.officialPackages.flatMap(({ plugin }) => (plugin?.miniapp ? [plugin] : [])),
        ...snapshot.localPlugins
            .filter((projection) => projection.enabled && projection.plugin.miniapp !== undefined)
            .map(({ plugin }) => plugin),
    ];
    return packages
        .map((plugin) => ({
        source: plugin.source === 'OFFICIAL' ? 'official' : 'local',
        ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
        ...(plugin.description ? { description: plugin.description } : {}),
        ...(plugin.iconPath ? { iconPath: plugin.iconPath } : {}),
        candidate: miniAppCandidateFromPackage({ plugin }),
    }))
        .sort((left, right) => left.candidate.pluginId.localeCompare(right.candidate.pluginId));
}
/** Runtime-only projection after a publication snapshot has been admission-filtered. */
export function listAcceptedMiniApps(snapshot) {
    return listEnabledMiniAppDefinitions(snapshot);
}
export function miniAppCandidateFromPackage(packageEntry) {
    const miniapp = packageEntry.plugin.miniapp;
    if (!miniapp)
        throw candidateError('MINIAPP_CONTRIBUTION_MISSING');
    return {
        pluginId: packageEntry.plugin.name,
        packageRoot: packageEntry.plugin.rootPath,
        // Runtime identity follows the authored MiniApp payload. Ordinary Skill,
        // App, and non-managed MCP changes must not force a service replacement.
        packageDigest: miniapp.contentDigest,
        clientDigest: miniapp.clientDigest,
        surfacePath: miniapp.surface.path,
        ...(miniapp.surface.window ? { surfaceWindow: miniapp.surface.window } : {}),
        lifecycle: miniapp.runtime.lifecycle,
        nodeDigest: miniapp.nodeDigest,
        nodeEntry: miniapp.runtime.entry,
        mcpEndpoints: miniapp.mcpEndpoints.map(({ server, path }) => ({ id: server, path })),
        hostConnectorPolicy: miniapp.hostConnectorAccess?.providers.length
            ? { kind: 'allowlist', providers: [...miniapp.hostConnectorAccess.providers] }
            : { kind: 'deny-all' },
        agentPolicy: miniapp.agentAccess?.length
            ? {
                kind: 'allowlist',
                capabilities: [...miniapp.agentAccess],
                maxConcurrent: miniapp.agentConcurrency ?? MINIAPP_AGENT_DEFAULT_CONCURRENCY,
            }
            : { kind: 'deny-all' },
    };
}
function candidateError(code) {
    return new PluginSystemError(code, 'Mini App publication preparation failed');
}
//# sourceMappingURL=candidate.js.map