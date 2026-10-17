import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeServerName, readRecord } from './config.js';
export async function readConfiguredMcpServerNames(dataDir) {
    const nameSets = await Promise.all([join(dataDir, 'mcp.json'), join(dataDir, 'mcp', 'mcp.json')].map(readMcpServerNamesFile));
    return new Set(nameSets.flatMap((names) => [...names]));
}
async function readMcpServerNamesFile(filePath) {
    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        const servers = readRecord(readRecord(parsed)?.['mcpServers']);
        return new Set(Object.entries(servers ?? {}).flatMap(([name, server]) => readRecord(server) ? [normalizeServerName(name)] : []));
    }
    catch {
        return new Set();
    }
}
//# sourceMappingURL=config-file.js.map