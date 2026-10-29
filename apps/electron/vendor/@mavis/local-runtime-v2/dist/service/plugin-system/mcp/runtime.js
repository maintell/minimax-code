import { McpNameRegistry, pluginMcpNameKey, McpConnectionPool, } from '@mavis/mcp';
const LIST_TOOLS_CONCURRENCY = 4;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOOLS_PER_SNAPSHOT = 256;
/**
 * Desktop Plugin MCP owner. Its pool and lookup are deliberately separate
 * from v1 LocalMcpService, whose connections belong to the user's mcp.json.
 */
export class PluginMcpRuntime {
    servers = new Map();
    lifecycleKeys = new Map();
    inventories = new Map();
    pool;
    logger;
    metrics;
    listToolsTimeoutMs;
    disconnectTimeoutMs;
    shutdownTimeoutMs;
    closed = false;
    names;
    constructor(options = {}) {
        this.names = options.names ?? new McpNameRegistry();
        this.logger = options.logger ?? NOOP_LOGGER;
        this.metrics = options.metrics;
        this.listToolsTimeoutMs = options.listToolsTimeoutMs ?? 15_000;
        this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? 5_000;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
        this.pool =
            options.pool ??
                new McpConnectionPool({
                    getResolvedServer: (serverName) => this.servers.get(serverName)?.server.resolvedServer ?? null,
                }, {
                    ...options.poolOptions,
                    logger: this.logger,
                    ...(options.metrics ? { metrics: options.metrics } : {}),
                });
    }
    async reconcile(entries, options = {}) {
        if (this.closed)
            throw new Error('Plugin MCP runtime is closed');
        this.names.assignServers(entries.map((entry) => ({
            key: pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name),
            name: entry.server.name,
        })));
        const inventoryMode = options.inventoryMode ?? 'discover';
        if (inventoryMode !== 'discover')
            this.retainExactInventories(entries);
        else
            await this.disconnectStaleServers(entries);
        this.replaceLookup(entries);
        const runtimeTools = [];
        const runtimeToolBindings = [];
        const diagnostics = [];
        const toolNames = new Set();
        let failedServerCount = 0;
        const inventories = await mapBounded(entries, LIST_TOOLS_CONCURRENCY, async (entry) => shouldDiscoverInventory(entry, inventoryMode)
            ? this.resolveInventory(entry, options.reuseExistingInventory === true)
            : this.resolveCachedInventory(entry));
        await this.enforceInventoryLimits(entries, inventories, inventoryMode);
        for (const [index, entry] of entries.entries()) {
            const inventory = inventories[index];
            if (!inventory || inventory.failed) {
                failedServerCount += 1;
                diagnostics.push(freeze({
                    code: shouldDiscoverInventory(entry, inventoryMode)
                        ? 'MCP_SERVER_LIST_FAILED'
                        : 'MCP_SERVER_WARMING',
                    pluginName: entry.pluginName,
                    capabilityName: entry.server.name,
                }));
                continue;
            }
            for (const { tool, nativeName } of this.assignToolNames(entry, inventory.tools, diagnostics)) {
                const key = collisionKey(nativeName);
                if (toolNames.has(key)) {
                    diagnostics.push(freeze({
                        code: 'MCP_TOOL_NAME_CONFLICT',
                        pluginName: entry.pluginName,
                        capabilityName: tool.name,
                    }));
                    continue;
                }
                toolNames.add(key);
                const runtimeTool = this.runtimeTool(entry, tool, nativeName);
                runtimeTools.push(runtimeTool);
                runtimeToolBindings.push(freeze({
                    kind: 'mcp',
                    source: entry.server.name,
                    pluginName: entry.pluginName,
                    mcpToolName: tool.name,
                    tool: runtimeTool,
                }));
            }
        }
        return freeze({
            runtimeTools: freeze(runtimeTools),
            runtimeToolBindings: freeze(runtimeToolBindings),
            diagnostics: freeze(diagnostics),
            failedServerCount,
        });
    }
    assignToolNames(entry, tools, diagnostics) {
        const allocated = this.names.assignTools(pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name), tools.map((tool) => tool.name));
        return tools.flatMap((tool) => {
            const nativeName = allocated.names.get(tool.name);
            if (nativeName)
                return [{ tool, nativeName }];
            diagnostics.push({
                code: 'MCP_TOOL_NAME_INVALID',
                pluginName: entry.pluginName,
                capabilityName: tool.name,
            });
            return [];
        });
    }
    exportInventory() {
        if (this.closed)
            return [];
        return freeze([...this.inventories.entries()].flatMap(([serverName, inventory]) => inventory.failed
            ? []
            : [
                freeze({
                    serverName,
                    lifecycleKey: inventory.lifecycleKey,
                    tools: freeze([...inventory.tools]),
                }),
            ]));
    }
    importInventory(seed) {
        if (this.closed || this.servers.size > 0 || this.inventories.size > 0)
            return;
        for (const item of seed) {
            this.lifecycleKeys.set(item.serverName, item.lifecycleKey);
            this.inventories.set(item.serverName, freeze({
                lifecycleKey: item.lifecycleKey,
                tools: freeze([...item.tools]),
                failed: false,
            }));
        }
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.servers.clear();
        this.lifecycleKeys.clear();
        this.inventories.clear();
        await ignoreFailure(withTimeout(this.pool.shutdown(), this.shutdownTimeoutMs, 'Plugin MCP runtime shutdown timed out'));
    }
    async disconnectServers(serverNames) {
        await Promise.allSettled([...new Set(serverNames)].map((serverName) => this.disconnectBounded(serverName)));
    }
    async adoptManagedServers(entries) {
        if (this.closed)
            return;
        const changed = [];
        for (const entry of entries) {
            if (entry.managedIdentity?.kind !== 'miniapp')
                continue;
            const name = poolName(entry);
            if (this.servers.get(name)?.managedIdentity?.kind !== 'miniapp')
                continue;
            const key = lifecycleKey(entry);
            if (this.lifecycleKeys.get(name) === key)
                continue;
            this.servers.set(name, entry);
            this.lifecycleKeys.set(name, key);
            changed.push(name);
        }
        await this.disconnectServers(changed);
    }
    async disconnectBounded(serverName) {
        await ignoreFailure(withTimeout(this.pool.disconnect(serverName), this.disconnectTimeoutMs, `Plugin MCP disconnect timed out for ${serverName}`));
    }
    async disconnectStaleServers(entries) {
        const nextKeys = new Map(entries.map((entry) => [poolName(entry), lifecycleKey(entry)]));
        const stale = [...this.lifecycleKeys].flatMap(([serverName, priorKey]) => nextKeys.get(serverName) === priorKey ? [] : [serverName]);
        await this.disconnectServers(stale);
        for (const serverName of stale)
            this.inventories.delete(serverName);
    }
    retainExactInventories(entries) {
        const nextKeys = new Map(entries.map((entry) => [poolName(entry), lifecycleKey(entry)]));
        for (const [serverName, inventory] of this.inventories) {
            if (nextKeys.get(serverName) !== inventory.lifecycleKey || inventory.failed) {
                this.inventories.delete(serverName);
            }
        }
    }
    resolveCachedInventory(entry) {
        const key = lifecycleKey(entry);
        const existing = this.inventories.get(poolName(entry));
        if (existing?.lifecycleKey === key && !existing.failed)
            return existing;
        return freeze({ lifecycleKey: key, tools: freeze([]), failed: true });
    }
    async resolveInventory(entry, reuseExisting) {
        const key = lifecycleKey(entry);
        const existing = this.inventories.get(poolName(entry));
        if (reuseExisting && existing?.lifecycleKey === key)
            return existing;
        try {
            const tools = await withTimeout(this.pool.listTools(poolName(entry)), this.listToolsTimeoutMs, `Plugin MCP tools/list timed out for ${entry.server.name}`);
            if (tools.length > MAX_TOOLS_PER_SERVER) {
                throw new Error(`Plugin MCP server ${entry.server.name} returned more than ${MAX_TOOLS_PER_SERVER} tools`);
            }
            this.metrics?.incr('plugin_mcp_list_total', { status: 'ok' });
            const inventory = freeze({ lifecycleKey: key, tools: freeze([...tools]), failed: false });
            this.inventories.set(poolName(entry), inventory);
            return inventory;
        }
        catch (error) {
            await this.disconnectBounded(poolName(entry));
            this.metrics?.incr('plugin_mcp_list_total', { status: 'error' });
            this.logger.warn('Plugin MCP tools/list failed', {
                pluginName: entry.pluginName,
                source: entry.source,
                serverName: entry.server.name,
                errorType: errorType(error),
            });
            const inventory = freeze({
                lifecycleKey: key,
                tools: freeze([]),
                failed: true,
            });
            this.inventories.set(poolName(entry), inventory);
            return inventory;
        }
    }
    async rejectInventory(entry, key, reason) {
        await this.disconnectBounded(poolName(entry));
        this.metrics?.incr('plugin_mcp_list_total', { status: 'limit' });
        this.logger.warn('Plugin MCP tools/list inventory rejected', {
            pluginName: entry.pluginName,
            source: entry.source,
            serverName: entry.server.name,
            reason,
        });
        const inventory = freeze({
            lifecycleKey: key,
            tools: freeze([]),
            failed: true,
        });
        this.inventories.set(poolName(entry), inventory);
        return inventory;
    }
    async enforceInventoryLimits(entries, inventories, inventoryMode) {
        let acceptedToolCount = 0;
        for (const [index, entry] of entries.entries()) {
            const inventory = inventories[index];
            if (!inventory || inventory.failed)
                continue;
            const exceedsServer = inventory.tools.length > MAX_TOOLS_PER_SERVER;
            const exceedsSnapshot = acceptedToolCount + inventory.tools.length > MAX_TOOLS_PER_SNAPSHOT;
            if (exceedsServer || exceedsSnapshot) {
                const reason = exceedsServer
                    ? `Plugin MCP server returned more than ${MAX_TOOLS_PER_SERVER} tools`
                    : `Plugin MCP snapshot exceeds ${MAX_TOOLS_PER_SNAPSHOT} tools`;
                inventories[index] = shouldDiscoverInventory(entry, inventoryMode)
                    ? await this.rejectInventory(entry, inventory.lifecycleKey, reason)
                    : this.rejectCachedInventory(entry, inventory.lifecycleKey, reason);
                continue;
            }
            acceptedToolCount += inventory.tools.length;
        }
    }
    rejectCachedInventory(entry, key, reason) {
        this.metrics?.incr('plugin_mcp_list_total', { status: 'limit' });
        this.logger.warn('Plugin MCP cached inventory rejected', {
            pluginName: entry.pluginName,
            source: entry.source,
            serverName: entry.server.name,
            reason,
        });
        this.inventories.delete(poolName(entry));
        return freeze({ lifecycleKey: key, tools: freeze([]), failed: true });
    }
    replaceLookup(entries) {
        this.servers.clear();
        this.lifecycleKeys.clear();
        for (const entry of entries) {
            this.servers.set(poolName(entry), entry);
            this.lifecycleKeys.set(poolName(entry), lifecycleKey(entry));
        }
    }
    runtimeTool(entry, tool, nativeName) {
        const def = freeze({
            name: nativeName,
            description: tool.description ??
                `Call MCP tool ${tool.name} from Plugin ${entry.pluginName} server ${entry.server.name}.`,
            schema: freeze({ ...tool.inputSchema }),
        });
        return freeze({
            def,
            impl: freeze({
                execute: async (_context, input, signal) => {
                    const result = await this.pool.callTool(poolName(entry), tool.name, toRecord(input), undefined, signal ? { signal } : undefined);
                    const text = mcpContentToText(result);
                    const content = toToolResultContent(result, text);
                    return {
                        tool_name: nativeName,
                        text,
                        content,
                        ...(result.isError === true ? { isError: true } : {}),
                        details: {
                            mcp: result,
                            server: entry.server.name,
                            tool: tool.name,
                            plugin: entry.pluginName,
                        },
                        output: { mcp: result },
                    };
                },
            }),
            source: 'configured',
        });
    }
}
function shouldDiscoverInventory(entry, inventoryMode) {
    return (inventoryMode === 'discover' ||
        (inventoryMode === 'discover-managed' && entry.managedIdentity !== undefined));
}
async function withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function ignoreFailure(promise) {
    try {
        await promise;
    }
    catch {
        // Shutdown and stale-generation cleanup are bounded best-effort operations.
    }
}
async function mapBounded(values, concurrency, mapper) {
    const results = new Array(values.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            const value = values[index];
            if (value !== undefined)
                results[index] = await mapper(value);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
    return results;
}
function lifecycleKey(entry) {
    return JSON.stringify({
        pluginName: entry.pluginName,
        source: entry.source,
        server: entry.server.resolvedServer,
        ...(entry.managedIdentity ? { managedIdentity: entry.managedIdentity } : {}),
        ...(entry.server.resolvedServer.transport.type === 'stdio'
            ? { packageContentDigest: entry.packageContentDigest }
            : {}),
    });
}
function collisionKey(value) {
    return value.startsWith('mcp__')
        ? value
        : value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function toRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function toToolResultContent(result, fallbackText) {
    const content = result.content.map((item) => {
        if (item.type === 'text')
            return { type: 'text', text: item.text ?? '' };
        if (item.type === 'image' && item.data && item.mimeType) {
            return { type: 'image', data: item.data, mimeType: item.mimeType };
        }
        return { type: 'text', text: `[${item.type}]` };
    });
    return content.length > 0 ? content : [{ type: 'text', text: fallbackText }];
}
function mcpContentToText(result) {
    const text = result.content
        .map((item) => (item.type === 'text' ? (item.text ?? '') : `[${item.type}]`))
        .filter(Boolean)
        .join('\n');
    return text || (result.isError ? 'MCP tool returned an error.' : 'MCP tool returned no content.');
}
function errorType(error) {
    return error instanceof Error ? error.name : typeof error;
}
function freeze(value) {
    return Object.freeze(value);
}
const NOOP_LOGGER = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
function poolName(entry) {
    return pluginMcpNameKey(entry.source, entry.pluginName, entry.server.name);
}
//# sourceMappingURL=runtime.js.map