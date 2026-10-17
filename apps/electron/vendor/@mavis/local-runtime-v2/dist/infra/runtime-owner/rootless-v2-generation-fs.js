import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, open, readFile, readdir, readlink, rename, rm, statfs, } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
export const SOURCE_RELEASE = 'previewtrain-root-v1';
export const TARGET_RELEASE = 'desktop-rootless-v2';
export function generationPaths(input) {
    const dataDir = resolve(input);
    if (dataDir === resolve(dirname(dataDir)))
        throw new Error('Filesystem root cannot be a dataDir');
    const root = `${dataDir}.rootless-v2-rollback`;
    if (dirname(root) !== dirname(dataDir))
        throw new Error('Rollback slot must be a sibling');
    return {
        dataDir,
        root,
        stagingRoot: `${root}.tmp`,
        previous: join(root, 'previous-data-dir'),
        upgraded: join(root, 'upgraded-data-dir'),
        manifest: join(root, 'manifest.json'),
        journal: join(root, 'swap-journal.json'),
        lockTarget: `${root}.operation-lock`,
    };
}
export async function readAndValidateManifest(paths, releases) {
    const raw = JSON.parse(await readFile(paths.manifest, 'utf8'));
    const manifest = decodeManifest(raw, releases);
    await assertOwnerOnlyDirectory(paths.root);
    return manifest;
}
function decodeManifest(raw, releases) {
    const manifest = requiredManifestRecord(raw);
    validateManifestHeader(manifest, releases);
    return {
        schemaVersion: 1,
        sourceRelease: releases.sourceRelease ?? SOURCE_RELEASE,
        targetRelease: releases.targetRelease ?? TARGET_RELEASE,
        completed: true,
        ...decodeManifestState(manifest),
    };
}
function requiredManifestRecord(raw) {
    if (!isRecord(raw))
        throw new Error('Checkpoint manifest is invalid');
    return raw;
}
function validateManifestHeader(manifest, releases) {
    if (manifest.schemaVersion !== 1)
        throw new Error('Checkpoint manifest version is invalid');
    if (manifest.completed !== true)
        throw new Error('Checkpoint manifest is incomplete');
    if (manifest.sourceRelease !== (releases.sourceRelease ?? SOURCE_RELEASE)) {
        throw new Error('Checkpoint source release does not match');
    }
    if (manifest.targetRelease !== (releases.targetRelease ?? TARGET_RELEASE)) {
        throw new Error('Checkpoint target release does not match');
    }
}
function decodeManifestState(manifest) {
    const activeFingerprint = requiredNonEmptyString(manifest.activeFingerprint, 'Checkpoint active fingerprint is invalid');
    const sourceAbsent = requiredBoolean(manifest.sourceAbsent, 'Checkpoint source-absent marker is invalid');
    const upgradedFingerprint = optionalNonEmptyString(manifest.upgradedFingerprint, 'Checkpoint upgraded fingerprint is invalid');
    const previousFingerprint = optionalNonEmptyString(manifest.previousFingerprint, 'Checkpoint previous fingerprint is invalid');
    const previousPresent = optionalBoolean(manifest.previousPresent, 'Checkpoint previous-present marker is invalid');
    if ((previousFingerprint === undefined) !== (previousPresent === undefined)) {
        throw new Error('Checkpoint current previous-generation state is incomplete');
    }
    return {
        activeFingerprint,
        sourceAbsent,
        ...(upgradedFingerprint ? { upgradedFingerprint } : {}),
        ...(previousFingerprint ? { previousFingerprint } : {}),
        ...(previousPresent !== undefined ? { previousPresent } : {}),
    };
}
export async function readJournal(path) {
    const raw = await readOptionalText(path);
    if (raw === undefined)
        return undefined;
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed))
        throw new Error('Generation journal is invalid');
    if (parsed.schemaVersion !== 1 ||
        parsed.completed !== false ||
        (parsed.operation !== 'rollback' && parsed.operation !== 'reupgrade') ||
        !isJournalStage(parsed.stage)) {
        throw new Error('Generation journal is invalid');
    }
    return {
        schemaVersion: 1,
        operation: parsed.operation,
        stage: parsed.stage,
        completed: false,
    };
}
export async function writeJournal(paths, input) {
    await writeJsonAtomically(paths.journal, {
        schemaVersion: 1,
        operation: input.operation,
        stage: input.stage,
        completed: false,
    });
}
function isJournalStage(value) {
    return value === 'prepared' || value === 'active-saved' || value === 'target-activated';
}
function requiredNonEmptyString(value, message) {
    if (typeof value !== 'string' || value.length === 0)
        throw new Error(message);
    return value;
}
function optionalNonEmptyString(value, message) {
    if (value === undefined)
        return undefined;
    return requiredNonEmptyString(value, message);
}
function requiredBoolean(value, message) {
    if (typeof value !== 'boolean')
        throw new Error(message);
    return value;
}
function optionalBoolean(value, message) {
    if (value === undefined)
        return undefined;
    return requiredBoolean(value, message);
}
export async function fingerprintGeneration(path, absent) {
    if (absent) {
        if (await pathExists(path))
            throw new Error('Expected generation to be absent');
        return createHash('sha256').update('rootless-v2:source-absent\0').digest('hex');
    }
    const source = await lstat(path);
    if (!source.isDirectory() || source.isSymbolicLink()) {
        throw new Error('Generation root must be a physical directory');
    }
    const hash = createHash('sha256');
    await hashTree(path, '', hash);
    return hash.digest('hex');
}
async function hashTree(root, relativePath, hash) {
    const path = relativePath ? join(root, relativePath) : root;
    const info = await lstat(path);
    const normalized = relativePath.split('\\').join('/');
    const kind = checkpointEntryKind(info);
    if (kind === 'directory') {
        hash.update(`d\0${normalized}\0${String(info.mode & 0o777)}\0`);
        const names = (await readdir(path)).sort((left, right) => left.localeCompare(right));
        for (const name of names)
            await hashTree(root, join(relativePath, name), hash);
        return;
    }
    if (kind === 'symlink') {
        hash.update(`l\0${normalized}\0${await readlink(path)}\0`);
        return;
    }
    if (kind === 'transient')
        return;
    hash.update(`f\0${normalized}\0${String(info.mode & 0o777)}\0${String(info.size)}\0`);
    await new Promise((resolveStream, rejectStream) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', rejectStream);
        stream.on('end', resolveStream);
    });
}
export async function treeByteSize(root) {
    return entryByteSize(root, true);
    async function entryByteSize(path, isRoot = false) {
        const info = await lstat(path);
        const kind = checkpointEntryKind(info);
        if (kind === 'symlink') {
            if (isRoot)
                throw new Error('Checkpoint source cannot be a symlink');
            return Buffer.byteLength(await readlink(path));
        }
        if (kind === 'file')
            return info.size;
        if (kind === 'transient')
            return 0;
        let total = 0;
        for (const name of await readdir(path))
            total += await entryByteSize(join(path, name));
        return total;
    }
}
export async function shouldCopyCheckpointEntry(path) {
    return checkpointEntryKind(await lstat(path)) !== 'transient';
}
/**
 * Copy-on-write clone of a whole tree via the platform `cp` binary:
 * `clonefile(2)` on APFS (macOS) and `FICLONE` reflink on btrfs/XFS (Linux).
 * Cloning 17G costs milliseconds and zero extra disk, versus minutes of
 * physical IO through the JS-level `fs.cp` walk.
 *
 * Returns true only when the clone subprocess fully succeeded. On any failure
 * (unsupported platform, sockets/FIFOs aborting `cp`, non-reflink filesystem
 * errors) the half-written destination is removed and false is returned so the
 * caller can fall back to the legacy `fs.cp` walk — fingerprint verification
 * downstream guards both paths equally.
 */
