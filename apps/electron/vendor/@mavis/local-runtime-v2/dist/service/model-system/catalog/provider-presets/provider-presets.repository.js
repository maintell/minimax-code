import { chmodSync, renameSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { retryWindowsFileSystemOperation } from '@mavis/shared';
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
function resolveProviderPresetBundledCatalogPaths(options) {
    if (options.bundledCatalogPath)
        return [options.bundledCatalogPath];
    return [
        join(MODULE_DIRECTORY, 'assets', 'models-dev-catalog.json.gz'),
        join(MODULE_DIRECTORY, '..', '..', '..', '..', '..', 'assets', 'models-dev-catalog.json.gz'),
    ];
}
export function resolveProviderPresetLocalCatalogPath(options) {
    return (options.localCatalogPath ??
        (options.dataDir ? join(options.dataDir, 'cache', 'models-dev-catalog.json') : undefined));
}
export async function readProviderPresetSnapshotCandidates(options) {
    const candidates = await Promise.all([
        ...resolveProviderPresetBundledCatalogPaths(options).map((filePath) => readCatalogSnapshot(filePath)),
        readCatalogSnapshot(resolveProviderPresetLocalCatalogPath(options)),
    ]);
    return candidates.filter((candidate) => candidate !== undefined);
}
export async function writeProviderPresetSnapshot(filePath, snapshot) {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(snapshot), { mode: 0o600 });
    try {
        retryWindowsFileSystemOperation(() => renameSync(temporaryPath, filePath));
        retryWindowsFileSystemOperation(() => chmodSync(filePath, 0o600));
    }
    catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
    }
}
async function readCatalogSnapshot(filePath) {
    if (!filePath)
        return undefined;
    try {
        const contents = filePath.endsWith('.gz')
            ? gunzipSync(await readFile(filePath)).toString('utf8')
            : await readFile(filePath, 'utf8');
        return JSON.parse(contents);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=provider-presets.repository.js.map