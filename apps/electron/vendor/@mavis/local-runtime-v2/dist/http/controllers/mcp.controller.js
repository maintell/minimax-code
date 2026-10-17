import { LocalMcpTransport } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError } from '../errors.js';
import { McpControllerBase } from '../generated/mcp-controller-base.gen.js';
export function createMcpController(service, runtime) {
    return new McpController(service, runtime);
}
class McpController extends McpControllerBase {
    service;
    runtime;
    constructor(service, runtime) {
        super();
        this.service = service;
        this.runtime = runtime;
    }
    async listLocalMcpServers(_ctx, req) {
        return this.map(async () => ({
            servers: (await this.requireService().list(req.keyword)).map(toSummary),
        }));
    }
    async getLocalMcpServer(_ctx, req) {
        return this.map(async () => {
            const server = await this.requireService().get(req.serverName);
            if (!server)
                throw new AppError(404, 'MCP_SERVER_NOT_FOUND', 'MCP server was not found');
            return { server: toDetail(server) };
        });
    }
    async createLocalMcpServer(_ctx, req) {
        return this.map(async () => ({
            server: toDetail(await this.requireService().create(req.name, fromWireConfig(req.config), req.enabled ?? true)),
        }));
    }
    async updateLocalMcpServer(_ctx, req) {
        return this.map(async () => ({
            server: toDetail(await this.requireService().update(req.serverName, fromWireConfig(req.config))),
        }));
    }
    async deleteLocalMcpServer(_ctx, req) {
        return this.map(async () => ({ deleted: await this.requireService().delete(req.serverName) }));
    }
    async setLocalMcpServerEnabled(_ctx, req) {
        return this.map(async () => ({
            server: toSummary(await this.requireService().setEnabled(req.serverName, req.enabled)),
        }));
    }
    async testLocalMcpServer(_ctx, req) {
        return this.map(async () => ({ result: await this.requireService().test(req.serverName) }));
    }
    async listLocalMcpRuntimeServers(_ctx, _req) {
        return this.map(async () => {
            const servers = await this.requireRuntime().listServers();
            return { servers, count: servers.length };
        });
    }
    async getLocalMcpRuntimeServer(_ctx, req) {
        return this.map(async () => {
            const config = await this.requireRuntime().getServerConfig(req.serverName);
            if (!config)
                throw new AppError(404, 'MCP_SERVER_NOT_FOUND', 'MCP server was not found');
            return { name: req.serverName, configJson: JSON.stringify(config) };
        });
    }
    async upsertLocalMcpRuntimeServer(_ctx, req) {
        return this.map(async () => ({
            ok: true,
            server: await this.requireRuntime().addServer(req.serverName, parseMcpObject(req.configJson === undefined ? '{}' : req.configJson)),
        }));
    }
    async disableLocalMcpRuntimeServer(_ctx, req) {
        return this.map(async () => {
            const disabled = await this.requireRuntime().disableServer(req.serverName);
            return { ok: disabled, disabled };
        });
    }
    async listLocalMcpRuntimeTools(_ctx, req) {
        return this.map(async () => {
            const tools = (await this.requireRuntime().listTools(req.serverName)).map(toRuntimeWireTool);
            return { server: req.serverName, tools, count: tools.length };
        });
    }
    async getLocalMcpRuntimeTool(_ctx, req) {
        return this.map(async () => {
            const tool = (await this.requireRuntime().listTools(req.serverName)).find((item) => item.name === req.toolName);
            if (!tool)
                throw new AppError(404, 'MCP_TOOL_NOT_FOUND', 'MCP tool was not found');
            return { tool: toRuntimeWireTool(tool) };
        });
    }
    async listLocalMcpRuntimeNativeTools(_ctx, _req) {
        return this.map(async () => ({
            tools: (await this.requireRuntime().listNativeTools()).map((item) => ({
                tool: toRuntimeWireTool(item),
                server: item.server,
                toolName: item.toolName,
                nativeName: item.nativeName,
                transport: item.transport,
                builtin: item.builtin,
                configured: item.configured,
                source: item.source,
            })),
        }));
    }
    async getLocalMcpRuntimeAuthStatus(_ctx, _req) {
        return this.map(async () => ({ servers: await this.requireRuntime().getAuthStatus() }));
    }
    async startLocalMcpRuntimeAuth(_ctx, req) {
        return this.map(() => this.requireRuntime().startAuth(req.serverName));
    }
    async syncLocalMcpRuntimeServers(_ctx, _req) {
        return this.map(async () => ({ ok: true, ...(await this.requireRuntime().sync()) }));
    }
    async getLocalMcpRuntimeSyncStatus(_ctx, _req) {
        return this.map(async () => this.requireRuntime().getSyncStatus());
    }
    async callLocalMcpRuntimeTool(ctx, req) {
        return this.map(async () => {
            if (!req.server.trim() || !req.tool.trim())
                throw new AppError(400, 'MCP_CALL_INVALID', 'MCP server and tool are required');
            const result = await this.requireRuntime().call(req.server, req.tool, parseMcpObject(req.argumentsJson === undefined ? '{}' : req.argumentsJson), { signal: ctx.signal });
            return { resultJson: JSON.stringify(result) };
        });
    }
    requireRuntime() {
        if (!this.runtime)
            throw new AppError(503, 'MCP_UNAVAILABLE', 'MCP runtime unavailable');
        return this.runtime;
    }
    requireService() {
        if (!this.service)
            throw new AppError(503, 'MCP_UNAVAILABLE', 'MCP settings unavailable');
        return this.service;
    }
    async map(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof AppError)
                throw error;
            const code = error.code;
            const status = error.status;
            if (typeof code === 'string' && typeof status === 'number') {
                throw new AppError(status, code, 'MCP operation failed');
            }
            throw new AppError(500, 'INTERNAL_ERROR', 'internal error');
        }
    }
}
function toSummary(server) {
    return {
        name: server.name,
        enabled: server.enabled,
        transport: server.transport,
        ...(server.description ? { description: server.description } : {}),
        ...(server.endpoint ? { endpoint: server.endpoint } : {}),
        configJson: '{}',
    };
}
function toDetail(server) {
    return { name: server.name, enabled: server.enabled, config: toWireConfig(server.config) };
}
function fromWireConfig(config) {
    assertWireConfig(config);
    const common = {
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.description === undefined ? {} : { description: config.description }),
    };
    if (config.transport === LocalMcpTransport.Stdio) {
        return {
            transport: 'stdio',
            command: config.command ?? '',
            ...(config.args ? { args: config.args } : {}),
            ...(config.env ? { env: fromWireKeyValues(config.env, false) } : {}),
            ...common,
        };
    }
    const transport = {
        [LocalMcpTransport.Http]: 'http',
        [LocalMcpTransport.StreamableHttp]: 'streamable-http',
        [LocalMcpTransport.Sse]: 'sse',
    }[config.transport];
    return {
        transport,
        url: config.url ?? '',
        ...(config.headers ? { headers: fromWireKeyValues(config.headers, true) } : {}),
        ...common,
    };
}
function toWireConfig(config) {
    const common = {
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.description === undefined ? {} : { description: config.description }),
    };
    if (config.transport === 'stdio') {
        return {
            transport: LocalMcpTransport.Stdio,
            command: config.command,
            ...(config.args ? { args: [...config.args] } : {}),
            ...(config.env ? { env: toKeyValues(config.env) } : {}),
            ...common,
        };
    }
    return {
        transport: toWireTransport(config.transport),
        url: config.url,
        ...(config.headers ? { headers: toKeyValues(config.headers) } : {}),
        ...common,
    };
}
function toKeyValues(values) {
    return Object.entries(values).map(([key, value]) => ({ key, value }));
}
function fromWireKeyValues(values, caseInsensitive) {
    const seen = new Set();
    for (const { key } of values) {
        const trimmedKey = key.trim();
        const normalizedKey = caseInsensitive ? trimmedKey.toLowerCase() : trimmedKey;
        if (!normalizedKey || seen.has(normalizedKey)) {
            throw new AppError(400, 'MCP_CONFIG_INVALID', 'MCP key-value entries must use unique keys');
        }
        seen.add(normalizedKey);
    }
    return Object.fromEntries(values.map(({ key, value }) => [key, value]));
}
function assertWireConfig(config) {
    if (!isRecord(config) || !isWireTransport(config['transport']))
        invalidWireConfig();
    assertOptionalString(config, 'command');
    assertOptionalString(config, 'url');
    assertOptionalString(config, 'description');
    assertOptionalStringArray(config, 'args');
    assertOptionalKeyValues(config, 'env');
    assertOptionalKeyValues(config, 'headers');
    assertOptionalTimeout(config['timeoutMs']);
    if (config['transport'] === LocalMcpTransport.Stdio) {
        if (typeof config['command'] !== 'string' || !config['command'].trim())
            invalidWireConfig();
        return;
    }
    if (typeof config['url'] !== 'string' || !config['url'].trim())
        invalidWireConfig();
}
function isWireTransport(value) {
    return (value === LocalMcpTransport.Stdio ||
        value === LocalMcpTransport.Http ||
        value === LocalMcpTransport.StreamableHttp ||
        value === LocalMcpTransport.Sse);
}
function assertOptionalString(config, key) {
    if (config[key] !== undefined && typeof config[key] !== 'string')
        invalidWireConfig();
}
function assertOptionalStringArray(config, key) {
    const value = config[key];
    if (value !== undefined &&
        (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) {
        invalidWireConfig();
    }
}
function assertOptionalKeyValues(config, key) {
    const value = config[key];
    if (value === undefined)
        return;
    if (!Array.isArray(value))
        invalidWireConfig();
    for (const item of value) {
        if (!isRecord(item) || typeof item['key'] !== 'string' || typeof item['value'] !== 'string') {
            invalidWireConfig();
        }
    }
}
function assertOptionalTimeout(value) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        invalidWireConfig();
    }
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalidWireConfig() {
    throw new AppError(400, 'MCP_CONFIG_INVALID', 'MCP configuration is invalid');
}
function toWireTransport(transport) {
    return {
        stdio: LocalMcpTransport.Stdio,
        http: LocalMcpTransport.Http,
        'streamable-http': LocalMcpTransport.StreamableHttp,
        sse: LocalMcpTransport.Sse,
    }[transport];
}
function parseMcpObject(json) {
    let value;
    try {
        value = JSON.parse(json);
    }
    catch {
        throw new AppError(400, 'MCP_JSON_INVALID', 'MCP JSON must be an object');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AppError(400, 'MCP_JSON_INVALID', 'MCP JSON must be an object');
    return value;
}
function toRuntimeWireTool(tool) {
    return {
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchemaJson: JSON.stringify(tool.inputSchema),
    };
}
//# sourceMappingURL=mcp.controller.js.map