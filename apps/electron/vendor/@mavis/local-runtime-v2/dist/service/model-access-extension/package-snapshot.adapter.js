import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseModelAccessManifest } from '@minimax/model-access-sdk';
import { ModelAccessPackageError } from './errors.js';
import { validatePackageModules } from './package-modules.js';
const MANIFEST = 'model-access.json';
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const LIMITS = {
    entries: 512,
    depth: 16,
    fileBytes: 32 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
};
const PORTABLE = /^[a-zA-Z0-9_@.-]+$/u;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
function fail(code) {
    throw new ModelAccessPackageError(code);
}
function same(a, b) {
    return (a.dev === b.dev &&
        a.ino === b.ino &&
        a.size === b.size &&
        a.mtimeMs === b.mtimeMs &&
        a.ctimeMs === b.ctimeMs);
}
function compare(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}
function validateName(name, seen) {
    if (!PORTABLE.test(name) ||
        name === '.' ||
        name === '..' ||
        name.endsWith('.') ||
        RESERVED.test(name) ||
        seen.has(name.toLowerCase()))
        fail('invalid_package');
    seen.add(name.toLowerCase());
}
async function physicalDirectory(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() ||
        info.isSymbolicLink() ||
        (await realpath(directory)) !== path.resolve(directory))
        fail('invalid_package');
    return info;
}
async function readExact(handle, size) {
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < content.length) {
        const result = await handle.read(content, offset, content.length - offset, offset);
        if (result.bytesRead === 0)
            fail('package_changed');
        offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, size)).bytesRead)
        fail('package_changed');
    return content;
}
async function readStableFile(filePath, snapshot, budget) {
    if (!snapshot.isFile() || snapshot.nlink !== 1)
        fail('invalid_package');
    if (snapshot.size > LIMITS.fileBytes || budget.bytes + snapshot.size > LIMITS.totalBytes)
        fail('package_too_large');
    const handle = await open(filePath, READ_FLAGS);
    try {
        const opened = await handle.stat();
        if (!same(snapshot, opened) || !opened.isFile() || (await realpath(filePath)) !== filePath)
            fail('package_changed');
        const content = await readExact(handle, snapshot.size);
        if (!same(opened, await handle.stat()) || !same(opened, await lstat(filePath)))
            fail('package_changed');
        budget.bytes += content.length;
        return content;
    }
    finally {
        await handle.close();
    }
}
async function walkPackage(root, relative, files, budget) {
    if (relative.split('/').length > LIMITS.depth)
        fail('package_too_large');
    const directory = path.join(root, relative);
    const before = await physicalDirectory(directory);
    const children = await readdir(directory, { withFileTypes: true });
    const seen = new Set();
    for (const child of children.sort((a, b) => compare(a.name, b.name))) {
        if (++budget.entries > LIMITS.entries)
            fail('package_too_large');
        validateName(child.name, seen);
        const fileRelative = relative ? `${relative}/${child.name}` : child.name;
        const filePath = path.join(root, fileRelative);
        const snapshot = await lstat(filePath);
        if (snapshot.isSymbolicLink())
            fail('invalid_package');
        if (snapshot.isDirectory())
            await walkPackage(root, fileRelative, files, budget);
        else
            files.set(fileRelative, await readStableFile(filePath, snapshot, budget));
    }
    if (!same(before, await lstat(directory)))
        fail('package_changed');
}
/** Read only explicit package roots. No symlinks, special files, or external dependencies copied. */
async function readPackage(root) {
    try {
        const canonical = path.resolve(root);
        const rootStat = await physicalDirectory(canonical);
        const files = new Map();
        const budget = { entries: 0, bytes: 0 };
        await walkPackage(canonical, '', files, budget);
        if (!same(rootStat, await lstat(canonical)))
            fail('package_changed');
        const raw = files.get(MANIFEST);
        if (!raw || raw.length > 256 * 1024)
            fail('invalid_package');
        const manifest = parseModelAccessManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
        if (!files.has(manifest.entry.slice(2)))
            fail('invalid_package');
        validatePresentationAssets(manifest, files);
        await validatePackageModules(files);
        const hash = createHash('sha256');
        for (const [name, content] of [...files].sort(([a], [b]) => compare(a, b))) {
            hash.update(JSON.stringify([name, content.length]));
            hash.update('\0');
            hash.update(content);
        }
        return {
            preview: Object.freeze({
                manifest,
                digest: `sha256:${hash.digest('hex')}`,
                fileCount: files.size,
                byteCount: budget.bytes,
            }),
            files,
        };
    }
    catch (error) {
        if (error instanceof ModelAccessPackageError)
            throw error;
        throw new ModelAccessPackageError('invalid_package');
    }
}
const ICON_LIMIT = 1024 * 1024;
function isImage(bytes) {
    const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    return png || jpeg || webp;
}
/** Package icons must exist in the package and be real PNG/JPEG/WebP files of at most 1 MiB. */
function validatePresentationAssets(manifest, files) {
    const entries = [
        ...Object.values(manifest.presentation?.providers ?? {}),
        ...Object.values(manifest.presentation?.sources ?? {}),
    ];
    for (const asset of entries.flatMap((entry) => [entry.icon, entry.darkIcon])) {
        if (!asset)
            continue;
        const bytes = files.get(asset.slice(2));
        if (!bytes || bytes.length > ICON_LIMIT || !isImage(bytes))
            fail('invalid_package');
    }
}
export async function previewLocalModelAccessPackage(root) {
    return (await readPackage(root)).preview;
}
export function modelAccessSnapshotPath(root, digest) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
        fail('integrity_failed');
    return path.join(root, 'snapshots', digest.slice(7));
}
async function publishSnapshot(staging, destination, expectedDigest) {
    try {
        await rename(staging, destination);
    }
    catch (error) {
        const exists = error &&
            typeof error === 'object' &&
            'code' in error &&
            ['EEXIST', 'ENOTEMPTY'].includes(String(error.code));
        if (!exists)
            throw error;
        if ((await readPackage(destination)).preview.digest !== expectedDigest)
            fail('integrity_failed');
    }
}
/** Copy exactly the bytes approved in preview, never import the mutable source directory. */
export async function snapshotLocalModelAccessPackage(root, source, expectedDigest) {
    const pkg = await readPackage(source);
    if (pkg.preview.digest !== expectedDigest)
        fail('package_changed');
    const destination = modelAccessSnapshotPath(root, expectedDigest);
    try {
        for (const parent of [root, path.join(root, 'staging'), path.join(root, 'snapshots')]) {
            await mkdir(parent, { recursive: true, mode: 0o700 });
            await physicalDirectory(parent);
        }
        const staging = path.join(root, 'staging', randomUUID());
        await mkdir(staging, { mode: 0o700 });
        for (const [relative, content] of pkg.files) {
            const file = path.join(staging, relative);
            await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await writeFile(file, content, { flag: 'wx', mode: 0o400 });
        }
        if ((await readPackage(staging)).preview.digest !== expectedDigest)
            fail('integrity_failed');
        await publishSnapshot(staging, destination, expectedDigest);
        return pkg.preview;
    }
    catch (error) {
        // Orphaned staging is non-active and never loaded; explicit maintenance may remove it.
        if (error instanceof ModelAccessPackageError)
            throw error;
        throw new ModelAccessPackageError('storage_failed');
    }
}
//# sourceMappingURL=package-snapshot.adapter.js.map