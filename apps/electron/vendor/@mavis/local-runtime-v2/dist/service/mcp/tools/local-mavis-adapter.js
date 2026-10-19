import { LocalMcpSettingsError } from '../errors.js';
export class LocalMavisMcpServiceAdapter {
    service;
    emitBusEvent;
    constructor(service, emitBusEvent) {
        this.service = service;
        this.emitBusEvent = emitBusEvent;
    }
    async listServers(req, signal) {
        throwIfAborted(signal);
        const servers = await this.service.listConfiguredServers(req.search);
        return {
            servers: servers.map(({ configJson: _configJson, ...server }) => server),
        };
    }
    async getServer(req, signal) {
        throwIfAborted(signal);
        const server = await this.service.getConfiguredServer(req.name);
        return server ? { server: toSafeServer(server) } : {};
    }
    async createServer(req, signal) {
        throwIfAborted(signal);
        const server = await this.service.createConfiguredServer(req.name, createInput(req), req.enabled ?? true);
        this.emitChanged('create', req.name);
        return { server: toSafeServer(server) };
    }
    async updateServer(req, signal) {
        throwIfAborted(signal);
        const current = await this.service.getConfiguredServer(req.name);
        if (!current) {
            throw new LocalMcpSettingsError(404, 'MCP server not found.', 'MCP_SERVER_NOT_FOUND');
        }
        const config = mergeInput(current.config, req);
        const server = await this.service.updateConfiguredServer(req.name, config, req.enabled);
        this.emitChanged('update', req.name);
        return { server: toSafeServer(server) };
    }
    async deleteServer(req, signal) {
        throwIfAborted(signal);
        const success = await this.service.deleteConfiguredServer(req.name);
        this.emitChanged('delete', req.name);
        return { success };
    }
    emitChanged(operation, name) {
        this.emitBusEvent('mcp.settings.changed', { operation, name });
    }
}
function createInput(req) {
    const common = {
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.description !== undefined ? { description: req.description } : {}),
    };
    if (req.transport === 'stdio') {
        if (!req.command)
            throw invalidConfig('A command is required for stdio MCP servers.');
        return {
            transport: 'stdio',
            command: req.command,
            ...(req.args !== undefined ? { args: req.args } : {}),
            ...(req.env !== undefined ? { env: req.env } : {}),
            ...common,
        };
    }
    if (!req.url)
        throw invalidConfig('A URL is required for remote MCP servers.');
    return {
        transport: req.transport,
        url: req.url,
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...common,
    };
}
function mergeInput(current, patch) {
    const transport = patch.transport ?? current.transport;
    if (transport !== current.transport)
        return createInputForTransportSwitch(transport, patch);
    const timeoutMs = resolveTimeoutMs(current.timeoutMs, patch);
    const description = resolveDescription(current.description, patch);
    const common = {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(description !== undefined ? { description } : {}),
    };
    return mergeTransportInput(current, patch, common);
}
function mergeTransportInput(current, patch, common) {
    if (current.transport === 'stdio') {
        if (patch.url !== undefined || patch.headers !== undefined) {
            throw invalidConfig('stdio MCP servers do not accept remote fields.');
        }
        return {
            transport: 'stdio',
            command: patch.command ?? current.command,
            ...optionalField('args', patch.args !== undefined ? patch.args : current.args),
            ...optionalField('env', patch.env !== undefined ? patch.env : current.env),
            ...common,
        };
    }
    if (hasStdioFields(patch)) {
        throw invalidConfig('Remote MCP servers do not accept stdio fields.');
    }
    return {
        transport: current.transport,
        url: patch.url ?? current.url,
        ...optionalField('headers', patch.headers !== undefined ? patch.headers : current.headers),
        ...common,
    };
}
function createInputForTransportSwitch(transport, patch) {
    if (transport === 'stdio')
        return switchToStdio(patch);
    if (!patch.url?.trim())
        throw invalidConfig('Switching to a remote transport requires a URL.');
    if (hasStdioFields(patch)) {
        throw invalidConfig('Remote MCP servers do not accept stdio fields.');
    }
    return {
        transport,
        url: patch.url,
        ...(patch.headers !== undefined ? { headers: patch.headers } : {}),
        ...switchCommon(patch),
    };
}
function resolveTimeoutMs(current, patch) {
    if (!Object.hasOwn(patch, 'timeoutMs'))
        return current;
    return patch.timeoutMs ?? undefined;
}
function resolveDescription(current, patch) {
    if (!Object.hasOwn(patch, 'description'))
        return current;
    return patch.description ?? undefined;
}
function toSafeServer(server) {
    const common = {
        name: server.name,
        enabled: server.enabled,
    };
    if (server.config.transport === 'stdio') {
        return {
            ...common,
            config: {
                transport: 'stdio',
                command: server.config.command,
                ...(server.config.args !== undefined ? { args: server.config.args } : {}),
                ...(server.config.env !== undefined
                    ? { envKeys: Object.keys(server.config.env).sort() }
                    : {}),
                ...(server.config.timeoutMs !== undefined ? { timeoutMs: server.config.timeoutMs } : {}),
                ...(server.config.description !== undefined
                    ? { description: server.config.description }
                    : {}),
            },
        };
    }
    return {
        ...common,
        config: {
            transport: server.config.transport,
            endpoint: safeEndpoint(server.config.url),
            ...(server.config.headers !== undefined
                ? { headerKeys: Object.keys(server.config.headers).sort() }
                : {}),
            ...(server.config.timeoutMs !== undefined ? { timeoutMs: server.config.timeoutMs } : {}),
            ...(server.config.description !== undefined
                ? { description: server.config.description }
                : {}),
        },
    };
}
function safeEndpoint(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return '';
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
}
function invalidConfig(message) {
    return new LocalMcpSettingsError(400, message, 'MCP_CONFIG_INVALID');
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw new DOMException('Operation aborted', 'AbortError');
}
function switchToStdio(patch) {
    if (!patch.command?.trim())
        throw invalidConfig('Switching to stdio requires a command.');
    if (patch.url !== undefined || patch.headers !== undefined)
        throw invalidConfig('stdio MCP servers do not accept remote fields.');
    return {
        transport: 'stdio',
        command: patch.command,
        ...optionalField('args', patch.args),
        ...optionalField('env', patch.env),
        ...switchCommon(patch),
    };
}
function switchCommon(patch) {
    return {
        ...(patch.timeoutMs !== undefined && patch.timeoutMs !== null
            ? { timeoutMs: patch.timeoutMs }
            : {}),
        ...(patch.description !== undefined && patch.description !== null
            ? { description: patch.description }
            : {}),
    };
}
function optionalField(key, value) {
    return value === undefined ? {} : { [key]: value };
}
function hasStdioFields(patch) {
    return patch.command !== undefined || patch.args !== undefined || patch.env !== undefined;
}
//# sourceMappingURL=local-mavis-adapter.js.map