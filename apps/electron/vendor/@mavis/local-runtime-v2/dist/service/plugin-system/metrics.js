import { observeMetric } from '../../infra/logging/metrics.js';
/** Bounded, privacy-safe metrics emitted by the Desktop Plugin System. */
export class PluginSystemMetrics {
    client;
    publicationQueuedAt = new WeakMap();
    constructor(client) {
        this.client = client;
    }
    officialSync(trigger, status, startedAt) {
        const tags = { trigger, status };
        this.client?.incr('plugin_official_sync_total', tags);
        this.client?.latency('plugin_official_sync_duration_ms', Date.now() - startedAt, tags);
    }
    operation(operation, status, startedAt) {
        const tags = { operation, status };
        this.client?.incr('plugin_operation_total', tags);
        this.client?.latency('plugin_operation_duration_ms', Date.now() - startedAt, tags);
    }
    localScan(status, startedAt, packageCount, diagnosticCount) {
        const tags = { status };
        this.client?.incr('plugin_local_scan_total', tags);
        this.client?.latency('plugin_local_scan_duration_ms', Date.now() - startedAt, tags);
        if (packageCount !== undefined) {
            this.client?.latency('plugin_local_scan_package_count', packageCount, tags);
        }
        if (diagnosticCount !== undefined) {
            this.client?.latency('plugin_local_scan_diagnostic_count', diagnosticCount, tags);
        }
    }
    publicationQueued(publication) {
        this.publicationQueuedAt.set(publication, Date.now());
    }
    publication(publication, status) {
        const queuedAt = this.publicationQueuedAt.get(publication);
        if (queuedAt === undefined)
            return;
        this.publicationQueuedAt.delete(publication);
        this.client?.incr('plugin_publication_total', { status });
        this.client?.latency('plugin_publication_wait_duration_ms', Date.now() - queuedAt, { status });
    }
    /** One observation per component of every published snapshot. */
    snapshot(snapshot) {
        const client = this.client;
        if (!client)
            return;
        const appProviders = new Set(snapshot.enabledPlugins.flatMap((plugin) => plugin.appProviders));
        const counts = {
            official_plugin: snapshot.officialPackages.length,
            local_plugin: snapshot.localPlugins.length,
            enabled_plugin: snapshot.enabledPlugins.length,
            app_provider: appProviders.size,
            skill: snapshot.skills.length,
            mcp_server: snapshot.mcpServers.length,
            mcp_tool: snapshot.turnCapabilities.runtimeToolBindings.filter((binding) => binding.kind === 'mcp').length,
            diagnostic: snapshot.diagnostics.length,
        };
        // The port's latency() is the client's histogram().
        const sink = { histogram: client.latency.bind(client) };
        for (const component of Object.keys(counts)) {
            observeMetric(sink, 'plugin_snapshot_component_items', counts[component], { component });
        }
    }
}
//# sourceMappingURL=metrics.js.map