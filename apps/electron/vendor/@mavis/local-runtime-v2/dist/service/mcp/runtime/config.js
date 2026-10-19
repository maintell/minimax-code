import { buildMcpToolRuntimeName } from '@mavis/mcp';
import { isBuiltinMatrixConfig } from './builtin-matrix.js';
export function hasLocalCallAdapter(config) {
    return !!readRecord(config.metadata?.['mockResponses']) || !!configToTransportConfig(config);
}
/**
 * Map an mcp.json server config onto the runtime `TransportConfig`. Returns
 * undefined if the entry has neither a command (stdio) nor a url (http/sse),
 * so the caller can fail closed.
 */
export function configToTransportConfig(config) {
    const type = config.type;
    if (type === 'stdio' || (!type && config.command)) {
        if (!config.command)
            return undefined;
        return {
            type: 'stdio',
            command: config.command,
            args: config.args ?? [],
            ...(config.env ? { env: config.env } : {}),
        };
    }
    return remoteTransport(config);
}
function remoteTransport(config) {
    const type = config.type;
    if (type === 'sse' && config.url)
        return { type: 'sse', url: config.url, ...(config.headers ? { headers: config.headers } : {}) };
    if (type === 'http' || type === 'streamable-http' || (!type && config.url)) {
        if (!config.url)
            return undefined;
        return {
            type: 'http',
            url: config.url,
            ...(config.headers ? { headers: config.headers } : {}),
        };
    }
    return undefined;
}
/** Configuration keys are identities; normalize only their model-visible projection. */
export function normalizeServerName(name) {
    return name;
}
export function normalizeServerConfig(config) {
    return {
        ...(readString(config['command']) ? { command: readString(config['command']) } : {}),
        ...(Array.isArray(config['args'])
            ? { args: config['args'].filter((item) => typeof item === 'string') }
            : {}),
        ...(readRecord(config['env']) ? { env: readStringRecord(config['env']) } : {}),
        ...(readString(config['url']) ? { url: readString(config['url']) } : {}),
        ...(readTransport(config['type']) ? { type: readTransport(config['type']) } : {}),
        ...(readRecord(config['auth']) ? { auth: readRecord(config['auth']) } : {}),
        enabled: config['enabled'] !== false,
        configured: config['configured'] !== false,
        builtin: config['builtin'] === true,
        ...normalizeServerMetadata(config),
    };
}
function normalizeServerMetadata(config) {
    return {
        ...(readString(config['description'])
            ? { description: readString(config['description']) }
            : {}),
        ...(typeof config['timeout'] === 'number' ? { timeout: config['timeout'] } : {}),
        ...(readRecord(config['metadata']) ? { metadata: readRecord(config['metadata']) } : {}),
        ...(readRecord(config['headers']) ? { headers: readStringRecord(config['headers']) } : {}),
        ...(Array.isArray(config['tools']) ? { tools: normalizeTools(config['tools']) } : {}),
    };
}
export function readConfiguredTools(config) {
    const fromMetadata = Array.isArray(config.metadata?.['tools'])
        ? normalizeTools(config.metadata['tools'])
        : [];
    return normalizeTools([...(config.tools ?? []), ...fromMetadata]);
}
export function inferTransport(config) {
    if (config.type)
        return config.type;
    if (config.url)
        return 'http';
    if (config.command)
        return 'stdio';
    return 'none';
}
export function inferAuthStatus(config) {
    if (!config.auth)
        return 'none';
    if (readString(config.auth['token']) || readString(config.auth['accessToken'])) {
        return 'authenticated';
    }
    if (config.auth['type'] === 'oauth2')
        return 'pending_auth';
    return 'configured';
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}
export function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
export function readStringArray(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === 'string')
        : undefined;
}
export function buildNativeToolName(server, tool, config) {
    if (isBuiltinMatrixConfig(server, config)) {
        return tool.replace(/[^a-zA-Z0-9_]/gu, '_').slice(0, 80);
    }
    return buildMcpToolRuntimeName(server, tool);
}
function normalizeTools(value) {
    return value.flatMap((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return [];
        const record = raw;
        const name = readString(record['name']);
        if (!name)
            return [];
        return [
            {
                name,
                ...(readString(record['description'])
                    ? { description: readString(record['description']) }
                    : {}),
                inputSchema: readRecord(record['inputSchema']) ?? readRecord(record['input_schema']) ?? {},
            },
        ];
    });
}
function readStringRecord(value) {
    const record = readRecord(value) ?? {};
    return Object.fromEntries(Object.entries(record).filter((entry) => typeof entry[1] === 'string'));
}
function readTransport(value) {
    return value === 'stdio' || value === 'http' || value === 'sse' || value === 'streamable-http'
        ? value
        : undefined;
}
//# sourceMappingURL=config.js.map