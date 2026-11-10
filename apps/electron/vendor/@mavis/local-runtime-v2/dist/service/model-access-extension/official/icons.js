import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
/**
 * Content-addressed cache of remote presentation icons, like Plugin icons: the catalog names a
 * CDN URL plus sha256 and size; the runtime stores verified bytes at
 * `<model-access root>/icons/<sha256>.<ext>` and only ever exposes that local path.
 */
class ModelAccessIconError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'ModelAccessIconError';
    }
}
const ICON_FILE = /^[0-9a-f]{64}\.(png|jpg|jpeg|webp)$/u;
function modelAccessIconDirectory(root) {
    return path.join(root, 'icons');
}
function modelAccessIconPath(root, icon) {
    return path.join(modelAccessIconDirectory(root), `${icon.sha256}.${icon.extension}`);
}
/** Local path of a verified icon, or undefined while it is not cached (yet). */
export function cachedModelAccessIcon(root, icon) {
    if (!icon)
        return undefined;
    const target = modelAccessIconPath(root, icon);
    return existsSync(target) ? target : undefined;
}
function catalogIcons(catalog) {
    const icons = new Map();
    for (const entry of [
        ...Object.values(catalog.presentation.providers),
        ...Object.values(catalog.presentation.sources),
    ]) {
        for (const icon of [entry.icon, entry.darkIcon])
            if (icon)
                icons.set(`${icon.sha256}.${icon.extension}`, icon);
    }
    return [...icons.values()];
}
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
async function verified(file, icon) {
    try {
        if ((await stat(file)).size !== icon.sizeBytes)
            return false;
        return sha256(await readFile(file)) === icon.sha256;
    }
    catch {
        return false;
    }
}
/** Downloads one icon unless a verified copy is there; returns a failure code, if any. */
async function fetchIcon(input, directory, icon) {
    const target = modelAccessIconPath(input.root, icon);
    if (await verified(target, icon))
        return undefined;
    const temporary = path.join(directory, `.download-${randomUUID()}`);
    try {
        await input.download(icon.url, temporary, input.signal);
        if (!(await verified(temporary, icon)))
            throw new ModelAccessIconError('icon_invalid');
        await rename(temporary, target);
        return undefined;
    }
    catch (error) {
        return error instanceof ModelAccessIconError ? error.code : 'icon_download_failed';
    }
    finally {
        await rm(temporary, { force: true });
    }
}
/**
 * Downloads missing icons of the catalog and removes icons it no longer references. One bad
 * icon never blocks the others; the first failure code is returned for diagnostics.
 */
export async function syncModelAccessIcons(input) {
    const directory = modelAccessIconDirectory(input.root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const icons = catalogIcons(input.catalog);
    let errorCode;
    for (const icon of icons) {
        if (input.signal?.aborted)
            break;
        const failure = await fetchIcon(input, directory, icon);
        errorCode ??= failure;
    }
    const referenced = new Set(icons.map((icon) => `${icon.sha256}.${icon.extension}`));
    for (const name of await readdir(directory)) {
        // Leftover partial downloads and icons the catalog dropped.
        if ((ICON_FILE.test(name) && !referenced.has(name)) || name.startsWith('.download-'))
            await rm(path.join(directory, name), { force: true });
    }
    return errorCode ? { errorCode } : {};
}
//# sourceMappingURL=icons.js.map