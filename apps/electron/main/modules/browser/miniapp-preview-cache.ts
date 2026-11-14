import { createHash } from "node:crypto";
import { mkdir, lstat, rm, writeFile, rename, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { KeyedOperationLane } from "@mavis/shared/keyed-operation-lane";
import { isMiniAppPageSnapshot } from "@mavis/shared/miniapp-surface";
const lanes = new KeyedOperationLane();
const LIMIT = 30;
const hash = (value) => createHash('sha256').update(value).digest('hex');
/** Host-owned cache beside Mini App data; each file contains only one app's image. */
export async function miniAppPreviewCache(dataDir, deployment, request, isCurrent) {
    if (!request ||
        !request.accountId ||
        !isCurrent() ||
        !['read', 'save', 'remove'].includes(request.action) ||
        (request.action !== 'read' &&
            (typeof request.pluginId !== 'string' ||
                !request.pluginId ||
                request.pluginId.length > 256)) ||
        (request.action === 'save' && !isMiniAppPageSnapshot(request.snapshot)))
        return {};
    const scope = hash(JSON.stringify([deployment, request.accountId]));
    const directory = join(dataDir, 'v2', 'plugin-data', 'miniapp-previews', scope);
    return lanes.run(directory, async () => {
        try {
            if (!isCurrent())
                return {};
            // Cache directories and files must not redirect operations through symlinks.
            let parent = dataDir;
            for (const name of ['v2', 'plugin-data', 'miniapp-previews', scope]) {
                parent = join(parent, name);
                await mkdir(parent, { recursive: true, mode: 0o700 });
                if (!(await lstat(parent)).isDirectory())
                    return {};
            }
            if (request.action === 'read') {
                const saved = await Promise.all((await entries(directory)).slice(0, LIMIT).map(async (entry) => {
                    const value = await readSnapshot(join(directory, entry.name));
                    return value && `${hash(value.pluginId)}.json` === entry.name
                        ? [[value.pluginId, value.snapshot]]
                        : [];
                }));
                return isCurrent() ? Object.fromEntries(saved.flat()) : {};
            }
            const file = join(directory, `${hash(request.pluginId)}.json`);
            if (request.action === 'remove') {
                if (isCurrent())
                    await rm(file, { force: true });
                return {};
            }
            const previous = await readSnapshot(file);
            if ((previous?.snapshot.capturedAt ?? -1) > request.snapshot.capturedAt || !isCurrent())
                return {};
            const temporary = `${file}.tmp`;
            try {
                await writeFile(temporary, JSON.stringify({ pluginId: request.pluginId, snapshot: request.snapshot }), { flag: 'wx', mode: 0o600 });
                if (!isCurrent())
                    return {};
                await rename(temporary, file);
            }
            finally {
                await rm(temporary, { force: true });
            }
            // Only inspect file metadata; never read or rewrite the other images when saving.
            for (const entry of (await entries(directory)).slice(LIMIT)) {
                await rm(join(directory, entry.name), { force: true });
            }
        }
        catch {
            // A disposable preview must never prevent closing, stopping or uninstalling an app.
        }
        return {};
    });
}
async function readSnapshot(file) {
    try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > 510000)
            return null;
        const value = JSON.parse(await readFile(file, 'utf8'));
        return typeof value?.pluginId === 'string' && isMiniAppPageSnapshot(value.snapshot)
            ? value
            : null;
    }
    catch {
        return null;
    }
}
async function entries(directory) {
    const files = await Promise.all((await readdir(directory))
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
        const info = await lstat(join(directory, name));
        return { name, info };
    }));
    return files.filter(({ info }) => info.isFile()).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
}
