import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LocalMcpSettingsError } from '../errors.js';
import { readRecord, normalizeServerName, normalizeServerConfig } from './config.js';
import { isRetiredLegacyMatrixMcpServerConfig } from './builtin-matrix.js';
import { isRetiredLegacyCuMcpServerConfig } from './retired-cu.js';
import { assertStoredMcpServerConfig, replacementFileMode } from './settings-config.js';
export async function readLocalMcpFile(filePath, failClosed = false) {
    let lastReadFile;
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            if (failClosed)
                throw new SyntaxError('MCP configuration root must be an object.');
            lastReadFile = { mcpServers: {} };
            return lastReadFile;
        }
        const root = parsed;
        const { normalized, retiredLegacyServer } = normalizeDocument(root, failClosed);
        lastReadFile = { ...root, mcpServers: normalized };
        if (retiredLegacyServer) {
            // Retirement is best-effort: a failed cleanup must not discard readable servers.
            try {
                await writeLocalMcpFile(filePath, lastReadFile);
            }
            catch {
                /* Retirement remains best-effort. */
            }
        }
        return lastReadFile;
    }
    catch (error) {
        const code = error.code;
        if (failClosed && code !== 'ENOENT') {
            lastReadFile = { mcpServers: {} };
            throw new LocalMcpSettingsError(500, 'The MCP configuration could not be read safely.', 'MCP_STORAGE_READ_FAILED');
        }
        lastReadFile = { mcpServers: {} };
        return lastReadFile;
    }
}
export async function writeLocalMcpFile(filePath, file) {
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    let handle;
    try {
        const targetMode = await replacementFileMode(filePath);
        handle = await fs.promises.open(tempPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
        await handle.sync();
        if (process.platform !== 'win32')
            await handle.chmod(targetMode);
        await handle.close();
        handle = undefined;
        await fs.promises.rename(tempPath, filePath);
    }
    catch {
        try {
            await handle?.close();
        }
        catch {
            /* Preserve storage error. */
        }
        try {
            await fs.promises.unlink(tempPath);
        }
        catch {
            /* Preserve storage error. */
        }
        throw new LocalMcpSettingsError(500, 'The MCP configuration could not be saved.', 'MCP_STORAGE_WRITE_FAILED');
    }
}
function normalizeDocument(root, failClosed) {
    const rawServers = root['mcpServers'];
    const servers = readRecord(rawServers);
    if (failClosed && rawServers !== undefined && !servers) {
        throw new SyntaxError('MCP configuration mcpServers must be an object.');
    }
    const normalized = {};
    const normalizedNames = new Set();
    let retiredLegacyServer = false;
    for (const [name, config] of Object.entries(servers ?? {})) {
        const rawConfig = validateEntry(config, failClosed);
        if (!rawConfig)
            continue;
        const serverName = normalizeServerName(name);
        if (failClosed && normalizedNames.has(serverName))
            throw new SyntaxError('MCP server names must remain unique after normalization.');
        normalizedNames.add(serverName);
        const normalizedConfig = {
            ...rawConfig,
            ...normalizeServerConfig(rawConfig),
        };
        if (isRetiredServer(serverName, normalizedConfig)) {
            retiredLegacyServer = true;
            continue;
        }
        normalized[serverName] = normalizedConfig;
    }
    return { normalized, retiredLegacyServer };
}
function validateEntry(config, failClosed) {
    const rawConfig = readRecord(config);
    if (!rawConfig) {
        if (failClosed)
            throw new SyntaxError('MCP server entries must be objects.');
        return undefined;
    }
    if (failClosed)
        assertStoredMcpServerConfig(rawConfig);
    return rawConfig;
}
function isRetiredServer(name, config) {
    return (isRetiredLegacyMatrixMcpServerConfig(name, config) ||
        isRetiredLegacyCuMcpServerConfig(name, config) ||
        (name === 'nd' && config.builtin === true));
}
//# sourceMappingURL=configuration.repository.js.map