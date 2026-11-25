import { randomUUID } from "node:crypto";
import { mkdir, lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { resolveLocalRuntimeDataDir } from "../local-runtime/data-dir";
export let CAPTURE_CACHE_DAYS = 30;
export let CAPTURE_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const GENERATED_PNG = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.png$/;
export function captureStorageRoot() {
    return path.join(resolveLocalRuntimeDataDir(), 'captures');
}
export async function createCapturePath(kind) {
    const directory = path.join(captureStorageRoot(), kind === 'screenshot' ? 'cache' : kind === 'saved-image' ? 'saved' : 'recordings', new Date().toISOString().slice(0, 10));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return path.join(directory, `${randomUUID()}.${kind === 'recording' ? 'mp4' : 'png'}`);
}
async function statIfPresent(file) {
    try {
        return await lstat(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
/** Only new, explicitly disposable PNGs are eligible. Legacy attachments stay untouched. */
export async function cleanCaptureCache(all = false, root = captureStorageRoot(), now = Date.now()) {
    const cache = path.join(root, 'cache');
    const info = await statIfPresent(cache);
    if (!info?.isDirectory() || info.isSymbolicLink())
        return;
    let firstError;
    function recordFailure(error) {
        if (error.code !== 'ENOENT')
            firstError ?? (firstError = error);
    }
    const files = [];
    for (const day of await readdir(cache, { withFileTypes: true })) {
        if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name))
            continue;
        const directory = path.join(cache, day.name);
        const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
            recordFailure(error);
            return [];
        });
        for (const entry of entries) {
            if (!entry.isFile() || !GENERATED_PNG.test(entry.name))
                continue;
            const file = path.join(directory, entry.name);
            const stat = await statIfPresent(file).catch(recordFailure);
            if (stat && stat.isFile())
                files.push({ file, size: stat.size, modified: stat.mtimeMs });
        }
    }
    files.sort((a, b) => a.modified - b.modified);
    let bytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of files) {
        if (!all && now - file.modified < CAPTURE_CACHE_DAYS * DAY_MS && bytes <= CAPTURE_CACHE_BYTES)
            continue;
        try {
            await unlink(file.file);
            bytes -= file.size;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                bytes -= file.size;
            else
                recordFailure(error);
        }
    }
    if (firstError)
        throw firstError;
}