export async function tryCloneTree(source, destination) {
    const argv = cloneArgsForPlatform(source, destination);
    if (!argv)
        return { cloned: false, reason: `unsupported platform ${process.platform}` };
    const [command, ...args] = argv;
    try {
        await execFileAsync(command, args);
        return { cloned: true };
    }
    catch (error) {
        await removeFailedCloneDestination(destination);
        return { cloned: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
function cloneArgsForPlatform(source, destination) {
    if (process.platform === 'darwin')
        return ['/bin/cp', '-Rc', source, destination];
    if (process.platform === 'linux')
        return ['/bin/cp', '-a', '--reflink=auto', source, destination];
    return undefined;
}
async function removeFailedCloneDestination(destination) {
    try {
        await rm(destination, { recursive: true, force: true });
    }
    catch {
        // The fallback fs.cp path uses errorOnExist and will surface leftovers.
    }
}
/**
 * Removes FIFO/socket entries a platform `cp` clone may have materialized,
 * restoring the checkpoint contract that transient entries never enter the
 * copy (a rolled-back generation must not resurrect stale runtime sockets).
 * Metadata-only walk — cheap next to the content hashing that follows.
 */
export async function removeTransientEntries(root) {
    const info = await lstat(root);
    const kind = checkpointEntryKind(info);
    if (kind === 'transient') {
        await rm(root, { force: true });
        return;
    }
    if (kind !== 'directory')
        return;
    for (const name of await readdir(root)) {
        await removeTransientEntries(join(root, name));
    }
}
function checkpointEntryKind(info) {
    if (info.isSymbolicLink())
        return 'symlink';
    if (info.isDirectory())
        return 'directory';
    if (info.isFile())
        return 'file';
    if (info.isFIFO() || info.isSocket())
        return 'transient';
    throw new Error('Checkpoint source contains an unsupported file type');
}
export async function assertFreeSpace(parent, requiredBytes) {
    const stats = await statfs(parent);
    const available = stats.bavail * stats.bsize;
    if (!Number.isSafeInteger(available) || available < requiredBytes + 4096) {
        throw new Error('Insufficient space for Rootless V2 checkpoint');
    }
}
export async function assertCheckpointSourceBoundary(dataDir) {
    const info = await lstat(dataDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Checkpoint source must be a physical directory');
    }
}
export async function syncTree(root, absent) {
    if (absent)
        return;
    const info = await lstat(root);
    if (info.isDirectory()) {
        for (const name of await readdir(root))
            await syncTree(join(root, name), false);
        await syncDirectoryBestEffort(root);
        return;
    }
    if (!info.isFile())
        return;
    const handle = await open(root, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
export async function writeNewJson(path, value) {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
export async function writeJsonAtomically(path, value) {
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    let published = false;
    try {
        await writeNewJson(temporary, value);
        await rename(temporary, path);
        published = true;
        await syncDirectoryBestEffort(dirname(path));
    }
    finally {
        if (!published)
            await rm(temporary, { force: true });
    }
}
export async function syncSwapParents(paths) {
    await syncDirectoryBestEffort(dirname(paths.dataDir));
    await syncDirectoryBestEffort(paths.root);
}
export async function syncDirectoryBestEffort(path) {
    let handle;
    try {
        handle = await open(path, 'r');
    }
    catch (error) {
        if (!isUnsupportedDirectorySync(error))
            throw error;
    }
    if (!handle)
        return;
    try {
        try {
            await handle.sync();
        }
        catch (error) {
            if (!isUnsupportedDirectorySync(error))
                throw error;
        }
    }
    finally {
        await handle.close();
    }
}
function isUnsupportedDirectorySync(error) {
    const code = errorCode(error);
    return code === 'EINVAL' || code === 'ENOTSUP' || code === 'EPERM' || code === 'EISDIR';
}
async function assertOwnerOnlyDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Rollback slot must be a physical directory');
    }
    if (process.platform === 'win32')
        return;
    if ((info.mode & 0o077) !== 0)
        throw new Error('Rollback slot permissions are not owner-only');
}
export async function chmodOwnerOnly(path) {
    if (process.platform !== 'win32')
        await chmod(path, 0o700);
}
export async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return false;
        throw error;
    }
}
export async function readOptionalText(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return undefined;
        throw error;
    }
}
export function codedError(code, message, cause) {
    return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
export function errorCode(error) {
    if (!error || typeof error !== 'object' || !('code' in error))
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=rootless-v2-generation-fs.js.map