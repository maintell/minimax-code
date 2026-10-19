import { sessionMcpConnectionKey, requireSessionId } from './settings-config.js';
import { configToTransportConfig, normalizeServerName } from './config.js';
/** ACP-owned ephemeral configurations, independent of repository MCP configuration. */
export class SessionMcpServers {
    pool;
    servers = new Map();
    constructor(pool) {
        this.pool = pool;
    }
    get(sessionId) {
        return this.servers.get(sessionId);
    }
    clear() {
        this.servers.clear();
    }
    async configure(sessionId, servers) {
        const id = requireSessionId(sessionId);
        const next = Object.create(null);
        for (const server of servers) {
            const name = normalizeServerName(server.name);
            if (Object.hasOwn(next, name))
                throw new Error(`Duplicate session MCP server name: ${name}`);
            const config = { ...server.config, enabled: true, configured: true, builtin: false };
            if (!configToTransportConfig(config))
                throw new Error(`Session MCP server "${name}" has no usable transport.`);
            next[name] = config;
        }
        await this.remove(id);
        if (Object.keys(next).length > 0)
            this.servers.set(id, Object.freeze(next));
    }
    async remove(sessionId) {
        const id = requireSessionId(sessionId);
        const current = this.servers.get(id);
        this.servers.delete(id);
        const pool = this.pool;
        if (!current || !pool)
            return;
        await Promise.allSettled(Object.keys(current).map((server) => pool.disconnect(server, { connectionKey: sessionMcpConnectionKey(id, server) })));
    }
    overrides(sessionId, server, config) {
        const transport = configToTransportConfig(config);
        if (!transport)
            return undefined;
        return {
            connectionKey: sessionMcpConnectionKey(sessionId, server),
            serverOverride: {
                name: server,
                enabled: true,
                transport,
                ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
            },
        };
    }
}
//# sourceMappingURL=session-servers.js.map