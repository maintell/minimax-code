import { miniAppPermissionId, } from '@mavis/shared/miniapp-surface';
import { listEnabledMiniAppDefinitions } from './candidate.js';
/** Switchable permissions the manifest declares, in manifest order. */
function declaredMiniAppPermissions(miniapp) {
    return [
        ...(miniapp.hostConnectorAccess?.providers ?? []).map((provider) => miniAppPermissionId('connector', provider)),
        ...(miniapp.agentAccess ?? []).map((item) => miniAppPermissionId('agent', item)),
        ...(miniapp.toolAccess?.includes('call') ? [miniAppPermissionId('tool', 'call')] : []),
        ...(miniapp.deviceAccess ?? []).map((item) => miniAppPermissionId('device', item)),
    ];
}
/** Declared items of an enabled Mini App, or undefined when the snapshot has no such Mini App. */
export function findMiniAppPermissionTarget(snapshot, pluginId) {
    const definition = listEnabledMiniAppDefinitions(snapshot).find(({ candidate }) => candidate.pluginId === pluginId);
    if (!definition)
        return undefined;
    const plugin = definition.source === 'official'
        ? snapshot.officialPackages.find(({ name }) => name === pluginId)?.plugin
        : snapshot.localPlugins.find(({ name }) => name === pluginId)?.plugin;
    if (!plugin?.miniapp)
        return undefined;
    return { source: definition.source, declared: declaredMiniAppPermissions(plugin.miniapp) };
}
export function miniAppPermissionList(input) {
    return {
        pluginId: input.pluginId,
        source: input.source,
        items: input.declared.map((id) => ({ id, enabled: !input.disabled.has(id) })),
    };
}
const ALL_SOURCES = ['official', 'local'];
/**
 * The stored switches as the Mini App gateways read them. Switches are kept per package source,
 * so each read resolves the source of the Mini App the Host serves under that id; an id it does
 * not serve counts as off when either source has the switch off.
 */
export class PluginMiniAppPermissionSwitches {
    options;
    listeners = new Set();
    sources = new WeakMap();
    constructor(options) {
        this.options = options;
    }
    isEnabled(pluginId, permission) {
        const source = this.sourceOf(pluginId);
        return (source ? [source] : ALL_SOURCES).every((candidate) => !this.options.store.listDisabledMiniAppPermissions(pluginId, candidate).has(permission));
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /** Tells every gateway about a change already stored. */
    publish(change) {
        for (const listener of this.listeners) {
            try {
                listener(change);
            }
            catch {
                // The switch is stored and new calls already read it; a listener reports its own failure.
            }
        }
    }
    sourceOf(pluginId) {
        for (const snapshot of this.options.snapshots()) {
            const source = this.sourcesIn(snapshot).get(pluginId);
            if (source)
                return source;
        }
        return undefined;
    }
    /** The source of each enabled Mini App id, as `findMiniAppPermissionTarget` picks it. */
    sourcesIn(snapshot) {
        const cached = this.sources.get(snapshot);
        if (cached)
            return cached;
        const sources = new Map();
        for (const { candidate, source } of listEnabledMiniAppDefinitions(snapshot)) {
            if (!sources.has(candidate.pluginId))
                sources.set(candidate.pluginId, source);
        }
        this.sources.set(snapshot, sources);
        return sources;
    }
}
//# sourceMappingURL=permissions.js.map