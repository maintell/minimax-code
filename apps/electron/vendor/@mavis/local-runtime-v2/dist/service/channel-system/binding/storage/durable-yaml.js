/**
 * Durable YAML persistence for channel-system stores.
 *
 * Migration copy (MR1) of v1 `channels/durable-yaml.ts`. Invariants that must
 * survive the migration (proposal §8):
 * - one module-level KeyedOperationLane serialises every read-modify-write
 *   per file path, so concurrent mutations of the same YAML document cannot
 *   interleave;
 * - callers mutate the raw parsed document so unknown fields written by a
 *   newer release are preserved verbatim;
 * - writes go through a same-directory temp file + fsync + atomic rename
 *   (Windows-compatible), with 0o600 permissions.
 *
 * Single-writer note: while the v1 implementation still exists (until MR3),
 * one profile must never be served by BOTH lanes at once. MR1 does not wire
 * this copy into production; MR2 switches the owner wholesale so exactly one
 * module instance writes a given profile's files at any time.
 */
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import yaml from 'js-yaml';
const mutationLane = new KeyedOperationLane();
/**
 * Serialize one complete YAML-file read/modify/write cycle.  Callers mutate
 * the raw document so fields written by a newer release remain untouched.
 */
export function mutateDurableYaml(filePath, mutate, hooks = {}) {
    return mutationLane.run(filePath, async () => {
        const document = await readYamlDocument(filePath);
        const result = await mutate(document);
        if (result.changed) {
            await writeFileDurably(filePath, yaml.dump(document, { lineWidth: 120, noRefs: true }), hooks);
        }
        return result.value;
    });
}
export async function readYamlDocument(filePath) {
    let raw;
    try {
        raw = await readFile(filePath, 'utf8');
    }
    catch (error) {
        // ENOENT is the valid first-boot state; every other I/O failure surfaces.
        if (error.code !== 'ENOENT')
            throw error;
    }
    if (!raw)
        return {};
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { ...parsed }
        : {};
}
/** Same-directory temp + file fsync + atomic replace + best-effort dir fsync. */
async function writeFileDurably(filePath, content, hooks = {}) {
    const parent = dirname(filePath);
    await mkdir(parent, { recursive: true });
    const tempPath = join(parent, `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    let published = false;
    try {
        const handle = await open(tempPath, 'wx', 0o600);
        try {
            await handle.writeFile(content, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await hooks.afterTempSync?.();
        await hooks.beforeRename?.();
        await rename(tempPath, filePath);
        published = true;
        await hooks.afterRename?.();
        await syncDirectoryBestEffort(parent);
    }
    finally {
        if (!published)
            await unlinkIfExists(tempPath);
    }
}
/** Remove an unpublished temp file; a missing file is already the goal state. */
async function unlinkIfExists(tempPath) {
    try {
        await unlink(tempPath);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
async function syncDirectoryBestEffort(directory) {
    let handle;
    try {
        handle = await open(directory, 'r');
    }
    catch (error) {
        // Platforms/filesystems that cannot open a directory for sync are fine —
        // the file fsync above already provided the durability we can get.
        if (isUnsupportedDirectorySync(error))
            return;
        throw error;
    }
    try {
        await handle.sync();
    }
    catch (error) {
        if (!isUnsupportedDirectorySync(error))
            throw error;
    }
    finally {
        await handle.close();
    }
}
function isUnsupportedDirectorySync(error) {
    return error.code === 'EINVAL' || error.code === 'ENOTSUP' || error.code === 'EPERM';
}
//# sourceMappingURL=durable-yaml.js.map