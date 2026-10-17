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
    snapshot(snapshot) {
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
        for (const [component, count] of Object.entries(counts)) {
            this.client?.gauge('plugin_snapshot_component_count', count, { component });
        }
    }
}
//# sourceMappingURL=metrics.js.map