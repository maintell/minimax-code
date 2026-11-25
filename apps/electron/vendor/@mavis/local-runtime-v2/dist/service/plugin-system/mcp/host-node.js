import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { buildProcessEnv } from '@mavis/mcp';
import { isOfficialStdioServer } from './official-stdio.js';
export function defaultHostNodeFallback(host = process) {
    return {
        execPath: host.execPath,
        isElectron: typeof host.versions.electron === 'string',
        isOnPath: (command, env) => isCommandOnPath(command, buildProcessEnv(env, undefined, host.env, host.platform), host.platform),
    };
}
function resolvePluginStdioServer(entry, fallback) {
    const resolved = entry.server.resolvedServer;
    if (!fallback || !isOfficialStdioServer(entry)) {
        return resolved;
    }
    // The qualification above promised a stdio transport.
    const transport = entry.server.resolvedServer.transport;
    if (transport.command !== 'node' || fallback.isOnPath('node', transport.env)) {
        return resolved;
    }
    return {
        ...resolved,
        transport: {
            ...transport,
            command: fallback.execPath,
            env: {
                ...transport.env,
                ...(fallback.isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
            },
        },
    };
}
/**
 * Caches `resolvePluginStdioServer` per lookup generation. The pool asks for a server on every
 * listTools, callTool and connect, and resolving an official `node` server probes PATH with
 * synchronous stats, so a machine without Node would pay a full PATH scan per tool call. A cached
 * answer belongs to the lifecycle key that produced it: a new key, or `clear` for a replaced
 * lookup generation, resolves again.
 */
export class PluginStdioServerResolver {
    hostNode;
    cache = new Map();
    constructor(hostNode) {
        this.hostNode = hostNode;
    }
    resolve(serverName, entry, lifecycleKey) {
        const cached = this.cache.get(serverName);
        if (cached?.lifecycleKey === lifecycleKey)
            return cached.server;
        const server = resolvePluginStdioServer(entry, this.hostNode);
        this.cache.set(serverName, { lifecycleKey, server });
        return server;
    }
    clear() {
        this.cache.clear();
    }
}
function isCommandOnPath(command, env, platform) {
    const isWindows = platform === 'win32';
    const pathValue = (isWindows ? findEnv(env, 'PATH') : env.PATH) ?? '';
    const extensions = isWindows
        ? (findEnv(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    const separator = isWindows ? ';' : ':';
    for (const directory of pathValue.split(separator)) {
        const dir = directory.trim().replace(/^"(.*)"$/u, '$1');
        if (!dir)
            continue;
        for (const extension of extensions) {
            if (isRunnable(path.join(dir, command + extension), isWindows))
                return true;
        }
    }
    return false;
}
/** Windows environment names are case-insensitive (`Path` is common). */
function findEnv(env, name) {
    const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
}
/** A regular file; on POSIX it must also be executable, as the shell lookup requires. */
function isRunnable(candidate, isWindows) {
    try {
        if (!statSync(candidate).isFile())
            return false;
        if (!isWindows)
            accessSync(candidate, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=host-node.js.map