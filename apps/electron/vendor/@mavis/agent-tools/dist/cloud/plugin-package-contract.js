/**
 * MiniMax Plugin package V1 canonical tree contract.
 *
 * This is the Cloud consumer of the frozen P0-2 contract. Its behavior is
 * locked by the same checked-in vectors used by Desktop; do not evolve this
 * algorithm independently from the official marketplace contract.
 *
 * v1 cloud-runtime 与 v2 cloud-harness-server 共用（v1 原路径 re-export）。
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pluginPackageCacheKey } from './workspace-asset-names.js';
export const PLUGIN_PACKAGE_V1_LIMITS = {
    maxArchiveBytes: 64 * 1024 * 1024,
    maxArchiveEntries: 2_048,
    maxFiles: 1_024,
    maxFileBytes: 16 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    maxPathBytes: 512,
    maxSegmentBytes: 128,
    maxPathSegments: 16,
};
const CONTENT_MAGIC = Buffer.from('MINIMAX-PLUGIN-CONTENT-DIGEST\0', 'ascii');
const PORTABLE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const WINDOWS_RESERVED = new Set([
    'con',
    'prn',
    'aux',
    'nul',
    ...Array.from({ length: 9 }, (_value, index) => `com${index + 1}`),
    ...Array.from({ length: 9 }, (_value, index) => `lpt${index + 1}`),
]);
export class PluginPackageContractError extends Error {
    code;
    detail;
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
        this.detail = detail;
        this.name = 'PluginPackageContractError';
    }
}
export function validatePluginPortablePath(relativePath) {
    assertPortablePathShape(relativePath);
    const segments = relativePath.split('/');
    if (segments.length > PLUGIN_PACKAGE_V1_LIMITS.maxPathSegments) {
        fail('PATH_TOO_DEEP', `${JSON.stringify(relativePath)} has too many segments`);
    }
    for (const segment of segments)
        assertPortablePathSegment(segment, relativePath);
}
function assertPortablePathShape(relativePath) {
    if (!relativePath)
        fail('INVALID_PATH', 'path is empty');
    if (!/^[\x00-\x7f]*$/u.test(relativePath)) {
        fail('NON_PORTABLE_PATH', `${JSON.stringify(relativePath)} is not ASCII`);
    }
    if (relativePath.startsWith('/') ||
        relativePath.startsWith('\\') ||
        /^[A-Za-z]:[\\/]/u.test(relativePath)) {
        fail('ABSOLUTE_PATH', `${JSON.stringify(relativePath)} is absolute`);
    }
    if (relativePath.includes('\\')) {
        fail('BACKSLASH_PATH', `${JSON.stringify(relativePath)} contains a backslash`);
    }
    if (relativePath.endsWith('/')) {
        fail('INVALID_PATH', `${JSON.stringify(relativePath)} has a trailing slash`);
    }
    if (/[\x00-\x1f\x7f]/u.test(relativePath)) {
        fail('CONTROL_CHARACTER', `${JSON.stringify(relativePath)} contains a control character`);
    }
    if (Buffer.byteLength(relativePath, 'ascii') > PLUGIN_PACKAGE_V1_LIMITS.maxPathBytes) {
        fail('PATH_TOO_LONG', `${JSON.stringify(relativePath)} exceeds the path limit`);
    }
}
function assertPortablePathSegment(segment, relativePath) {
    if (!segment || segment === '.' || segment === '..') {
        fail('PATH_TRAVERSAL', `${JSON.stringify(relativePath)} has an empty/dot segment`);
    }
    if (Buffer.byteLength(segment, 'ascii') > PLUGIN_PACKAGE_V1_LIMITS.maxSegmentBytes) {
        fail('SEGMENT_TOO_LONG', `${JSON.stringify(segment)} exceeds the segment limit`);
    }
    if (!PORTABLE_SEGMENT_PATTERN.test(segment) || segment.endsWith('.')) {
        fail('NON_PORTABLE_PATH', `${JSON.stringify(segment)} is not portable`);
    }
    const [basename = ''] = segment.split('.', 1);
    if (WINDOWS_RESERVED.has(basename.toLowerCase())) {
        fail('WINDOWS_RESERVED_PATH', `${JSON.stringify(segment)} is reserved on Windows`);
    }
}
export function computePluginContentDigest(entries) {
    const files = validateEntries(entries, true);
    for (const file of files) {
        if ((file.compression ?? 'store') !== 'store') {
            fail('UNSUPPORTED_COMPRESSION', `${JSON.stringify(file.path)} is not STORE`);
        }
    }
    const hash = createContentHash(files.length);
    let totalBytes = 0;
    for (const file of files) {
        const content = file.content;
        if (content === undefined)
            fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
        updateFileHeader(hash, file.path, content.length);
        hash.update(content);
        totalBytes += content.length;
    }
    return {
        contentDigest: `sha256-tree-v1:${hash.digest('hex')}`,
        fileCount: files.length,
        totalBytes,
        files,
    };
}
export async function computePluginDirectoryDigest(root) {
    const entries = [];
    await collectDirectoryEntries(root, '', entries);
    const files = validateEntries(entries, false);
    const hash = createContentHash(files.length);
    let totalBytes = 0;
    for (const file of files) {
        const size = entrySize(file);
        updateFileHeader(hash, file.path, size);
        await hashStableRegularFile(root, file.path, size, hash);
        totalBytes += size;
    }
    return {
        contentDigest: `sha256-tree-v1:${hash.digest('hex')}`,
        fileCount: files.length,
        totalBytes,
    };
}
export function pluginDigestCacheKey(contentDigest) {
    const key = pluginPackageCacheKey(contentDigest);
    if (!key)
        fail('INVALID_CONTENT_DIGEST', 'content digest has an unsupported format');
    return key;
}
function validateEntries(entries, requireContent) {
    if (entries.length > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
        fail('TOO_MANY_ENTRIES', `${entries.length} entries exceed the limit`);
    }
    const state = createEntryValidationState();
    for (const entry of entries)
        validateEntry(entry, state);
    if (state.files.length > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
        fail('TOO_MANY_FILES', `${state.files.length} files exceed the limit`);
    }
    if (state.totalBytes > PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes) {
        fail('TOTAL_SIZE_LIMIT', `${state.totalBytes} bytes exceed the package limit`);
    }
    assertNoPathTypeConflicts(state.kindsByPath);
    if (requireContent)
        assertRequiredContent(state.files);
    return state.files.sort((left, right) => Buffer.from(left.path, 'ascii').compare(Buffer.from(right.path, 'ascii')));
}
function createEntryValidationState() {
    return {
        exactPaths: new Set(),
        portablePrefixes: new Map(),
        kindsByPath: new Map(),
        files: [],
        totalBytes: 0,
    };
}
function validateEntry(entry, state) {
    validatePluginPortablePath(entry.path);
    if (state.exactPaths.has(entry.path))
        fail('DUPLICATE_PATH', `duplicate ${entry.path}`);
    state.exactPaths.add(entry.path);
    registerPortablePrefixes(entry.path, state.portablePrefixes);
    state.kindsByPath.set(entry.path, entry.kind);
    assertSupportedEntryKind(entry);
    if (entry.kind === 'directory')
        return;
    const size = entrySize(entry);
    assertEntrySize(entry.path, size);
    state.files.push(entry);
    state.totalBytes += size;
}
function registerPortablePrefixes(relativePath, prefixes) {
    const segments = relativePath.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
        const prefix = segments.slice(0, index).join('/');
        const key = prefix.toLowerCase();
        const prior = prefixes.get(key);
        if (prior !== undefined && prior !== prefix)
            fail('CASE_COLLISION', `${prior} and ${prefix} collide`);
        prefixes.set(key, prefix);
    }
}
function assertSupportedEntryKind(entry) {
    if (entry.kind === 'symlink')
        fail('SYMLINK_NOT_ALLOWED', `${entry.path} is a symlink`);
    if (entry.kind === 'hardlink')
        fail('HARDLINK_NOT_ALLOWED', `${entry.path} is a hardlink`);
    if (entry.kind !== 'file' && entry.kind !== 'directory') {
        fail('SPECIAL_ENTRY_NOT_ALLOWED', `${entry.path} has kind ${entry.kind}`);
    }
}
function assertEntrySize(relativePath, size) {
    if (!Number.isSafeInteger(size) || size < 0) {
        fail('INVALID_SIZE', `${relativePath} has an invalid size`);
    }
    if (size > PLUGIN_PACKAGE_V1_LIMITS.maxFileBytes) {
        fail('FILE_TOO_LARGE', `${relativePath} exceeds the file limit`);
    }
}
function assertNoPathTypeConflicts(kindsByPath) {
    for (const [relativePath] of kindsByPath) {
        const segments = relativePath.split('/');
        for (let index = 1; index < segments.length; index += 1) {
            const parent = segments.slice(0, index).join('/');
            if (kindsByPath.get(parent) === 'file') {
                fail('PATH_TYPE_CONFLICT', `${parent} is a file parent of ${relativePath}`);
            }
        }
    }
}
function assertRequiredContent(files) {
    for (const file of files) {
        if (file.content === undefined)
            fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
        if (file.declaredSize !== undefined && file.declaredSize !== file.content.length) {
            fail('SIZE_MISMATCH', `${file.path} declared and actual sizes differ`);
        }
    }
}
function createContentHash(fileCount) {
    const hash = createHash('sha256');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(fileCount, 4);
    hash.update(CONTENT_MAGIC);
    hash.update(header);
    return hash;
}
function updateFileHeader(hash, relativePath, size) {
    const pathBytes = Buffer.from(relativePath, 'ascii');
    const header = Buffer.alloc(13);
    header.writeUInt8(0x46, 0);
    header.writeUInt32BE(pathBytes.length, 1);
    header.writeBigUInt64BE(BigInt(size), 5);
    hash.update(header.subarray(0, 5));
    hash.update(pathBytes);
    hash.update(header.subarray(5));
}
async function collectDirectoryEntries(root, relativeDirectory, output) {
    const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split('/')) : root;
    for (const child of await readdir(directory, { withFileTypes: true })) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        if (child.isSymbolicLink()) {
            output.push({ path: relativePath, kind: 'symlink' });
        }
        else if (child.isDirectory()) {
            output.push({ path: relativePath, kind: 'directory' });
            await collectDirectoryEntries(root, relativePath, output);
        }
        else if (child.isFile()) {
            const handle = await open(path.join(root, ...relativePath.split('/')), 'r');
            try {
                output.push({ path: relativePath, kind: 'file', declaredSize: (await handle.stat()).size });
            }
            finally {
                await handle.close();
            }
        }
        else {
            output.push({ path: relativePath, kind: 'special' });
        }
    }
}
async function hashStableRegularFile(root, relativePath, expectedSize, hash) {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(path.join(root, ...relativePath.split('/')), flags);
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size !== expectedSize) {
            fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
        }
        await hashFileBytes(handle, relativePath, expectedSize, hash);
        const extra = Buffer.allocUnsafe(1);
        if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
            fail('FILE_CHANGED_DURING_READ', `${relativePath} grew during digest`);
        }
        if (!sameFileSnapshot(before, await handle.stat())) {
            fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
        }
    }
    finally {
        await handle.close();
    }
}
async function hashFileBytes(handle, relativePath, expectedSize, hash) {
    let offset = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (offset < expectedSize) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expectedSize - offset), offset);
        if (bytesRead === 0)
            fail('FILE_CHANGED_DURING_READ', `${relativePath} was truncated`);
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
    }
}
function sameFileSnapshot(before, after) {
    return (before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs);
}
function entrySize(entry) {
    return entry.declaredSize ?? entry.content?.length ?? 0;
}
function fail(code, detail) {
    throw new PluginPackageContractError(code, detail);
}
//# sourceMappingURL=plugin-package-contract.js.map