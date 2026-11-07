import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pluginIdKey } from '@mavis/shared';
import { PLUGIN_PACKAGE_V1_LIMITS } from '../package/package-contract.js';
import { readJsonFile, writeJsonFile } from './registry.js';
/**
 * `${dataDir}/v2/plugin-marketplaces/installs.json`. A record only counts
 * while the same Plugin is still installed in the same directory, so
 * uninstalling from the management page needs no extra bookkeeping.
 */
export class InstallRecords {
    file;
    constructor(stateDir) {
        this.file = path.join(stateDir, 'installs.json');
    }
    /** Records of the given installed Plugins, by `pluginIdKey`. */
    async read(installed) {
        const live = new Map(installed.map((plugin) => [pluginIdKey(plugin.id), plugin]));
        const document = await readJsonFile(this.file);
        const items = isRecord(document) && Array.isArray(document.installs) ? document.installs : [];
        const records = new Map();
        for (const item of items) {
            const record = parseInstallRecord(item);
            const key = record ? pluginIdKey(record.id) : '';
            const plugin = live.get(key);
            if (record && plugin && samePath(plugin.rootPath, record.rootPath))
                records.set(key, record);
        }
        return records;
    }
    /** Stores `record` and drops records of Plugins that are no longer installed. */
    async put(record, installed) {
        const records = await this.read(installed);
        records.set(pluginIdKey(record.id), record);
        await this.write(records.values());
    }
    async write(records) {
        await writeJsonFile(this.file, { version: 1, installs: [...records] });
    }
}
/** Content hashes of regular files below `root` (symlinks and `.git` skipped). */
export async function digestFiles(root) {
    const files = [];
    await collectFileDigests(root, '', files);
    return files.sort(([left], [right]) => left.localeCompare(right));
}
/** Paths whose content differs between two digests: edited, added, or deleted. */
export function changedFiles(recorded, current) {
    const before = new Map(recorded);
    const after = new Map(current);
    const changed = new Set();
    for (const [file, digest] of after)
        if (before.get(file) !== digest)
            changed.add(file);
    for (const file of before.keys())
        if (!after.has(file))
            changed.add(file);
    return [...changed].sort();
}
async function collectFileDigests(directory, prefix, files) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git')
            continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory())
            await collectFileDigests(absolute, relative, files);
        else if (entry.isFile() && files.length < PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
            files.push([
                relative,
                createHash('sha256')
                    .update(await readFile(absolute))
                    .digest('hex'),
            ]);
        }
    }
}
function parseInstallRecord(value) {
    if (!isRecord(value) || !isRecord(value.id))
        return undefined;
    const { name, marketplace } = value.id;
    if (typeof name !== 'string' || typeof marketplace !== 'string')
        return undefined;
    if (typeof value.rootPath !== 'string' || typeof value.installedDigest !== 'string')
        return undefined;
    return {
        id: { name, marketplace },
        rootPath: value.rootPath,
        installedDigest: value.installedDigest,
        files: Array.isArray(value.files) ? value.files.filter(isFileDigest) : [],
        ...(typeof value.version === 'string' ? { version: value.version } : {}),
        ...(typeof value.remoteHead === 'string' ? { remoteHead: value.remoteHead } : {}),
    };
}
function isFileDigest(value) {
    return (Array.isArray(value) &&
        value.length === 2 &&
        typeof value[0] === 'string' &&
        typeof value[1] === 'string');
}
function samePath(left, right) {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=installs.js.map