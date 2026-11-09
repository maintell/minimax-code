import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { mcpConnectionFingerprint, } from '../oauth/index.js';
import { configToTransportConfig } from '../runtime/config.js';
import { assertOAuthHeaderExclusive, hasAuthorizationHeader, parseMcpOAuthConfig, } from './oauth-config.js';
/**
 * Binding of a user `mcp.json` remote server. Undefined for stdio. Throws
 * `McpOAuthConfigError` when its `oauth` block is invalid for that server only.
 */
export function userAuthBinding(serverName, config, dataDir) {
    const serverUrl = remoteUrl(config);
    if (!serverUrl)
        return undefined;
    const oauth = config.oauth === undefined ? undefined : parseMcpOAuthConfig(config.oauth, 'user');
    assertOAuthHeaderExclusive(oauth, config.headers);
    return {
        target: { kind: 'user', serverName },
        namespace: 'user',
        serverUrl,
        ...(oauth ? { oauth } : {}),
        redirectFormat: 'default',
        staticAuthorization: hasAuthorizationHeader(config.headers),
        trust: 'trusted',
        privateNetwork: 'allow',
        sourceLabel: displayPath(join(dataDir, 'mcp.json')),
        userClientSecretKey: serverName,
        connectionFingerprint: mcpConnectionFingerprint({ url: serverUrl, headers: config.headers }),
    };
}
/** Project servers are repository-owned: confirmation first, no private network endpoints. */
export function projectAuthBinding(source, config) {
    const serverUrl = remoteUrl(config);
    if (!serverUrl)
        return undefined;
    const oauth = config.oauth === undefined ? undefined : parseMcpOAuthConfig(config.oauth, 'project');
    return {
        target: {
            kind: 'project',
            serverName: source.serverName,
            sessionId: source.sessionId,
            workspaceRoot: source.workspaceRoot,
        },
        namespace: `project:${source.realRoot}`,
        serverUrl,
        ...(oauth ? { oauth } : {}),
        redirectFormat: 'default',
        staticAuthorization: hasAuthorizationHeader(config.headers),
        trust: 'confirm',
        privateNetwork: 'deny',
        sourceLabel: source.configPath,
        connectionFingerprint: mcpConnectionFingerprint({ url: serverUrl, headers: config.headers }),
    };
}
/** Explicit copy so only public identity fields reach events and wire responses. */
export function publicAuthTarget(target) {
    if (target.kind === 'user')
        return { kind: 'user', serverName: target.serverName };
    if (target.kind === 'project') {
        return {
            kind: 'project',
            serverName: target.serverName,
            sessionId: target.sessionId,
            workspaceRoot: target.workspaceRoot,
        };
    }
    return {
        kind: 'plugin',
        serverName: target.serverName,
        pluginName: target.pluginName,
        pluginMarketplace: target.pluginMarketplace,
        pluginSource: target.pluginSource,
    };
}
/** Old wire `auth_status` projection (plan §6.5). */
export function legacyAuthStatus(state) {
    if (state === 'unknown' || state === 'not_required')
        return 'none';
    if (state === 'static')
        return 'configured';
    if (state === 'authorized')
        return 'authenticated';
    return 'pending_auth';
}
function remoteUrl(config) {
    const transport = configToTransportConfig(config);
    return transport && transport.type !== 'stdio' ? transport.url : undefined;
}
function displayPath(path) {
    const home = homedir();
    const child = relative(home, path);
    return child && !child.startsWith('..') && !isAbsolute(child) ? join('~', child) : path;
}
//# sourceMappingURL=bindings.js.map