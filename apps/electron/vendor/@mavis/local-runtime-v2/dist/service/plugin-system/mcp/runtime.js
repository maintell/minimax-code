import { attachProgrammaticErrorRaw } from '@mavis/agent-core/tools';
import { describeMcpCallError, findMcpAuthRequiredError, McpNameRegistry, pluginMcpNameKey, McpConnectionPool, } from '@mavis/mcp';
const LIST_TOOLS_CONCURRENCY = 4;
/**
 * Desktop Plugin MCP owner. Its pool and lookup are deliberately separate
 * from v1 LocalMcpService, whose connections belong to the user's mcp.json.
 */
export class PluginMcpRuntime {
    servers = new Map();
    lifecycleKeys = new Map();
    inventories = new Map();
    /** Resolved per lookup generation; `null` caches "no credential" for that server. */
    credentials = new Map();
    pool;
    auth;
    logger;
    metrics;
    listToolsTimeoutMs;
    disconnectTimeoutMs;
    shutdownTimeoutMs;
    onManagedMiniAppToolCall;
    closed = false;
    names;
    constructor(options = {}) {
        this.names = options.names ?? new McpNameRegistry();
        this.auth = options.auth;
        this.logger = options.logger ?? NOOP_LOGGER;
        this.metrics = options.metrics;
        this.listToolsTimeoutMs = options.listToolsTimeoutMs ?? 15_000;
        this.disconnectTimeoutMs = options.disconnectTimeoutMs ?? 5_000;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
        this.onManagedMiniAppToolCall = options.onManagedMiniAppToolCall;
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
        for (const [index, entry] of entries.entries()) {
            const inventory = inventories[index];
            if (!inventory || inventory.state !== 'ready') {
                const diagnostic = unavailableServerDiagnostic(entry, inventory, inventoryMode);
                // Waiting on the user is not a failure: retrying cannot succeed before authorization.
                if (diagnostic.code !== 'MCP_SERVER_AUTH_REQUIRED')
                    failedServerCount += 1;
                diagnostics.push(diagnostic);
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
        return freeze([...this.inventories.entries()].flatMap(([serverName, inventory]) => inventory.state !== 'ready'
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
                state: 'ready',
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
        this.credentials.clear();
        await ignoreFailure(withTimeout(this.pool.shutdown(), this.shutdownTimeoutMs, 'Plugin MCP runtime shutdown timed out'));
    }
    async disconnectServers(serverNames) {
        await Promise.allSettled([...new Set(serverNames)].map((serverName) => this.disconnectBounded(serverName)));
    }
    forgetInventories(serverNames) {
        for (const serverName of serverNames)
            this.inventories.delete(serverName);
    }
    async probe(serverName) {
        const entry = this.servers.get(serverName);
        if (this.closed || !entry)
            return new Error('Plugin MCP server is not loaded');
        try {
            await withTimeout(this.pool.listTools(serverName, this.connectionOverrides(entry)), this.listToolsTimeoutMs, `Plugin MCP tools/list timed out for ${entry.server.name}`);
            return 'connected';
        }
        catch (error) {
            await this.disconnectBounded(serverName);
            const authError = findMcpAuthRequiredError(error);
            if (authError)
                return authError;
            return error instanceof Error ? error : new Error(String(error));
        }
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
            if (nextKeys.get(serverName) !== inventory.lifecycleKey || inventory.state !== 'ready') {
                this.inventories.delete(serverName);
            }
        }
    }
    /** Never connects; a stored needs-authorization state is a local file read. */
    async resolveCachedInventory(entry) {
        const key = lifecycleKey(entry);
        const existing = this.inventories.get(poolName(entry));
        if (existing?.lifecycleKey === key && existing.state === 'ready')
            return existing;
        if (await skipsBackground(this.credentialFor(entry)))
            return this.authRequired(entry);
        return freeze({ lifecycleKey: key, tools: freeze([]), state: 'failed' });
    }
    async resolveInventory(entry, reuseExisting) {
        const key = lifecycleKey(entry);
        const existing = this.inventories.get(poolName(entry));
        if (reuseExisting && existing?.lifecycleKey === key && existing.state !== 'auth_required') {
            return existing;
        }
        const credential = this.credentialFor(entry);
        if (await skipsBackground(credential))
            return this.authRequired(entry);
        try {
            const tools = await withTimeout(this.pool.listTools(poolName(entry), this.connectionOverrides(entry)), this.listToolsTimeoutMs, `Plugin MCP tools/list timed out for ${entry.server.name}`);
            this.metrics?.incr('plugin_mcp_list_total', { status: 'ok' });
            if (credential)
                await ignoreFailure(credential.markObserved('connected'));
            const inventory = freeze({
                lifecycleKey: key,
                tools: freeze([...tools]),
                state: 'ready',
            });
            this.inventories.set(poolName(entry), inventory);
            return inventory;
        }
        catch (error) {
            await this.disconnectBounded(poolName(entry));
            const authRequired = await this.observeAuthFailure(entry, error);
            this.metrics?.incr('plugin_mcp_list_total', {
                status: authRequired ? 'auth_required' : 'error',
            });
            if (authRequired)
                return this.authRequired(entry);
            this.logger.warn('Plugin MCP tools/list failed', {
                pluginName: entry.pluginName,
                source: entry.source,
                serverName: entry.server.name,
                errorType: errorType(error),
            });
            const inventory = freeze({
                lifecycleKey: key,
                tools: freeze([]),
                state: 'failed',
            });
            this.inventories.set(poolName(entry), inventory);
            return inventory;
        }
    }
    authRequired(entry) {
        const inventory = freeze({
            lifecycleKey: lifecycleKey(entry),
            tools: freeze([]),
            state: 'auth_required',
        });
        this.inventories.set(poolName(entry), inventory);
        return inventory;
    }
    credentialFor(entry) {
        const name = poolName(entry);
        const cached = this.credentials.get(name);
        if (cached !== undefined)
            return cached ?? undefined;
        const credential = this.auth?.resolve(entry);
        this.credentials.set(name, credential ?? null);
        return credential;
    }
    connectionOverrides(entry) {
        const credential = this.credentialFor(entry);
        return credential ? { authorizer: credential.authorizer } : undefined;
    }
    replaceLookup(entries) {
        this.servers.clear();
        this.lifecycleKeys.clear();
        this.credentials.clear();
        for (const entry of entries) {
            this.servers.set(poolName(entry), entry);
            this.lifecycleKeys.set(poolName(entry), lifecycleKey(entry));
        }
    }
    /** True when `error` means the user must authorize a server that has credentials. */
    async observeAuthFailure(entry, error) {
        const credential = this.credentialFor(entry);
        const authError = credential ? findMcpAuthRequiredError(error) : undefined;
        if (!credential || !authError)
            return false;
        await ignoreFailure(credential.markObserved(authError));
        credential.authRequired(authError);
        return true;
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
                execute: async (context, input, signal) => {
                    if (entry.managedIdentity?.kind === 'miniapp') {
                        try {
                            this.onManagedMiniAppToolCall?.({
                                pluginName: entry.pluginName,
                                sessionId: context.sessionId,
                                turnId: context.turnId,
                            });
                        }
                        catch {
                            // The observer is advisory; the tool call proceeds regardless.
                        }
                    }
                    let result;
                    try {
                        result = await this.pool.callTool(poolName(entry), tool.name, toRecord(input), this.connectionOverrides(entry), signal ? { signal } : undefined);
                    }
                    catch (error) {
                        // The thrown error still fails the call exactly as before; PTC
                        // scripts additionally get the JSON-RPC or connection error as
                        // `error.raw`. Only the error class and code are logged.
                        const raw = describeMcpCallError(error);
                        const attached = raw !== undefined && attachProgrammaticErrorRaw(error, raw);
                        this.logger.warn('Plugin MCP tool call failed', {
                            pluginName: entry.pluginName,
                            serverName: entry.server.name,
                            toolName: tool.name,
                            errorCode: raw?.code ?? null,
                            rawAttached: attached,
                        });
                        await this.observeAuthFailure(entry, error);
                        throw error;
                    }
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
                        // PTC-only: structuredContent becomes `data` on success and on isError.
                        ...(isPlainRecord(result.structuredContent)
                            ? { programmatic: { data: result.structuredContent } }
                            : {}),
                    };
                },
            }),
            source: 'configured',
        });
    }
}
function unavailableServerDiagnostic(entry, inventory, inventoryMode) {
    let code = 'MCP_SERVER_AUTH_REQUIRED';
    if (inventory?.state !== 'auth_required') {
        code = shouldDiscoverInventory(entry, inventoryMode)
            ? 'MCP_SERVER_LIST_FAILED'
            : 'MCP_SERVER_WARMING';
    }
    return freeze({ code, pluginName: entry.pluginName, capabilityName: entry.server.name });
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
/**
 * An unreadable credential store must not fail the whole reconcile: the server
 * is then attempted normally and fails on its own listing path.
 */
async function skipsBackground(credential) {
    try {
        return (await credential?.shouldSkipBackground()) === true;
    }
    catch {
        return false;
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
/** `server` carries the `oauth` descriptor; the PluginId separates same-name credentials. */
function lifecycleKey(entry) {
    return JSON.stringify({
        pluginName: entry.pluginName,
        pluginId: entry.pluginId,
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
function isPlainRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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