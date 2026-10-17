import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, lstat, rm, writeFile, rename, readdir, copyFile, chmod, readlink, cp, symlink, stat as promisesStat, readFile } from "node:fs/promises";
import path from "node:path";
import properLockfile from "proper-lockfile";
const MANIFEST_FILE = '.local-runtime-test-isolation.json';
const MANIFEST_VERSION = 3;
const COPY_POLICY = 'persistent-data-dir-v3-symlinks-skip-ipc';
/**
 * Build or reuse an atomic, test-only clone of the persistent local-runtime
 * dataDir. The source is treated as read-only: auth and runtime artifacts are
 * regenerated in the clone. SQLite database/WAL/journal files are copied as a
 * stable set without opening the source database, and any source mutation
 * observed during the copy aborts instead of falling back to the source.
 */
export async function prepareLocalRuntimeTestDataIsolation(options) {
    const sourceAbsolute = path.resolve(options.sourceDataDir);
    const managedAbsolute = path.resolve(options.managedRoot);
    assertDisjointPaths(sourceAbsolute, managedAbsolute);
    const sourceDataDir = await canonicalizeProspectivePath(sourceAbsolute);
    const prospectiveManagedRoot = await canonicalizeProspectivePath(managedAbsolute);
    assertDisjointPaths(sourceDataDir, prospectiveManagedRoot);
    await mkdir(managedAbsolute, { recursive: true, mode: 0o700 });
    const managedRoot = await realpath(managedAbsolute);
    assertDisjointPaths(sourceDataDir, managedRoot);
    const sourceKey = createHash('sha256').update(sourceDataDir).digest('hex').slice(0, 24);
    const bucketCandidate = path.join(managedRoot, sourceKey);
    if (await pathExists(bucketCandidate)) {
        const bucketStat = await lstat(bucketCandidate);
        if (bucketStat.isSymbolicLink() || !bucketStat.isDirectory()) {
            throw new Error(`Unsafe local runtime test isolation bucket: ${bucketCandidate}`);
        }
    }
    else {
        await mkdir(bucketCandidate, { recursive: false, mode: 0o700 });
    }
    const bucketRoot = await realpath(bucketCandidate);
    const dataDir = path.join(bucketRoot, 'current');
    assertManagedChild(managedRoot, bucketRoot);
    assertManagedChild(bucketRoot, dataDir);
    const releasePreparationLock = await properLockfile
        .lock(bucketRoot, {
        stale: 5000,
        update: 1000,
        retries: { retries: 6, factor: 1, minTimeout: 1000, maxTimeout: 1000 },
    })
        .catch((error) => {
        throw new Error(`Local runtime test data isolation is already being prepared: ${formatError(error)}`);
    });
    let temporaryDataDir;
    try {
        await assertSafeCloneDirectory(dataDir, bucketRoot);
        const ready = await readReadyManifest(dataDir, sourceDataDir);
        if (ready && !options.resetRequested) {
            return { dataDir, created: false, reset: false };
        }
        const reset = options.resetRequested === true;
        if (await pathExists(dataDir)) {
            assertManagedChild(bucketRoot, dataDir);
            await rm(dataDir, { recursive: true, force: true });
        }
        temporaryDataDir = path.join(bucketRoot, `.creating-${randomUUID()}`);
        assertManagedChild(bucketRoot, temporaryDataDir);
        await mkdir(temporaryDataDir, { recursive: false, mode: 0o700 });
        const sourceFingerprintBefore = await fingerprintPersistentTree(sourceDataDir);
        await copyPersistentTree(sourceDataDir, temporaryDataDir);
        const sourceFingerprintAfter = await fingerprintPersistentTree(sourceDataDir);
        if (sourceFingerprintAfter !== sourceFingerprintBefore) {
            throw new Error('Source dataDir changed while the isolated clone was being created');
        }
        const manifest = {
            version: MANIFEST_VERSION,
            status: 'ready',
            sourceDataDir,
            sourceFingerprint: sourceFingerprintAfter,
            createdAtMs: (options.nowMs ?? Date.now)(),
            copyPolicy: COPY_POLICY,
        };
        await writeFile(path.join(temporaryDataDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporaryDataDir, dataDir);
        temporaryDataDir = undefined;
        return { dataDir, created: true, reset };
    }
    finally {
        try {
            if (temporaryDataDir) {
                assertManagedChild(bucketRoot, temporaryDataDir);
                await rm(temporaryDataDir, { recursive: true, force: true });
            }
        }
        finally {
            await releasePreparationLock();
        }
    }
}
async function assertSafeCloneDirectory(dataDir, bucketRoot) {
    if (!(await pathExists(dataDir)))
        return;
    const stat = await lstat(dataDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Unsafe local runtime test isolation clone: ${dataDir}`);
    }
    assertManagedChild(bucketRoot, await realpath(dataDir));
}
async function copyPersistentTree(sourceRoot, destinationRoot) {
    if (!(await pathExists(sourceRoot)))
        return;
    const sourceStat = await lstat(sourceRoot);
    if (!sourceStat.isDirectory()) {
        throw new Error(`Source dataDir is not a directory: ${sourceRoot}`);
    }
    await copyDirectoryEntries(sourceRoot, destinationRoot, '');
}
async function copyDirectoryEntries(sourceRoot, destinationRoot, relativeDirectory) {
    const sourceDirectory = path.join(sourceRoot, relativeDirectory);
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    await runSequentially(entries.sort((left, right) => left.name.localeCompare(right.name)), async (entry) => {
        const relativePath = path.join(relativeDirectory, entry.name);
        if (excludeFromCopy(relativePath))
            return;
        const sourcePath = path.join(sourceRoot, relativePath);
        const destinationPath = path.join(destinationRoot, relativePath);
        const stat = await lstat(sourcePath);
        if (stat.isSymbolicLink()) {
            await copySymbolicLink(sourceRoot, destinationRoot, relativePath);
            return;
        }
        if (stat.isDirectory()) {
            await mkdir(destinationPath, { mode: stat.mode & 0o777 });
            await copyDirectoryEntries(sourceRoot, destinationRoot, relativePath);
            return;
        }
        if (!stat.isFile()) {
            if (stat.isSocket() || stat.isFIFO())
                return;
            throw new Error(`Refusing to copy special source dataDir entry: ${relativePath}`);
        }
        await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
        await copyFile(sourcePath, destinationPath);
        await chmod(destinationPath, stat.mode & 0o777);
    });
}
async function copySymbolicLink(sourceRoot, destinationRoot, relativePath) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const destinationPath = path.join(destinationRoot, relativePath);
    const sourceTarget = await readlink(sourcePath);
    const destinationTarget = await remapSymbolicLinkTarget({
        sourceRoot,
        destinationRoot,
        sourcePath,
        destinationPath,
        sourceTarget,
    });
    await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    if (destinationTarget === sourceTarget) {
        await cp(sourcePath, destinationPath, {
            dereference: false,
            errorOnExist: true,
            force: false,
            verbatimSymlinks: true,
        });
        return;
    }
    await symlink(destinationTarget, destinationPath, await windowsSymlinkType(sourcePath));
}
async function remapSymbolicLinkTarget(input) {
    const absoluteSourceTarget = path.resolve(path.dirname(input.sourcePath), input.sourceTarget);
    const canonicalSourceTarget = isSameOrChild(input.sourceRoot, absoluteSourceTarget)
        ? absoluteSourceTarget
        : await canonicalizeSymbolicLinkTarget(absoluteSourceTarget);
    if (isSameOrChild(input.sourceRoot, canonicalSourceTarget)) {
        const destinationTarget = path.join(input.destinationRoot, path.relative(input.sourceRoot, canonicalSourceTarget));
        return path.relative(path.dirname(input.destinationPath), destinationTarget) || '.';
    }
    return path.isAbsolute(input.sourceTarget) ? input.sourceTarget : canonicalSourceTarget;
}
async function windowsSymlinkType(sourcePath) {
    if (process.platform !== 'win32')
        return undefined;
    try {
        return (await promisesStat(sourcePath)).isDirectory() ? 'dir' : 'file';
    }
    catch {
        return undefined;
    }
}
async function canonicalizeSymbolicLinkTarget(candidate) {
    try {
        return await canonicalizeProspectivePath(candidate);
    }
    catch {
        // Broken, cyclic, or inaccessible targets are valid link metadata. The
        // canonical form is only needed to recognize path aliases inside source.
        return candidate;
    }
}
async function fingerprintPersistentTree(sourceRoot) {
    if (!(await pathExists(sourceRoot)))
        return 'missing';
    const hash = createHash('sha256');
    await appendDirectoryFingerprint(hash, sourceRoot, '');
    return hash.digest('hex');
}
async function appendDirectoryFingerprint(hash, sourceRoot, relativeDirectory) {
    const entries = await readdir(path.join(sourceRoot, relativeDirectory), { withFileTypes: true });
    await runSequentially(entries.sort((left, right) => left.name.localeCompare(right.name)), async (entry) => {
        const relativePath = path.join(relativeDirectory, entry.name);
        if (excludeFromFingerprint(relativePath))
            return;
        const sourcePath = path.join(sourceRoot, relativePath);
        const stat = await lstat(sourcePath);
        if (stat.isSymbolicLink()) {
            const sourceTarget = await readlink(sourcePath);
            hash.update(`l:${normalizeRelativePath(relativePath)}:${JSON.stringify(sourceTarget)}:` +
                `${stat.mtimeMs}:${stat.mode & 0o777}\n`);
            return;
        }
        if (stat.isDirectory()) {
            hash.update(`d:${normalizeRelativePath(relativePath)}\n`);
            await appendDirectoryFingerprint(hash, sourceRoot, relativePath);
            return;
        }
        if (!stat.isFile()) {
            if (stat.isSocket() || stat.isFIFO())
                return;
            throw new Error(`Refusing to fingerprint special source dataDir entry: ${relativePath}`);
        }
        hash.update(`f:${normalizeRelativePath(relativePath)}:${stat.size}:${stat.mtimeMs}:${stat.mode & 0o777}\n`);
    });
}
function excludeFromCopy(relativePath) {
    if (excludeFromFingerprint(relativePath))
        return true;
    return /-shm$/iu.test(path.basename(relativePath));
}
function excludeFromFingerprint(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const segments = normalized.split('/');
    if (['local-runtime.auth.json', 'electron-performance.json'].includes(segments[0] ?? '')) {
        return true;
    }
    if (['logs', 'tmp', 'debug'].includes(segments[0] ?? ''))
        return true;
    if (segments[0] === 'v2' && segments[1] === 'observability')
        return true;
    return /\.(?:lock|pid|sock|socket|tmp)$/iu.test(segments.at(-1) ?? '');
}
async function readReadyManifest(dataDir, sourceDataDir) {
    try {
        const raw = await readFile(path.join(dataDir, MANIFEST_FILE), 'utf8');
        const manifest = JSON.parse(raw);
        return manifest.version === MANIFEST_VERSION &&
            manifest.status === 'ready' &&
            manifest.sourceDataDir === sourceDataDir &&
            manifest.copyPolicy === COPY_POLICY
            ? manifest
            : undefined;
    }
    catch {
        return undefined;
    }
}
async function canonicalizeProspectivePath(candidate) {
    return canonicalizeFromExistingAncestor(path.resolve(candidate), []);
}
async function canonicalizeFromExistingAncestor(cursor, suffix) {
    try {
        return path.join(await realpath(cursor), ...suffix);
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT')
            throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor)
            throw error;
        return canonicalizeFromExistingAncestor(parent, [path.basename(cursor), ...suffix]);
    }
}
async function pathExists(candidate) {
    try {
        await lstat(candidate);
        return true;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function assertDisjointPaths(left, right) {
    if (isSameOrChild(left, right) || isSameOrChild(right, left)) {
        throw new Error(`Source and managed isolation paths must be disjoint: ${left} <> ${right}`);
    }
}
function assertManagedChild(parent, child) {
    if (!isSameOrChild(parent, child) || path.resolve(parent) === path.resolve(child)) {
        throw new Error(`Unsafe local runtime test isolation path: ${child}`);
    }
}
function isSameOrChild(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
function normalizeRelativePath(value) {
    return value.split(path.sep).join('/');
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
function runSequentially(items, task) {
    return items.reduce((pending, item) => pending.then(() => task(item)), Promise.resolve());
}
