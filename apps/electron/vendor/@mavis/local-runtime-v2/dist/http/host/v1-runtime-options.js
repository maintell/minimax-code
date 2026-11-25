// Option builders for the v1 service compatibility that `createV1RuntimeCompatibility` hands the
// HTTP host; split out so the composition file stays within its size budget.
export function createV1PluginOptions(host, options, api) {
    return {
        dataDir: host.dataDir,
        configGetter: api.configGetter,
        authContextGetter: options.authContextGetter ?? (() => undefined),
        routingContextGetter: () => options.routingContextGetter?.(),
        fetchImpl: options.fetchImpl ?? globalThis.fetch,
        ...(options.appVersion ? { appVersion: options.appVersion } : {}),
        metrics: host.metricsClient,
    };
}
export function createV1McpOptions(host, options, bindRuntime) {
    return {
        enableLiveMcp: options.enableLiveMcp === true,
        builtinMatrix: false,
        matrixWebSearchOnly: false,
        bindRuntime,
        diagnostics: host.observability,
        ...(options.mcpLogger ? { logger: options.mcpLogger } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
}
export function createV1SkillRuntimeOptions(host, options, bindRuntime) {
    const api = host.apiHost;
    return {
        management: {
            runtimeOwnerKind: options.runtimeOwnerKind,
            electronHost: options.capabilities?.electronHost === true,
            resolveAgentWriteTarget: (name) => api.agentRuntimePort.resolveAgentWriteTarget(name),
            hub: {
                nowMs: options.nowMs,
                fetch: options.fetchImpl,
                authContextGetter: options.authContextGetter,
                routingContextGetter: options.routingContextGetter,
            },
        },
        configGetter: api.configGetter,
        registryDiagnostics: options.skillRegistryDiagnostics,
        resolveAgentReadScope: (name) => api.agentRuntimePort.resolveAgentReadScope(name),
        resourceAmbiguityTelemetry: {
            emitBusEvent: (type, payload) => api.emitBusEvent(type, payload),
            metrics: host.apiHost.metrics,
        },
        bindRuntime,
    };
}
//# sourceMappingURL=v1-runtime-options.js.map