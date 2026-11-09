import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function locateModelAccessHostEntry() {
    const resourcesPath = process.resourcesPath;
    const candidates = [
        ...(resourcesPath
            ? [path.join(resourcesPath, 'resources/model-access-host/host-entry.mjs')]
            : []),
        fileURLToPath(new URL(typeof __IS_NPM_BUILD__ !== 'undefined' && __IS_NPM_BUILD__
            ? './assets/model-access-host/host-entry.mjs'
            : '../../../../dist/model-access-host/host-entry.mjs', import.meta.url)),
    ];
    for (const candidate of candidates) {
        if (candidate.split(path.sep).some((segment) => segment.endsWith('.asar')))
            continue;
        try {
            if ((await stat(candidate)).isFile())
                return candidate;
        }
        catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code ?? ''))
                throw error;
        }
    }
    throw new Error('model_access_host_entry_missing');
}
//# sourceMappingURL=entry-path.js.map