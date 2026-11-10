import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { ModelAccessPackageError } from '../errors.js';
const ZIP_LIMITS = {
    archiveBytes: 64 * 1024 * 1024,
    entries: 512,
    fileBytes: 32 * 1024 * 1024,
    totalBytes: 64 * 1024 * 1024,
    depth: 16,
};
const PORTABLE_SEGMENT = /^[a-zA-Z0-9_@.-]+$/u;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
function fail(code) {
    throw new ModelAccessPackageError(code);
}
/** `{kind, path}` from a request; a bare string keeps the folder meaning of older callers. */
export function parsePackageSource(value) {
    if (typeof value === 'string')
        return sourceFromPath(value);
    if (!value || typeof value !== 'object')
        fail('invalid_package');
    const { kind, path: target } = value;
    if (typeof target !== 'string' || !path.isAbsolute(target) || target.length > 4096)
        fail('invalid_package');
    if (kind === 'dir' || kind === 'zip')
        return { kind, path: target };
    return fail('invalid_package');
}
function sourceFromPath(value) {
    if (!path.isAbsolute(value) || value.length > 4096)
        fail('invalid_package');
    return value.toLowerCase().endsWith('.zip')
        ? { kind: 'zip', path: value }
        : { kind: 'dir', path: value };
}
/**
 * Turns a source into a package directory for the existing snapshot path. A folder is used as
 * is (the snapshot copies exact bytes); a zip is extracted into a private staging directory under
 * the profile, with every entry checked before anything is written.
 */
export async function materializePackageSource(source, profileRoot) {
    if (source.kind === 'dir')
        return { root: await withRealParent(source.path), release: async () => { } };
    return extractZip(await withRealParent(source.path), profileRoot);
}
/**
 * Resolves symlinked ancestors (macOS `/var`, `/tmp`) so the snapshot reader's no-symlink rule
 * applies to the package itself, not to where the user keeps it. The last segment is kept, so a
 * package root that is itself a symlink is still rejected.
 */
async function withRealParent(target) {
    const resolved = path.resolve(target);
    try {
        return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
    }
    catch {
        return resolved;
    }
}
/** The archive as a bounded zip; any unreadable or oversized archive is refused. */
async function loadZip(archivePath) {
    let info;
    try {
        info = await lstat(archivePath);
    }
    catch {
        return fail('invalid_package');
    }
    if (!info.isFile())
        fail('invalid_package');
    if (info.size > ZIP_LIMITS.archiveBytes)
        fail('package_too_large');
    try {
        return await JSZip.loadAsync(await readFile(archivePath));
    }
    catch {
        return fail('invalid_package');
    }
}
/** Writes the checked entries under `staging`, counting what actually inflated. */
async function writeEntries(entries, staging) {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    let total = 0;
    for (const entry of entries) {
        const target = path.join(staging, ...entry.path.split('/'));
        if (entry.directory) {
            await mkdir(target, { recursive: true, mode: 0o700 });
            continue;
        }
        const content = await entry.file.async('nodebuffer');
        total += content.length;
        // Declared sizes can lie: count what actually inflated.
        if (content.length > ZIP_LIMITS.fileBytes || total > ZIP_LIMITS.totalBytes)
            fail('package_too_large');
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
}
async function extractZip(archivePath, profileRoot) {
    const entries = checkedEntries(await loadZip(archivePath));
    const staging = path.join(profileRoot, 'staging', `import-${randomUUID()}`);
    const release = async () => {
        try {
            await rm(staging, { recursive: true, force: true });
        }
        catch {
            /* Best effort: staging lives under the profile and is swept later. */
        }
    };
    try {
        await writeEntries(entries, staging);
        return { root: staging, release };
    }
    catch (error) {
        await release();
        if (error instanceof ModelAccessPackageError)
            throw error;
        return fail('invalid_package');
    }
}
/**
 * Validates every name before extraction: no traversal, absolute or non-portable paths, no
 * symlinks or special files, bounded count/depth. A single wrapping folder (as made by
 * "Compress" in Finder/Explorer) is stripped when the manifest is not at the root.
 */
function checkedEntries(zip) {
    const all = Object.values(zip.files).filter((entry) => !isMetadata(entry.name));
    if (all.length === 0 || all.length > ZIP_LIMITS.entries)
        fail('package_too_large');
    for (const entry of all)
        if (!safeEntryKind(entry))
            fail('invalid_package');
    const names = all.map((entry) => entry.name.replace(/\/$/u, ''));
    const prefix = names.includes('model-access.json') ? '' : wrappingFolder(names);
    const seen = new Set();
    return all.flatMap((entry) => {
        const name = entry.name.replace(/\/$/u, '');
        if (prefix && name === prefix.slice(0, -1))
            return [];
        if (!name.startsWith(prefix))
            fail('invalid_package');
        const relative = name.slice(prefix.length);
        if (!portablePath(relative))
            fail('invalid_package');
        const key = relative.toLowerCase();
        if (seen.has(key))
            fail('invalid_package');
        seen.add(key);
        return [{ path: relative, directory: entry.dir, file: entry }];
    });
}
/** A regular file or directory whose stored name is the name shown. */
function safeEntryKind(entry) {
    if (entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name)
        return false;
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
    const type = mode & 0o170000;
    return type === 0 || type === 0o100000 || type === 0o040000;
}
function portableSegment(part) {
    return (PORTABLE_SEGMENT.test(part) &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.') &&
        !RESERVED.test(part));
}
/** A relative path every platform can extract, within the depth limit. */
function portablePath(relative) {
    const segments = relative.split('/');
    return !!relative && segments.length <= ZIP_LIMITS.depth && segments.every(portableSegment);
}
function wrappingFolder(names) {
    const first = names[0]?.split('/')[0];
    if (!first || names.some((name) => name.split('/')[0] !== first))
        fail('invalid_package');
    if (!names.includes(`${first}/model-access.json`))
        fail('invalid_package');
    return `${first}/`;
}
/** Finder/Explorer metadata that is never part of a package. */
function isMetadata(name) {
    return (name.startsWith('__MACOSX/') ||
        name.split('/').some((part) => part === '.DS_Store' || part === 'Thumbs.db'));
}
//# sourceMappingURL=sources.js.map