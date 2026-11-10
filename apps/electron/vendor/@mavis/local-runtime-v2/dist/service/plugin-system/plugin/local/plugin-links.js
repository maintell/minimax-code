import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { samePluginId } from '@mavis/shared';
import { isInstallablePluginId } from './install-directory.js';
/**
 * `${dataDir}/v2/plugin-links.json`. Reads skip malformed records instead of
 * failing a scan; writes replace the file atomically. Callers serialize
 * mutations through the PluginSystem operation queue.
 */
export class PluginLinkRegistry {
    filePath;
    constructor(dataDir) {
        this.filePath = path.join(dataDir, 'v2', 'plugin-links.json');
    }
    async read() {
        let parsed;
        try {
            parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
        }
        catch {
            // Missing or unreadable registry: no linked roots.
            return [];
        }
        if (!Array.isArray(parsed))
            return [];
        const records = [];
        for (const value of parsed) {
            const record = parseRecord(value);
            if (record && !records.some((existing) => samePluginId(existing.id, record.id))) {
                records.push(record);
            }
        }
        return records;
    }
    async write(records) {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.${String(process.pid)}-${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
            await rename(temporary, this.filePath);
        }
        finally {
            await rm(temporary, { force: true });
        }
    }
}
/** Management projection for a registered root that cannot be read. */
export function unavailableLinkedPackage(record, diagnosticCode) {
    const manifest = record.manifest ?? {};
    const description = stringField(manifest.description);
    const version = stringField(manifest.version);
    return {
        source: 'LOCAL_\u0043\u004c\u0041\u0055\u0044\u0045',
        manifestKind: '\u0043\u004c\u0041\u0055\u0044\u0045_CODE',
        rootPath: record.rootPath,
        manifestPath: record.rootPath,
        name: stringField(manifest.name) ?? record.id.name,
        ...(description ? { description } : {}),
        ...(version ? { version } : {}),
        category: 'Other',
        exampleQueries: [],
        apps: [],
        mcpServers: [],
        skills: [],
        diagnostics: [{ code: diagnosticCode }],
    };
}
function parseRecord(value) {
    if (!isRecord(value) || !isRecord(value.id))
        return undefined;
    const { name, marketplace } = value.id;
    const rootPath = value.rootPath;
    if (typeof name !== 'string' ||
        typeof marketplace !== 'string' ||
        typeof rootPath !== 'string' ||
        !path.isAbsolute(rootPath)) {
        return undefined;
    }
    const id = { name, marketplace };
    if (!isInstallablePluginId(id))
        return undefined;
    return {
        id,
        rootPath,
        ...(isRecord(value.manifest) ? { manifest: value.manifest } : {}),
    };
}
function stringField(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=plugin-links.js.map