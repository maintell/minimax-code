import { createSkillRegistry, } from '@mavis/skills';
export function inheritedRuntimeReadBetaFlags(registry) {
    const enabled = {};
    for (const entry of registry.getAvailableSkills()) {
        const requiresBeta = entry.frontmatter.requiresBeta ?? entry.frontmatter.requires_beta;
        if (typeof requiresBeta === 'string' && requiresBeta.length > 0) {
            enabled[requiresBeta] = true;
        }
    }
    return enabled;
}
export function createRegistryHandle(roots) {
    let registry;
    let watcher;
    let closed = false;
    const restartWatcher = () => {
        if (!registry || closed)
            return;
        if (watcher?.rearm) {
            watcher.rearm();
            return;
        }
        watcher?.close();
        watcher = registry.watch({ onChange: () => undefined });
    };
    return {
        registryPromise: (async () => {
            const createdRegistry = await createSkillRegistry(roots);
            registry = createdRegistry;
            restartWatcher();
            return createdRegistry;
        })(),
        restartWatcher,
        close() {
            closed = true;
            watcher?.close();
            watcher = undefined;
        },
    };
}
export function normalizeAgentName(agentName) {
    const trimmed = agentName?.trim();
    return trimmed || 'mavis';
}
//# sourceMappingURL=registry-handle.js.map