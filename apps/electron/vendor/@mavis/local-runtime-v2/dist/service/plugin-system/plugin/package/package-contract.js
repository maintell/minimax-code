import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isRetryableWindowsFileError } from '@mavis/shared';
import { logger } from '../../../../infra/logging/logger.js';
import { KeyedOperationQueue } from '../../../../infra/util/keyed-operation-queue.js';
import { PluginSystemError } from '../../errors.js';
import { isMiniAppRuntimePayloadExcludedPath, isPathCoveredByRoots } from './miniapp/path.js';
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
const CONTENT_DIGEST_PATTERN = /^sha256-tree-v1:([0-9a-f]{64})$/u;
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
/**
 * Agent Plugins only require package paths to remain inside the Plugin root.
 * Keep the MiniMax marketplace's stricter cross-platform naming contract separate
 * so standards-compliant GitHub Plugins may contain ordinary names such as
 * `docs/(redirects)/guide.md` or non-ASCII assets.
 */
function validateAgentPluginPath(relativePath) {
    assertContainedPathShape(relativePath);
    const segments = relativePath.split('/');
    if (segments.length > PLUGIN_PACKAGE_V1_LIMITS.maxPathSegments) {
        fail('PATH_TOO_DEEP', `${JSON.stringify(relativePath)} has too many segments`);
    }
    for (const segment of segments)
        assertContainedPathSegment(segment, relativePath);
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
function assertContainedPathShape(relativePath) {
    if (!relativePath)
        fail('INVALID_PATH', 'path is empty');
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
    if (Buffer.byteLength(relativePath, 'utf8') > PLUGIN_PACKAGE_V1_LIMITS.maxPathBytes) {
        fail('PATH_TOO_LONG', `${JSON.stringify(relativePath)} exceeds the path limit`);
    }
}
function assertContainedPathSegment(segment, relativePath) {
    if (!segment || segment === '.' || segment === '..') {
        fail('PATH_TRAVERSAL', `${JSON.stringify(relativePath)} has an empty/dot segment`);
    }
    if (Buffer.byteLength(segment, 'utf8') > PLUGIN_PACKAGE_V1_LIMITS.maxSegmentBytes) {
        fail('SEGMENT_TOO_LONG', `${JSON.stringify(segment)} exceeds the segment limit`);
    }
    if (process.platform !== 'win32')
        return;
    if (/[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment)) {
        fail('HOST_PATH_UNSUPPORTED', `${JSON.stringify(segment)} is not supported on Windows`);
    }
    const [basename = ''] = segment.split('.', 1);
    if (WINDOWS_RESERVED.has(basename.toLowerCase())) {
        fail('WINDOWS_RESERVED_PATH', `${JSON.stringify(segment)} is reserved on Windows`);
    }
}
export function computePluginContentDigest(entries, options = {}) {
    const files = validateEntries(entries, true, options.pathPolicy ?? 'minimax-portable');
    for (const file of files) {
        if ((file.compression ?? 'store') !== 'store') {
            fail('UNSUPPORTED_COMPRESSION', `${JSON.stringify(file.path)} is not STORE`);
        }
    }
    const hash = createContentHash(files.length);
    let totalBytes = 0;
    for (const file of files) {
        const content = file.content;
        if (content === undefined) {
            fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
        }
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
export async function computePluginDirectoryDigest(root, options = {}) {
    const pathPolicy = options.pathPolicy ?? 'minimax-portable';
    const entries = [];
    await collectDirectoryEntries(root, '', entries, {
        entryCount: 0,
        fileCount: 0,
        totalBytes: 0,
        pathPolicy,
        rejectHardlinks: options.rejectHardlinks === true,
        ...(options.exclude ? { skip: options.exclude } : {}),
    });
    const files = validateEntries(entries, false, pathPolicy);
    const hash = createContentHash(files.length);
    let totalBytes = 0;
    for (const file of files) {
        const size = entrySize(file);
        updateFileHeader(hash, file.path, size);
        await hashStableRegularFile(root, file.path, size, {
            hashes: [hash],
            rejectHardlinks: options.rejectHardlinks === true,
        });
        totalBytes += size;
    }
    return {
        contentDigest: `sha256-tree-v1:${hash.digest('hex')}`,
        fileCount: files.length,
        totalBytes,
    };
}
export async function computeMiniAppPackageDigests(root, artifacts, options = {}) {
    const includeOrdinaryContentDigest = options.includeOrdinaryContentDigest === true;
    const files = await collectMiniAppFiles(root, artifacts, options);
    const miniAppFiles = includeOrdinaryContentDigest
        ? files.filter((file) => !isMiniAppRuntimePayloadExcludedPath(file.path))
        : files;
    const clientFiles = miniAppFiles.filter((file) => isPathCoveredByRoots(file.path, artifacts.client));
    const nodeFiles = miniAppFiles.filter((file) => isPathCoveredByRoots(file.path, artifacts.node));
    const ordinaryHash = includeOrdinaryContentDigest ? createContentHash(files.length) : undefined;
    const contentHash = createContentHash(miniAppFiles.length);
    const clientHash = createContentHash(clientFiles.length);
    const nodeHash = createContentHash(nodeFiles.length);
    for (const file of files) {
        const size = entrySize(file);
        const hashes = [];
        if (ordinaryHash) {
            updateFileHeader(ordinaryHash, file.path, size);
            hashes.push(ordinaryHash);
        }
        if (!isMiniAppRuntimePayloadExcludedPath(file.path)) {
            updateFileHeader(contentHash, file.path, size);
            hashes.push(contentHash);
            if (isPathCoveredByRoots(file.path, artifacts.client)) {
                updateFileHeader(clientHash, file.path, size);
                hashes.push(clientHash);
            }
            if (isPathCoveredByRoots(file.path, artifacts.node)) {
                updateFileHeader(nodeHash, file.path, size);
                hashes.push(nodeHash);
            }
        }
        await hashStableRegularFile(root, file.path, size, {
            hashes,
            rejectHardlinks: options.rejectHardlinks === true,
        });
    }
    return {
        contentDigest: `sha256-tree-v1:${contentHash.digest('hex')}`,
        clientDigest: `sha256-tree-v1:${clientHash.digest('hex')}`,
        nodeDigest: `sha256-tree-v1:${nodeHash.digest('hex')}`,
        ...(ordinaryHash
            ? { ordinaryContentDigest: `sha256-tree-v1:${ordinaryHash.digest('hex')}` }
            : {}),
    };
}
async function collectMiniAppFiles(root, artifacts, options = {}) {
    const entries = [];
    const artifactRoots = [...artifacts.client, ...artifacts.node];
    await collectDirectoryEntries(root, '', entries, {
        entryCount: 0,
        fileCount: 0,
        totalBytes: 0,
        pathPolicy: 'minimax-portable',
        rejectHardlinks: options.rejectHardlinks === true,
        skip: (relativePath) => {
            if (!isMiniAppRuntimePayloadExcludedPath(relativePath))
                return false;
            if (isPathCoveredByRoots(relativePath, artifactRoots)) {
                fail('MINIAPP_ARTIFACTS_EXCLUDED', `${relativePath} is excluded inside a declared runtime artifact`);
            }
            return options.includeOrdinaryContentDigest !== true;
        },
    });
    return validateEntries(entries, false, 'minimax-portable');
}
export function pluginDigestCacheKey(contentDigest) {
    const match = CONTENT_DIGEST_PATTERN.exec(contentDigest);
    if (!match)
        fail('INVALID_CONTENT_DIGEST', 'content digest has an unsupported format');
    return `sha256-tree-v1-${match[1]}`;
}
// Same-process publishers serialize by root; cross-process safety relies only on
// atomic rename and verification after a collision, not on this promise chain.
const publications = new KeyedOperationQueue();
const WINDOWS_CACHE_RETRIES = 4;
const WINDOWS_CACHE_RETRY_DELAY_MS = 50;
/**
 * Publishes `<parent>/<cacheKey>` content-addressed: staging → verify digest → rename. An
 * existing directory with the same digest is reused, also when a concurrent writer published it
 * first. A persistent Windows file lock may prevent staging cleanup.
 */
export async function materializeContentAddressedDirectory(input) {
    const holds = input.holds ??
        ((root, contentDigest) => holdsDirectoryDigest(root, contentDigest, input.digestOptions));
    await mkdir(input.parent, { recursive: true });
    const materialize = () => materializeStagedDirectory(input, holds);
    if (input.expectedDigest === undefined)
        return materialize();
    const root = path.resolve(input.parent, pluginDigestCacheKey(input.expectedDigest));
    return publications.run(root, materialize);
}
async function materializeStagedDirectory(input, holds) {
    if (input.expectedDigest !== undefined) {
        const cacheKey = pluginDigestCacheKey(input.expectedDigest);
        const root = path.join(input.parent, cacheKey);
        if (await holds(root, input.expectedDigest)) {
            return { cacheKey, root, contentDigest: input.expectedDigest, reused: true };
        }
    }
    const staging = await mkdtemp(path.join(input.parent, input.stagingPrefix));
    try {
        await input.populate(staging);
        const { contentDigest } = await computePluginDirectoryDigest(staging, input.digestOptions);
        if (input.expectedDigest !== undefined && contentDigest !== input.expectedDigest) {
            throw input.mismatchError?.() ?? new Error('staged content does not match its digest');
        }
        const cacheKey = pluginDigestCacheKey(contentDigest);
        const root = path.join(input.parent, cacheKey);
        const publish = async () => {
            input.beforePublish?.();
            // Known up front, the existing directory was checked before populating.
            const reused = (input.expectedDigest === undefined && (await holds(root, contentDigest))) ||
                (await publishStaged(staging, root, (candidateRoot) => holds(candidateRoot, contentDigest), input.beforePublish));
            return { cacheKey, root, contentDigest, reused };
        };
        return await (input.expectedDigest === undefined
            ? publications.run(path.resolve(root), publish)
            : publish());
    }
    finally {
        await removeStagingDirectory(staging);
    }
}
/** Renames staging into place; `true` when a concurrent writer of the same content won. */
async function publishStaged(staging, root, holds, beforeRetry) {
    const move = () => renameStagedDirectory(staging, root, beforeRetry);
    try {
        await move();
        return false;
    }
    catch (error) {
        if (!isPublicationCollision(error) && !isRetryableWindowsFileError(error))
            throw error;
        if (await holds(root))
            return true;
        if (!isPublicationCollision(error))
            throw error;
    }
    const aside = `${root}.corrupt-${randomUUID()}`;
    try {
        await rename(root, aside);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        return renameOrReuse(move, root, holds);
    }
    if (await holdsQuarantinedDirectory(aside, holds)) {
        // A cross-process winner may have replaced the damaged root before quarantine.
        // Putting it back leaves a transient ENOENT for readers, as the pre-refactor rm
        // path did; profile-level dataDir isolation makes same-root cross-process writes rare.
        await restoreQuarantinedDirectory(aside, root, holds);
        await rm(aside, { recursive: true, force: true });
        return true;
    }
    try {
        return await renameOrReuse(move, root, holds);
    }
    finally {
        await rm(aside, { recursive: true, force: true });
    }
}
async function renameStagedDirectory(staging, root, beforeRetry) {
    for (let attempt = 0;; attempt++) {
        try {
            return await rename(staging, root);
        }
        catch (error) {
            if (!isRetryableWindowsFileError(error))
                throw error;
            // An existing destination must go through digest verification and collision recovery.
            if (await canStatDestination(root))
                throw error;
            const exhausted = attempt >= WINDOWS_CACHE_RETRIES;
            logger.warn({
                cacheKey: path.basename(root),
                code: error.code,
                attempt: attempt + 1,
                outcome: exhausted ? 'exhausted' : 'retrying',
            }, '[plugin-cache] Windows denied staged directory publication');
            if (exhausted) {
                throw new PluginSystemError('PLUGIN_CACHE_BUSY', 'Plugin cache is in use', {
                    cause: error,
                });
            }
            await delay(WINDOWS_CACHE_RETRY_DELAY_MS * (attempt + 1));
            beforeRetry?.();
        }
    }
}
async function canStatDestination(root) {
    try {
        await lstat(root);
        return true;
    }
    catch (error) {
        // A locked lookup uses the same retry budget as the rename.
        if (error.code === 'ENOENT' || isRetryableWindowsFileError(error))
            return false;
        throw error;
    }
}
async function removeStagingDirectory(staging) {
    const onWindows = process.platform === 'win32';
    try {
        await rm(staging, {
            recursive: true,
            force: true,
            maxRetries: onWindows ? WINDOWS_CACHE_RETRIES : 0,
            retryDelay: WINDOWS_CACHE_RETRY_DELAY_MS,
        });
    }
    catch (error) {
        // Preserve the publication outcome if a Windows handle still blocks staging cleanup.
        const { code } = error;
        if (!isRetryableWindowsFileError(error) && !(onWindows && code === 'ENOTEMPTY'))
            throw error;
        logger.warn({ staging: path.basename(staging), code }, '[plugin-cache] Windows retained a locked staging directory after cleanup retries');
    }
}
async function renameOrReuse(move, root, holds) {
    try {
        await move();
        return false;
    }
    catch (error) {
        if (!isPublicationCollision(error) && !isRetryableWindowsFileError(error))
            throw error;
        if (await holds(root))
            return true;
        throw error;
    }
}
async function holdsQuarantinedDirectory(root, holds) {
    try {
        return await holds(root);
    }
    catch {
        // Once quarantined, an unverifiable entry is damaged and must be cleaned up.
        return false;
    }
}
async function restoreQuarantinedDirectory(aside, root, holds) {
    const displaced = `${root}.corrupt-${randomUUID()}`;
    let removeDisplaced = true;
    let restorationFailure;
    try {
        try {
            await renameOrReuse(() => rename(aside, root), root, holds);
            return;
        }
        catch (error) {
            if (!isPublicationCollision(error))
                throw error;
        }
        // One bounded retry: move the invalid interloper out before restoring the winner.
        try {
            await rename(root, displaced);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        // The interloper could itself have been replaced by another valid winner.
        removeDisplaced = !(await holdsQuarantinedDirectory(displaced, holds));
        await renameOrReuse(() => rename(aside, root), root, holds);
        removeDisplaced = true;
    }
    catch (error) {
        const retained = removeDisplaced ? aside : `${aside}, ${displaced}`;
        restorationFailure = new Error(`could not restore valid quarantined directory; retained at ${retained}`, { cause: error });
    }
    finally {
        if (removeDisplaced)
            await cleanupDisplacedDirectory(displaced, aside, restorationFailure);
    }
    if (restorationFailure)
        throw restorationFailure;
}
async function cleanupDisplacedDirectory(displaced, aside, restorationFailure) {
    try {
        await rm(displaced, { recursive: true, force: true });
    }
    catch (cleanupFailure) {
        const retained = [displaced];
        try {
            await lstat(aside);
            retained.unshift(aside);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                retained.unshift(aside);
        }
        throw new Error(`${restorationFailure?.message ?? 'quarantine restoration completed'}; cleanup failed; retained at ${retained.join(', ')}`, {
            cause: restorationFailure
                ? new AggregateError([restorationFailure, cleanupFailure])
                : cleanupFailure,
        });
    }
}
function isPublicationCollision(error) {
    const code = error.code;
    return (code === 'EEXIST' ||
        code === 'ENOTEMPTY' ||
        code === 'ENOTDIR' ||
        (code === 'EPERM' && process.platform === 'win32'));
}
async function holdsDirectoryDigest(root, contentDigest, options) {
    try {
        const stat = await lstat(root);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            return false;
        return (await computePluginDirectoryDigest(root, options)).contentDigest === contentDigest;
    }
    catch {
        return false;
    }
}
function validateEntries(entries, requireContent, pathPolicy) {
    if (entries.length > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
        fail('TOO_MANY_ENTRIES', `${entries.length} entries exceed the limit`);
    }
    const state = createEntryValidationState();
    for (const entry of entries)
        validateEntry(entry, state, pathPolicy);
    if (state.files.length > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
        fail('TOO_MANY_FILES', `${state.files.length} files exceed the limit`);
    }
    if (state.totalBytes > PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes) {
        fail('TOTAL_SIZE_LIMIT', `${state.totalBytes} bytes exceed the package limit`);
    }
    assertNoPathTypeConflicts(state.kindsByPath);
    if (requireContent)
        assertRequiredContent(state.files);
    return state.files.sort((left, right) => Buffer.from(left.path.normalize('NFC'), 'utf8').compare(Buffer.from(right.path.normalize('NFC'), 'utf8')));
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
function validateEntry(entry, state, pathPolicy) {
    validatePackagePath(entry.path, pathPolicy);
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
        const key = prefix.normalize('NFC').toLocaleLowerCase('en-US');
        const prior = prefixes.get(key);
        if (prior !== undefined && prior !== prefix) {
            fail('CASE_COLLISION', `${prior} and ${prefix} collide`);
        }
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
        if (file.content === undefined) {
            fail('VECTOR_CONTENT_MISSING', `${file.path} has no content`);
        }
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
    const pathBytes = Buffer.from(relativePath.normalize('NFC'), 'utf8');
    const header = Buffer.alloc(13);
    header.writeUInt8(0x46, 0);
    header.writeUInt32BE(pathBytes.length, 1);
    header.writeBigUInt64BE(BigInt(size), 5);
    hash.update(header.subarray(0, 5));
    hash.update(pathBytes);
    hash.update(header.subarray(5));
}
async function collectDirectoryEntries(root, relativeDirectory, output, limits) {
    const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split('/')) : root;
    const handle = await opendir(directory);
    for await (const child of handle) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        if (limits.skip?.(relativePath))
            continue;
        const entry = await inspectDirectoryEntry(root, relativePath, child, limits);
        output.push(entry);
        if (entry.kind === 'directory') {
            await collectDirectoryEntries(root, relativePath, output, limits);
        }
    }
}
async function inspectDirectoryEntry(root, relativePath, child, limits) {
    validatePackagePath(relativePath, limits.pathPolicy);
    limits.entryCount += 1;
    if (limits.entryCount > PLUGIN_PACKAGE_V1_LIMITS.maxArchiveEntries) {
        fail('TOO_MANY_ENTRIES', `${limits.entryCount} entries exceed the limit`);
    }
    if (child.isSymbolicLink())
        fail('SYMLINK_NOT_ALLOWED', `${relativePath} is a symlink`);
    if (child.isDirectory())
        return { path: relativePath, kind: 'directory' };
    if (!child.isFile()) {
        fail('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} has an unsupported kind`);
    }
    return inspectDirectoryFile(root, relativePath, limits);
}
function validatePackagePath(relativePath, policy) {
    if (policy === 'unrestricted') {
        assertContainedPathShape(relativePath);
        return;
    }
    if (policy === 'agent-plugin')
        validateAgentPluginPath(relativePath);
    else
        validatePluginPortablePath(relativePath);
}
async function inspectDirectoryFile(root, relativePath, limits) {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const fileHandle = await open(path.join(root, ...relativePath.split('/')), flags);
    try {
        const stat = await fileHandle.stat();
        if (!stat.isFile())
            fail('SPECIAL_ENTRY_NOT_ALLOWED', `${relativePath} is not a file`);
        if (stat.nlink > 1)
            fail('HARDLINK_NOT_ALLOWED', `${relativePath} is a hardlink`);
        assertEntrySize(relativePath, stat.size);
        limits.fileCount += 1;
        if (limits.fileCount > PLUGIN_PACKAGE_V1_LIMITS.maxFiles) {
            fail('TOO_MANY_FILES', `${limits.fileCount} files exceed the limit`);
        }
        limits.totalBytes += stat.size;
        if (limits.totalBytes > PLUGIN_PACKAGE_V1_LIMITS.maxTotalBytes) {
            fail('TOTAL_SIZE_LIMIT', `${limits.totalBytes} bytes exceed the package limit`);
        }
        return { path: relativePath, kind: 'file', declaredSize: stat.size };
    }
    finally {
        await fileHandle.close();
    }
}
async function hashStableRegularFile(root, relativePath, expectedSize, options) {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await open(path.join(root, ...relativePath.split('/')), flags);
    try {
        const before = await handle.stat();
        if (!before.isFile() ||
            before.size !== expectedSize ||
            (options.rejectHardlinks && before.nlink !== 1)) {
            fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
        }
        await hashFileBytes(handle, relativePath, expectedSize, options.hashes);
        const extra = Buffer.allocUnsafe(1);
        if ((await handle.read(extra, 0, 1, expectedSize)).bytesRead !== 0) {
            fail('FILE_CHANGED_DURING_READ', `${relativePath} grew during digest`);
        }
        const after = await handle.stat();
        if (options.rejectHardlinks && after.nlink !== 1) {
            fail('HARDLINK_NOT_ALLOWED', `${relativePath} is a hardlink`);
        }
        if (!sameFileSnapshot(before, after)) {
            fail('FILE_CHANGED_DURING_READ', `${relativePath} changed during digest`);
        }
    }
    finally {
        await handle.close();
    }
}
async function hashFileBytes(handle, relativePath, expectedSize, hashes) {
    let offset = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (offset < expectedSize) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, expectedSize - offset), offset);
        if (bytesRead === 0)
            fail('FILE_CHANGED_DURING_READ', `${relativePath} was truncated`);
        for (const hash of hashes)
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
//# sourceMappingURL=package-contract.js.map