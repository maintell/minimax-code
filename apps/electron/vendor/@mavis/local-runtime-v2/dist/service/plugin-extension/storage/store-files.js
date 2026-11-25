import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomically } from '../../../infra/file/atomic-write.js';
import { ExtensionServiceError } from '../errors.js';
function isWithin(parent, child) {
    const relative = path.relative(parent, child);
    return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}
/**
 * Real path of `dir` once it is confirmed to stay under `allowedRoot` (itself resolved through
 * `root`). `undefined` when `dir` does not exist and `create` is false.
 */
export async function resolveContainedDir(input) {
    await mkdir(input.root, { recursive: true });
    if (input.create)
        await mkdir(input.dir, { recursive: true });
    const realRoot = await realpath(input.root);
    let realDir;
    try {
        realDir = await realpath(input.dir);
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
    if (!isWithin(path.join(realRoot, input.namespace), realDir)) {
        throw new ExtensionServiceError('STORE_KEY_INVALID', 'store path escapes the plugin namespace');
    }
    return realDir;
}
export async function readTextIfExists(file) {
    try {
        return await readFile(file, 'utf8');
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
export async function sizeIfExists(file) {
    try {
        return (await stat(file)).size;
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
/** Store writes are flushed before the rename. */
export async function writeFileAtomic(file, text) {
    await writeFileAtomically(file, text, { sync: true });
}
export async function listFileNames(dir) {
    if (!dir)
        return [];
    try {
        return (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name);
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
}
export async function listDirNames(dir) {
    try {
        return (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
    }
    catch (error) {
        if (isMissing(error))
            return [];
        throw error;
    }
}
/** Sum of `.json` file sizes under `dir`, any depth. */
export async function jsonBytesUnder(dir) {
    let total = 0;
    for (const name of await listFileNames(dir)) {
        if (name.endsWith('.json'))
            total += (await sizeIfExists(path.join(dir, name))) ?? 0;
    }
    for (const child of await listDirNames(dir))
        total += await jsonBytesUnder(path.join(dir, child));
    return total;
}
function isMissing(error) {
    return error?.code === 'ENOENT';
}
//# sourceMappingURL=store-files.js.map