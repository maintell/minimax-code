import { createMcpRuntimeLogger } from './logging.js';
import { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import { LocalMcpService } from './runtime/local-mcp.service.js';
import { resolveMatrixMcpStdioEntrypoint } from './runtime/builtin-matrix.js';
import { LocalMcpPublicFacade } from './tools/public-facade.js';
export function initializeMcpService(options) {
    let runtime;
    const metrics = options.metrics;
    const logger = createMcpRuntimeLogger(options.diagnostics, options.logger);
    const pool = options.enableLiveMcp
        ? new McpConnectionPool({
            getResolvedServer: (name) => runtime.getServerLookup().getResolvedServer(name),
        }, {
            ...(logger ? { logger } : {}),
            ...(metrics
                ? {
                    metrics: {
                        incr: (name, tags) => metrics.counter(name, 1, tags),
                        latency: (name, value, tags) => metrics.histogram(name, value, tags),
                    },
                }
                : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        })
        : undefined;
    runtime = new LocalMcpService(() => options.dataDir, {
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        ...(pool ? { connectionPool: pool } : {}),
        builtinMatrix: {
            enabled: options.builtinMatrix && Boolean(resolveMatrixMcpStdioEntrypoint()),
            webSearchOnly: options.matrixWebSearchOnly,
        },
    });
    const service = {
        list: (keyword) => runtime.listConfiguredServers(keyword),
        get: (name) => runtime.getConfiguredServer(name),
        create: (name, config, enabled) => runtime.createConfiguredServer(name, mutableConfig(config), enabled),
        update: (name, config) => runtime.updateConfiguredServer(name, mutableConfig(config)),
        delete: (name) => runtime.deleteConfiguredServer(name),
        setEnabled: (name, enabled) => runtime.setConfiguredServerEnabled(name, enabled),
        test: (name) => runtime.testConfiguredServer(name),
    };
    const capability = runtime;
    const unbind = options.bindRuntime?.(capability);
    let closePromise;
    return {
        service,
        runtime,
        public: new LocalMcpPublicFacade(runtime),
        capability,
        // Reservations are built from the local configuration. Remote discovery remains lazy and bounded.
        ready: async () => {
            await runtime.listServers();
        },
        close: () => {
            closePromise ??= (async () => {
                unbind?.();
                await runtime.close();
            })();
            return closePromise;
        },
    };
}
function mutableConfig(config) {
    const common = {
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.description === undefined ? {} : { description: config.description }),
    };
    return config.transport === 'stdio'
        ? {
            transport: config.transport,
            command: config.command,
            ...(config.args === undefined ? {} : { args: [...config.args] }),
            ...(config.env === undefined ? {} : { env: { ...config.env } }),
            ...common,
        }
        : {
            transport: config.transport,
            url: config.url,
            ...(config.headers === undefined ? {} : { headers: { ...config.headers } }),
            ...common,
        };
}
//# sourceMappingURL=initialize.js.map