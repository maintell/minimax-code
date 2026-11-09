import { createMcpRuntimeLogger } from './logging.js';
import { McpConnectionPool } from '@mavis/mcp/runtime/connection-pool';
import { LocalMcpService } from './runtime/local-mcp.service.js';
import { resolveMatrixMcpStdioEntrypoint } from './runtime/builtin-matrix.js';
import { LocalMcpPublicFacade } from './tools/public-facade.js';
import { McpAuthService } from './auth/mcp-auth.service.js';
import { publicAuthTarget } from './auth/bindings.js';
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
        ...authOptions(options, logger),
        builtinMatrix: {
            enabled: options.builtinMatrix && Boolean(resolveMatrixMcpStdioEntrypoint()),
            webSearchOnly: options.matrixWebSearchOnly,
        },
    });
    const service = {
        list: (keyword) => runtime.listConfiguredServers(keyword),
        // Details report whether a confidential client secret is stored, never the secret.
        get: async (name) => {
            const detail = await runtime.getConfiguredServer(name);
            return detail && runtime.serverAuth.withClientSecretState(detail);
        },
        create: async (name, config, enabled) => runtime.serverAuth.withClientSecretState(await runtime.createConfiguredServer(name, mutableConfig(config), enabled)),
        update: async (name, config) => runtime.serverAuth.withClientSecretState(await runtime.updateConfiguredServer(name, mutableConfig(config))),
        delete: (name) => runtime.deleteConfiguredServer(name),
        setEnabled: (name, enabled) => runtime.setConfiguredServerEnabled(name, enabled),
        test: (name) => runtime.testConfiguredServer(name),
    };
    const { oauth, publishGlobalEvent: publish } = options;
    const auth = createAuthService(options, runtime, logger);
    const capability = runtime;
    const unbind = options.bindRuntime?.(capability);
    let closePromise;
    return {
        service,
        runtime,
        public: new LocalMcpPublicFacade(runtime),
        capability,
        ...(auth && oauth ? { auth, oauth } : {}),
        announcePluginAuthRequired: ({ target, reason }) => publish?.({
            type: 'mcp.auth_required',
            payload: { target: publicAuthTarget(target), reason },
        }),
        bindPluginAuthPort: (port) => auth?.bindPluginPort(port) ?? (() => undefined),
        // Reservations are built from the local configuration. Remote discovery remains lazy and bounded.
        ready: async () => {
            await runtime.listServers();
        },
        close: () => {
            closePromise ??= (async () => {
                unbind?.();
                await auth?.close();
                await runtime.close();
                await oauth?.close();
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
            ...(config.oauth === undefined
                ? {}
                : {
                    oauth: {
                        ...config.oauth,
                        ...(config.oauth.scopes ? { scopes: [...config.oauth.scopes] } : {}),
                    },
                }),
            ...common,
        };
}
function authOptions(options, logger) {
    return {
        ...(options.oauth ? { oauth: options.oauth } : {}),
        ...(options.publishGlobalEvent ? { publishGlobalEvent: options.publishGlobalEvent } : {}),
        ...(logger ? { logger } : {}),
    };
}
function createAuthService(options, runtime, logger) {
    const { oauth, publishGlobalEvent: publish } = options;
    if (!oauth)
        return undefined;
    return new McpAuthService({
        oauth,
        runtime: runtime.serverAuth,
        ...(publish ? { publish } : {}),
        ...(logger ? { logger } : {}),
    });
}
//# sourceMappingURL=initialize.js.map