import { ProjectMcpRuntime } from '../project-mcp.service.js';
import { SessionMcpServers } from './session-servers.js';
import { projectNativeTools, reserveConfiguredServerNames } from './native-tool-projection.js';
import { McpNameRegistry, McpToolCallNotDispatchedError, } from '@mavis/mcp';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalMavisMcpServiceAdapter } from '../tools/local-mavis-adapter.js';
import { mapMcpContent, normalizeCallResult } from '../tools/result-mapping.js';
import { localMcpCallFailureResult, withMcpProgrammatic } from '../tools/programmatic-result.js';
import { callLocalMcpToolUnfolded } from '../tools/miniapp-call.js';
import { listMcpRuntimeToolEntriesForTurn } from '../tools/runtime-tools.js';
import { readConfiguredMcpServerNames } from './config-file.js';
import { readLocalMcpFile, writeLocalMcpFile, writeLocalMcpRawDocument, } from './configuration.repository.js';
import { configuredConnectionFailure, configuredDetail, configuredInputFromStored, ConfiguredMcpConnectionTimeoutError, configuredSummary, isUserConfiguredServer, publicTransport, requireConfiguredInput, requireUserConfiguredServer, storedConfigFromInput, toTypeSchema, toManagedServerSummary, validateConfiguredServerName, withValidatedOAuth, } from './settings-config.js';
import { authFailureMessage, CONNECTION_FAILED_ERROR, McpServerAuth } from '../auth/server-auth.js';
import { buildBuiltinMatrixServerConfig, BUILTIN_MATRIX_SERVER_NAME, isBuiltinMatrixConfig, isRetiredLegacyMatrixMcpServerConfig, listBuiltinMatrixMcpToolDescriptors, matrixTokenOverrides, } from './builtin-matrix.js';
import { configToTransportConfig, configuredTimeout, stdioDiscoveryTimeoutFromEnv, hasLocalCallAdapter, inferTransport, normalizeServerConfig, normalizeServerName, readConfiguredTools, readRecord, } from './config.js';
import { isRetiredLegacyCuMcpServerConfig } from './retired-cu.js';
import { LocalMcpSettingsError } from '../errors.js';
const CONNECTION_TIMEOUT_ERROR = 'MCP server connection timed out. Retry or check its configuration.';
export class LocalMcpService {
    dataDir;
    options;
    closed = false;
    runtimeNames;
    getRuntimeNameRegistry() {
        this.runtimeNames ??= new McpNameRegistry(join(this.dataDir(), 'mcp-runtime-names.json'));
        return this.runtimeNames;
    }
    pendingReads = new Set();
    closePromise;
    shutdownSignal = new AbortController();
    syncState = 'IDLE';
    lastSyncError;
    mutationQueue = Promise.resolve();
    publicRuntimeErrors = new Map();
    publiclyAvailableServers = new Set();
    /**
     * Last successfully parsed mcp.json contents. Populated by `readFile()` and
     * read by `getServerLookup().getResolvedServer()` which the connection pool
     * calls synchronously inside `doConnect`. Falls back to an empty record
     * before the first read.
     */
    lastReadFile;
    serverChangeListeners = new Set();
    sessionServers;
    projectMcp;
    serverAuth;
    constructor(dataDir, options = {}) {
        this.dataDir = dataDir;
        this.options = options;
        this.sessionServers = new SessionMcpServers(options.connectionPool);
        this.projectMcp = new ProjectMcpRuntime(options.connectionPool);
        this.serverAuth = new McpServerAuth({
            runtime: options,
            dataDir,
            projectSource: (config) => this.projectMcp.authSource(config),
            isSessionServer: (server, context) => this.isSessionServer(server, context),
            resolveOverrides: ({ server, config, context }, authorizer) => this.resolveConnectionOverrides(server, config, context, authorizer),
            owner: {
                assertOpen: () => this.assertOpen(),
                readUserServers: async () => (await this.readFile()).mcpServers,
                resolveProject: (context) => this.enqueueMutation(() => this.projectMcp.resolve(context)),
                getServerConfig: (name, context) => this.getServerConfig(name, context),
                connectionSignal: (config, signal) => this.connectionSignal(config, signal),
                record: ({ server, context, config }, error) => error
                    ? this.recordPublicRuntimeFailure(server, context, error, config)
                    : this.recordPublicRuntimeSuccess(server, context, config),
                reset: async (target) => {
                    await this.options.connectionPool?.disconnect(target.serverName);
                    if (target.kind === 'user')
                        this.resetPublicRuntimeStatus(target.serverName);
                    this.notifyServerChangeListeners();
                },
            },
        });
    }
    getSessionMcpServers(sessionId) {
        return this.sessionServers.get(sessionId);
    }
    async disposeSession(sessionId) {
        this.serverAuth.gate.forgetSession(sessionId);
        await this.enqueueMutation(async () => {
            await this.projectMcp.clearSession(sessionId);
            await this.sessionServers.remove(sessionId);
        });
    }
    async inspectProjectMcp(context) {
        this.assertOpen();
        const project = this.projectMcp;
        return this.enqueueMutation(() => project.inspect(context));
    }
    readConfiguredServerNames() {
        this.assertOpen();
        return readConfiguredMcpServerNames(this.dataDir());
    }
    createMavisAdapter(emit) {
        this.assertOpen();
        return new LocalMavisMcpServiceAdapter(this, emit);
    }
    listToolEntriesForTurn(input) {
        this.assertOpen();
        return listMcpRuntimeToolEntriesForTurn({ ...input, mcpService: this });
    }
    close() {
        if (!this.closePromise) {
            this.closed = true;
            this.shutdownSignal.abort();
            this.closePromise = (async () => {
                await this.mutationQueue;
                await Promise.allSettled([...this.pendingReads]);
                await this.options.connectionPool?.shutdown();
                this.serverChangeListeners.clear();
                this.sessionServers.clear();
                this.publicRuntimeErrors.clear();
                this.publiclyAvailableServers.clear();
            })();
        }
        return this.closePromise;
    }
    assertOpen() {
        if (this.closed)
            throw new Error('MCP runtime has been closed');
    }
    onDidChangeServers(listener) {
        this.assertOpen();
        this.serverChangeListeners.add(listener);
        return () => this.serverChangeListeners.delete(listener);
    }
    async configureSessionServers(sessionId, servers) {
        this.assertOpen();
        return this.enqueueMutation(() => this.sessionServers.configure(sessionId, servers));
    }
    async clearSessionServers(sessionId) {
        this.assertOpen();
        return this.enqueueMutation(() => this.sessionServers.remove(sessionId));
    }
    async listUserConfiguredServers() {
        this.assertOpen();
        const raw = await this.readRawDocument();
        this.lastReadFile = this.normalizeRawServers(raw.servers);
        return Object.entries(raw.servers)
            .flatMap(([rawName, rawConfig]) => {
            const rawConfigObject = readRecord(rawConfig);
            if (!rawConfigObject)
                return [];
            const name = normalizeServerName(rawName);
            const config = normalizeServerConfig(rawConfigObject);
            if (config.builtin === true ||
                isRetiredLegacyMatrixMcpServerConfig(name, config) ||
                isRetiredLegacyCuMcpServerConfig(name, config)) {
                return [];
            }
            return [toManagedServerSummary(name, rawConfigObject, config)];
        })
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    async setUserConfiguredServerEnabled(name, enabled) {
        this.assertOpen();
        return this.enqueueMutation(async () => {
            const serverName = normalizeServerName(name);
            const raw = await this.readRawDocument();
            const entry = Object.entries(raw.servers).find(([candidate]) => normalizeServerName(candidate) === serverName);
            if (!entry)
                return undefined;
            const [rawName, rawCurrent] = entry;
            const current = readRecord(rawCurrent);
            if (!current)
                return undefined;
            const normalized = normalizeServerConfig(current);
            if (normalized.builtin === true ||
                isRetiredLegacyMatrixMcpServerConfig(serverName, normalized) ||
                isRetiredLegacyCuMcpServerConfig(serverName, normalized)) {
                return undefined;
            }
            const next = { ...current, enabled };
            raw.servers[rawName] = next;
            raw.document['mcpServers'] = raw.servers;
            await this.writeRawDocument(raw.document);
            this.lastReadFile = this.normalizeRawServers(raw.servers);
            await this.options.connectionPool?.disconnect(serverName);
            this.resetPublicRuntimeStatus(serverName);
            this.notifyServerChangeListeners();
            return toManagedServerSummary(serverName, next, normalizeServerConfig(next));
        });
    }
    isBuiltinMatrixAvailable() {
        this.assertOpen();
        return this.isBuiltinMatrixEnabled();
    }
    async listPublicServerStatuses() {
        this.assertOpen();
        const file = await this.readFile();
        const statuses = [];
        for (const [name, config] of Object.entries(file.mcpServers)) {
            if (config.builtin === true || config.configured === false)
                continue;
            const base = {
                name,
                enabled: config.enabled !== false,
                transport: publicTransport(config),
                ...(config.description ? { description: config.description } : {}),
            };
            if (config.enabled === false) {
                statuses.push({ ...base, status: 'disabled', available: false });
                continue;
            }
            const runtimeError = this.publicRuntimeErrors.get(name);
            if (runtimeError) {
                statuses.push({ ...base, status: 'error', available: false, error: runtimeError });
                continue;
            }
            const unavailable = this.unavailableReason(config);
            if (unavailable) {
                statuses.push({ ...base, status: 'unavailable', available: false, error: unavailable });
                continue;
            }
            statuses.push(this.publiclyAvailableServers.has(name)
                ? { ...base, status: 'available', available: true }
                : { ...base, status: 'configured', available: false });
        }
        return statuses;
    }
    async listBuiltinPublicServerCapabilities() {
        this.assertOpen();
        if (this.options.builtinMatrix?.enabled !== true)
            return [];
        const available = this.isBuiltinMatrixEnabled();
        return [
            {
                name: BUILTIN_MATRIX_SERVER_NAME,
                sourceKind: 'builtin',
                managed: true,
                enabled: available,
                transport: 'stdio',
                description: 'Built-in Matrix capabilities for web and media workflows.',
                status: available ? 'available' : 'unavailable',
                available,
                ...(!available ? { error: 'Built-in MCP server is not active in this Runtime.' } : {}),
                tools: listBuiltinMatrixMcpToolDescriptors().map((tool) => ({
                    name: tool.name,
                    ...(tool.description ? { description: tool.description } : {}),
                })),
            },
        ];
    }
    async listServers(context) {
        this.assertOpen();
        const file = this.withBuiltinServers(await this.readFile(), context);
        const statuses = await this.serverAuth.legacyStatuses(file.mcpServers);
        return Object.entries(file.mcpServers).map(([name, config], index) => {
            const tools = readConfiguredTools(config);
            return {
                name,
                transport: inferTransport(config),
                authStatus: statuses[index]?.status ?? 'none',
                skillStatus: tools.length > 0 ? 'active' : 'not_generated',
                enabled: config.enabled !== false,
                configured: config.configured !== false,
                builtin: config.builtin === true,
                description: config.description,
                tools: {
                    count: tools.length,
                    items: tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description ?? '',
                    })),
                    syncedAt: this.nowMs(),
                },
            };
        });
    }
    async listConfiguredServers(keyword) {
        this.assertOpen();
        const file = await this.readFile(true);
        const normalizedKeyword = keyword?.trim().toLocaleLowerCase();
        const summaries = Object.entries(file.mcpServers).flatMap(([name, config]) => {
            if (!isUserConfiguredServer(config))
                return [];
            if (normalizedKeyword && !name.toLocaleLowerCase().includes(normalizedKeyword))
                return [];
            const input = configuredInputFromStored(config);
            if (!input)
                return [];
            return [{ summary: configuredSummary(name, config, input), config }];
        });
        return this.serverAuth.withAuthStates(summaries);
    }
    /** Existing configuration keys must be addressed exactly, without creation-time normalization. */
    async getConfiguredServer(name) {
        this.assertOpen();
        const serverName = name;
        const config = (await this.readFile(true)).mcpServers[serverName];
        if (!config || !isUserConfiguredServer(config))
            return undefined;
        const input = configuredInputFromStored(config);
        if (!input)
            return undefined;
        return configuredDetail(serverName, config, input);
    }
    async createConfiguredServer(name, input, enabled = true) {
        this.assertOpen();
        const serverName = validateConfiguredServerName(name);
        if (this.isBuiltinMatrixServerName(serverName)) {
            throw new LocalMcpSettingsError(409, `MCP server "${serverName}" already exists.`, 'MCP_SERVER_EXISTS');
        }
        const stored = storedConfigFromInput(input, enabled);
        return this.enqueueMutation(async () => {
            const file = await this.readFileWithinMutation(true);
            if (file.mcpServers[serverName]) {
                throw new LocalMcpSettingsError(409, `MCP server "${serverName}" already exists.`, 'MCP_SERVER_EXISTS');
            }
            file.mcpServers[serverName] = stored;
            await this.writeFile(file);
            this.notifyServerChangeListeners();
            return configuredDetail(serverName, stored, requireConfiguredInput(stored));
        });
    }
    async updateConfiguredServer(name, input, enabled) {
        this.assertOpen();
        const serverName = name;
        return this.enqueueMutation(async () => {
            const file = await this.readFileWithinMutation(true);
            const current = requireUserConfiguredServer(file, serverName);
            const stored = storedConfigFromInput(input, enabled ?? current.enabled !== false);
            await this.writeConfiguredMutation(serverName, {
                ...file,
                mcpServers: { ...file.mcpServers, [serverName]: stored },
            });
            return configuredDetail(serverName, stored, requireConfiguredInput(stored));
        });
    }
    async deleteConfiguredServer(name) {
        this.assertOpen();
        const serverName = name;
        return this.enqueueMutation(async () => {
            const file = await this.readFileWithinMutation(true);
            const removed = requireUserConfiguredServer(file, serverName);
            const remainingServers = { ...file.mcpServers };
            delete remainingServers[serverName];
            await this.writeConfiguredMutation(serverName, {
                ...file,
                mcpServers: remainingServers,
            });
            await this.serverAuth.deleteUnusedUserCredentials(serverName, removed, remainingServers);
            return true;
        });
    }
    async setConfiguredServerEnabled(name, enabled) {
        this.assertOpen();
        const serverName = name;
        return this.enqueueMutation(async () => {
            const file = await this.readFileWithinMutation(true);
            const current = requireUserConfiguredServer(file, serverName);
            const next = { ...current, enabled };
            await this.writeConfiguredMutation(serverName, {
                ...file,
                mcpServers: { ...file.mcpServers, [serverName]: next },
            });
            const input = configuredInputFromStored(next);
            if (!input) {
                throw new LocalMcpSettingsError(400, 'MCP server configuration is invalid.', 'MCP_CONFIG_INVALID');
            }
            return configuredSummary(serverName, next, input);
        });
    }
    async testConfiguredServer(name) {
        this.assertOpen();
        const serverName = name;
        const file = await this.readFile(true);
        const config = requireUserConfiguredServer(file, serverName);
        if (config.enabled === false) {
            return {
                success: false,
                errorCode: 'MCP_SERVER_DISABLED',
                errorMessage: 'Enable the MCP server before testing the connection.',
            };
        }
        const pool = this.options.connectionPool;
        if (!pool) {
            return {
                success: false,
                errorCode: 'MCP_CONNECTION_UNAVAILABLE',
                errorMessage: 'MCP connections are unavailable in this runtime.',
            };
        }
        try {
            const tools = await this.serverAuth.listToolsInteractive({ server: serverName, config }, pool);
            return { success: true, toolCount: tools.length };
        }
        catch (error) {
            return (this.serverAuth.connectionTestFailure(error) ?? configuredConnectionFailure(error, config));
        }
    }
    async addServer(name, config) {
        this.assertOpen();
        return this.enqueueMutation(async () => {
            const serverName = normalizeServerName(name);
            const file = await this.readFileWithinMutation(true);
            const next = normalizeServerConfig(config);
            const serverConfig = {
                ...file.mcpServers[serverName],
                ...next,
                enabled: next.enabled ?? true,
                configured: next.configured ?? true,
            };
            file.mcpServers[serverName] = withValidatedOAuth(serverConfig);
            await this.writeConfiguredMutation(serverName, file);
            const tools = readConfiguredTools(serverConfig);
            return {
                name: serverName,
                transport: inferTransport(serverConfig),
                authStatus: await this.serverAuth.legacyStatus(serverName, serverConfig),
                skillStatus: tools.length > 0 ? 'active' : 'not_generated',
                enabled: serverConfig.enabled !== false,
                configured: serverConfig.configured !== false,
                builtin: serverConfig.builtin === true,
                description: serverConfig.description,
                tools: {
                    count: tools.length,
                    items: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
                    syncedAt: this.nowMs(),
                },
            };
        });
    }
    async disableServer(name) {
        this.assertOpen();
        return this.enqueueMutation(async () => {
            const serverName = normalizeServerName(name);
            if (this.isBuiltinMatrixServerName(serverName))
                return false;
            const file = await this.readFileWithinMutation(true);
            const current = file.mcpServers[serverName];
            if (!current)
                return false;
            file.mcpServers[serverName] = {
                ...current,
                enabled: false,
                metadata: {
                    ...(current.metadata ?? {}),
                    disabledBy: 'user',
                },
            };
            await this.writeConfiguredMutation(serverName, file);
            return true;
        });
    }
    async getServerConfig(name, context) {
        this.assertOpen();
        const file = await this.readEffectiveFile(context);
        return file.mcpServers[normalizeServerName(name)];
    }
    async getAuthStatus() {
        this.assertOpen();
        const file = this.withBuiltinServers(await this.readFile());
        return this.serverAuth.legacyStatuses(file.mcpServers);
    }
    /** Old single-server entry: starts OAuth for a user `mcp.json` server only. */
    async startAuth(server) {
        this.assertOpen();
        const config = (await this.readFile()).mcpServers[server];
        if (!config) {
            return { ok: false, status: 'not_found', error: `MCP server "${server}" not found` };
        }
        return this.serverAuth.startLegacy(server, config);
    }
    async sync() {
        this.assertOpen();
        this.syncState = 'SYNCING';
        this.lastSyncError = undefined;
        try {
            const servers = await this.listServers();
            const total = servers.length;
            this.syncState = 'SYNC_DONE';
            return {
                state: this.syncState,
                progress: { total, done: total, failed: 0 },
            };
        }
        catch (err) {
            this.syncState = 'SYNC_ERROR';
            this.lastSyncError = err instanceof Error ? err.message : String(err);
            return {
                state: this.syncState,
                progress: { total: 0, done: 0, failed: 1 },
                error: this.lastSyncError,
            };
        }
    }
    getSyncStatus() {
        this.assertOpen();
        return {
            state: this.syncState,
            ...(this.lastSyncError ? { error: this.lastSyncError } : {}),
        };
    }
    async listTools(server, context) {
        this.assertOpen();
        const config = await this.getServerConfig(server, context);
        return config ? readConfiguredTools(config) : [];
    }
    /**
     * Query the MCP server for its live tool list via the connection pool.
     * Returns the projected `mcp.json` view when no pool is configured or the
     * server has no usable transport.
     */
    async listToolsLive(server, context) {
        return (await this.serverAuth.listToolsLive(server, context)).tools;
    }
    async listNativeTools(context) {
        this.assertOpen();
        const file = await this.readEffectiveFile(context);
        const invalidNames = this.reserveRuntimeServerNames(file, context);
        const out = [];
        for (const [server, config] of Object.entries(file.mcpServers)) {
            if (config.enabled === false || invalidNames.has(server))
                continue;
            if (!hasLocalCallAdapter(config))
                continue;
            const isBuiltinMatrix = isBuiltinMatrixConfig(server, config);
            const rawTools = isBuiltinMatrix && !context
                ? readConfiguredTools(config)
                : await this.listToolsLive(server, context);
            out.push(...this.toNativeToolInfos(server, config, rawTools, context));
        }
        return out;
    }
    async listNativeToolsForTurn(context) {
        this.assertOpen();
        const file = await this.readEffectiveFile(context);
        const invalidNames = this.reserveRuntimeServerNames(file, context);
        const discovered = await Promise.all(Object.entries(file.mcpServers).map(async ([server, config]) => {
            if (config.enabled === false || invalidNames.has(server) || !hasLocalCallAdapter(config))
                return [];
            const isBuiltinMatrix = isBuiltinMatrixConfig(server, config);
            const rawTools = isBuiltinMatrix && !context
                ? readConfiguredTools(config)
                : await this.listToolsForTurn(server, config, context);
            return this.toNativeToolInfos(server, config, rawTools, context);
        }));
        return discovered.flat();
    }
    runtimeToolsFromNative(nativeTools, context) {
        this.assertOpen();
        return nativeTools.map((tool) => {
            const def = {
                name: tool.nativeName,
                description: tool.description ?? `Call MCP tool ${tool.toolName} on local MCP server ${tool.server}.`,
                schema: toTypeSchema(tool.inputSchema),
            };
            return {
                def,
                impl: {
                    execute: async (_ctx, input, signal) => {
                        if (signal?.aborted) {
                            throw new Error(`MCP tool aborted: ${tool.server}/${tool.toolName}`);
                        }
                        // Forward the pi turn signal into the pool so abort during a
                        // long-running remote MCP call (e.g. built-in matrix generation
                        // tools) unblocks the tool immediately instead of waiting for the
                        // per-server timeout to fire.
                        const result = await this.call(tool.server, tool.toolName, readRecord(input) ?? {}, {
                            context,
                            signal,
                        });
                        const mapped = mapMcpContent(result);
                        // PTC-only payload (structuredContent as data, raw protocol error) rides along.
                        return withMcpProgrammatic(result, {
                            tool_name: def.name,
                            text: mapped.text,
                            content: mapped.content,
                            ...(result.isError !== undefined ? { isError: result.isError } : {}),
                            details: { mcp: result, server: tool.server, tool: tool.toolName },
                            output: { mcp: result },
                        });
                    },
                },
                source: tool.source,
            };
        });
    }
    async listRuntimeTools(context) {
        this.assertOpen();
        return this.runtimeToolsFromNative(await this.listNativeTools(context), context);
    }
    async listToolsForTurn(server, config, context) {
        const pool = this.options.connectionPool;
        const transport = configToTransportConfig(config);
        if (!pool || !transport)
            return [];
        const turnDiscoveryTimeoutMs = this.options.turnDiscoveryTimeoutMs ?? 2_000;
        const discoveryTimeoutMs = transport.type === 'stdio'
            ? (this.options.turnStdioDiscoveryTimeoutMs ??
                this.options.turnDiscoveryTimeoutMs ??
                stdioDiscoveryTimeoutFromEnv())
            : turnDiscoveryTimeoutMs;
        const timeoutMs = Math.min(configuredTimeout(config), discoveryTimeoutMs);
        const controller = new AbortController();
        try {
            const tools = await this.serverAuth.connect({ server, config, context }, { background: true, announce: true, timeoutMs, onTimeout: () => controller.abort() }, (overrides) => pool.listTools(server, overrides, {
                signal: this.connectionSignal(config, controller.signal),
                timeout: timeoutMs,
            }));
            this.recordPublicRuntimeSuccess(server, context, config);
            return tools;
        }
        catch (error) {
            this.recordPublicRuntimeFailure(server, context, authFailureMessage(error) ??
                (error instanceof ConfiguredMcpConnectionTimeoutError
                    ? CONNECTION_TIMEOUT_ERROR
                    : CONNECTION_FAILED_ERROR), config);
            return [];
        }
    }
    toNativeToolInfos(server, config, rawTools, context) {
        return projectNativeTools({
            server,
            config,
            rawTools,
            registry: this.getRuntimeNameRegistry(),
            matrixWebSearchOnly: this.isBuiltinMatrixWebSearchOnly(),
            onError: (error) => this.recordPublicRuntimeFailure(server, context, error, config),
        });
    }
    reserveRuntimeServerNames(file, context) {
        return reserveConfiguredServerNames(this.getRuntimeNameRegistry(), file.mcpServers, (server, error) => this.recordPublicRuntimeFailure(server, context, error, file.mcpServers[server]));
    }
    async call(server, toolName, args, options = {}) {
        const { context } = options;
        this.assertOpen();
        const config = await this.getServerConfig(server, context);
        if (!config || config.enabled === false) {
            return {
                isError: true,
                content: [{ type: 'text', text: `MCP server "${server}" is not enabled.` }],
            };
        }
        const configuredTool = readConfiguredTools(config).find((item) => item.name === toolName);
        const live = configuredTool ? undefined : await this.serverAuth.listToolsLive(server, context);
        const tool = configuredTool ?? live?.tools.find((item) => item.name === toolName);
        if (!tool) {
            return (this.serverAuth.callFailure(live?.authError) ?? {
                isError: true,
                content: [{ type: 'text', text: `MCP tool "${toolName}" not found on "${server}".` }],
            });
        }
        const mockResponses = readRecord(config.metadata?.['mockResponses']);
        const key = toolName;
        const mocked = readRecord(mockResponses?.[key]);
        if (mocked)
            return normalizeCallResult(mocked);
        return this.callLive(server, config, { ...options, toolName, args });
    }
    async callLive(server, config, input) {
        const { toolName, args, context, signal } = input;
        // Live path: route through the injected connection pool when configured.
        const pool = this.options.connectionPool;
        if (pool) {
            const transport = configToTransportConfig(config);
            if (!transport) {
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: `MCP server "${server}" has no usable transport (need command for stdio or url for ` +
                                'http/sse).',
                        },
                    ],
                };
            }
            try {
                const result = await this.serverAuth.connect({ server, config, context }, { background: true, announce: true }, (overrides) => pool.callTool(server, toolName, args, overrides, {
                    ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
                    signal: this.connectionSignal(config, signal),
                }));
                this.recordPublicRuntimeSuccess(server, context, config);
                return result;
            }
            catch (err) {
                // An abort that never reached the server is the caller's, not a server failure.
                if (err instanceof McpToolCallNotDispatchedError)
                    throw err;
                this.recordPublicRuntimeFailure(server, context, authFailureMessage(err) ?? CONNECTION_FAILED_ERROR, config);
                return this.serverAuth.callFailure(err) ?? localMcpCallFailureResult(err);
            }
        }
        return {
            isError: true,
            content: [
                {
                    type: 'text',
                    text: `Local MCP server "${server}" is registered natively, but no local connection ` +
                        'adapter is configured for this minimal clean-runtime MCP call path.',
                },
            ],
        };
    }
    /** Mini App tool port only; the Agent path is `call`. See `callLocalMcpToolUnfolded`. */
    callForMiniApp(input) {
        return callLocalMcpToolUnfolded(this, input, {
            pool: this.options.connectionPool,
            overrides: (config) => this.serverAuth.authorizedOverrides(input.server, config),
            signal: (config) => this.connectionSignal(config, input.signal),
            recorded: (config) => this.recordPublicRuntimeSuccess(input.server, undefined, config),
        });
    }
    /**
     * `McpServerLookup` view onto this service for the connection pool.
     * Returns null for unknown / unparseable / disabled servers so the pool
     * fails closed.
     */
    getServerLookup() {
        this.assertOpen();
        return {
            getResolvedServer: (serverName) => {
                const file = this.withBuiltinServers(this.readFileSyncSafe());
                const normalizedServerName = normalizeServerName(serverName);
                const config = file.mcpServers[normalizedServerName];
                if (!config || config.enabled === false)
                    return null;
                const transport = configToTransportConfig(config);
                if (!transport)
                    return null;
                return {
                    name: normalizedServerName,
                    transport,
                    enabled: true,
                    ...(config.timeout && config.timeout > 0 ? { timeout: config.timeout } : {}),
                };
            },
        };
    }
    readFileSyncSafe() {
        // The pool's `getResolvedServer` is invoked synchronously from connect
        // path; we cache nothing here yet, so do a cheap re-read using the same
        // async helper but capture in a holder. To avoid blocking, we accept that
        // the pool will call us at connect-time (already an async path), so this
        // is fine to be sync-style by returning the cached parse from the most
        // recent async readFile call.
        return this.lastReadFile ?? { mcpServers: {} };
    }
    withBuiltinServers(file, context) {
        if (!this.isBuiltinMatrixEnabled())
            return file;
        const matrix = buildBuiltinMatrixServerConfig({ ...(context ?? {}), dataDir: this.dataDir() }, { webSearchOnly: this.isBuiltinMatrixWebSearchOnly() });
        return {
            ...file,
            mcpServers: {
                ...file.mcpServers,
                [BUILTIN_MATRIX_SERVER_NAME]: matrix,
            },
        };
    }
    isBuiltinMatrixEnabled() {
        return this.options.builtinMatrix?.enabled === true && !!this.options.connectionPool;
    }
    isBuiltinMatrixWebSearchOnly() {
        return this.isBuiltinMatrixEnabled() && this.options.builtinMatrix?.webSearchOnly === true;
    }
    isBuiltinMatrixServerName(serverName) {
        return (this.isBuiltinMatrixEnabled() &&
            normalizeServerName(serverName) === BUILTIN_MATRIX_SERVER_NAME);
    }
    async resolveConnectionOverrides(server, config, context, authorizer) {
        if (context?.sessionId && this.isSessionServer(server, context)) {
            return this.sessionServers.overrides(context.sessionId, server, config);
        }
        const project = this.projectMcp.overrides(config);
        if (project)
            return authorizer ? { ...project, authorizer } : project;
        const base = context === undefined
            ? await this.options.resolveTokenOverrides?.(server, config)
            : await this.options.resolveTokenOverrides?.(server, config, context);
        if (!isBuiltinMatrixConfig(server, config)) {
            return authorizer ? { ...base, authorizer } : (base ?? undefined);
        }
        return matrixTokenOverrides(this.dataDir(), base, context);
    }
    connectionSignal(config, signal) {
        const project = this.projectMcp.signal(config);
        return AbortSignal.any([
            this.shutdownSignal.signal,
            ...(signal ? [signal] : []),
            ...(project ? [project] : []),
        ]);
    }
    unavailableReason(config) {
        const hasMockAdapter = Boolean(readRecord(config.metadata?.['mockResponses']));
        if (!configToTransportConfig(config) && !hasMockAdapter) {
            return 'MCP server transport is incomplete. Configure a command or URL and retry.';
        }
        if (!this.options.connectionPool && !hasMockAdapter) {
            return 'MCP connection support is unavailable in this Runtime.';
        }
        return undefined;
    }
    nowMs() {
        return this.options.nowMs?.() ?? Date.now();
    }
    async readEffectiveFile(context) {
        const base = this.withBuiltinServers(await this.readFile(), context);
        const project = await this.enqueueMutation(() => this.projectMcp.resolve(context));
        const session = context?.sessionId ? this.sessionServers.get(context.sessionId) : undefined;
        return { mcpServers: { ...base.mcpServers, ...project, ...session } };
    }
    filePath() {
        return join(this.dataDir(), 'mcp.json');
    }
    async readRawDocument() {
        try {
            const parsed = JSON.parse(await readFile(this.filePath(), 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return { document: {}, servers: {} };
            }
            const document = parsed;
            const rawServers = readRecord(document['mcpServers']) ?? {};
            return { document, servers: rawServers };
        }
        catch {
            return { document: {}, servers: {} };
        }
    }
    normalizeRawServers(servers) {
        const normalized = {};
        for (const [name, rawConfig] of Object.entries(servers)) {
            const rawConfigObject = readRecord(rawConfig);
            if (!rawConfigObject)
                continue;
            const serverName = normalizeServerName(name);
            const config = normalizeServerConfig(rawConfigObject);
            if (!isRetiredLegacyMatrixMcpServerConfig(serverName, config) &&
                !(isBuiltinMatrixConfig(serverName, config) && !this.isBuiltinMatrixEnabled()) &&
                !isRetiredLegacyCuMcpServerConfig(serverName, config) &&
                !(serverName === 'nd' && config.builtin === true)) {
                normalized[serverName] = config;
            }
        }
        return { mcpServers: normalized };
    }
    readFile(failClosed = false) {
        // Reads can persist retired-server cleanup, so read the latest document inside
        // the same queue as explicit writes. Mutations use the inner method to avoid re-entry.
        return this.enqueueMutation(() => this.readFileWithinMutation(failClosed));
    }
    async readFileWithinMutation(failClosed = false) {
        const pending = readLocalMcpFile(this.filePath(), failClosed, this.serverAuth.ignoreLegacyAuth);
        this.pendingReads.add(pending);
        try {
            const file = await pending;
            this.lastReadFile = this.isBuiltinMatrixEnabled()
                ? file
                : {
                    ...file,
                    mcpServers: Object.fromEntries(Object.entries(file.mcpServers).filter(([name, config]) => !isBuiltinMatrixConfig(name, config))),
                };
            return this.lastReadFile;
        }
        catch (error) {
            this.lastReadFile = { mcpServers: {} };
            throw error;
        }
        finally {
            this.pendingReads.delete(pending);
        }
    }
    async writeFile(file) {
        await writeLocalMcpFile(this.filePath(), file);
        this.lastReadFile = file;
    }
    async writeRawDocument(document) {
        await writeLocalMcpRawDocument(this.filePath(), document);
    }
    async writeConfiguredMutation(serverName, file) {
        await this.options.connectionPool?.disconnect(serverName);
        await this.writeFile(file);
        await this.options.connectionPool?.disconnect(serverName);
        this.resetPublicRuntimeStatus(serverName);
        this.notifyServerChangeListeners();
    }
    recordPublicRuntimeSuccess(serverName, context, config) {
        if (this.isSessionServer(serverName, context))
            return;
        if (this.projectMcp.record(config))
            return;
        const normalized = normalizeServerName(serverName);
        this.publicRuntimeErrors.delete(normalized);
        this.publiclyAvailableServers.add(normalized);
    }
    recordPublicRuntimeFailure(serverName, context, error, config) {
        if (this.isSessionServer(serverName, context))
            return;
        if (this.projectMcp.record(config, error))
            return;
        const normalized = normalizeServerName(serverName);
        this.publiclyAvailableServers.delete(normalized);
        this.publicRuntimeErrors.set(normalized, error);
    }
    isSessionServer(serverName, context) {
        return Boolean(context?.sessionId &&
            this.sessionServers.get(context.sessionId)?.[normalizeServerName(serverName)]);
    }
    resetPublicRuntimeStatus(serverName) {
        const normalized = normalizeServerName(serverName);
        this.publicRuntimeErrors.delete(normalized);
        this.publiclyAvailableServers.delete(normalized);
    }
    notifyServerChangeListeners() {
        for (const listener of this.serverChangeListeners)
            listener();
    }
    enqueueMutation(operation) {
        const previous = this.mutationQueue;
        const result = (async () => {
            await previous;
            return operation();
        })();
        this.mutationQueue = (async () => {
            try {
                await result;
            }
            catch {
                /* Keep admission queue usable after failure. */
            }
        })();
        return result;
    }
}
//# sourceMappingURL=local-mcp.service.js.map