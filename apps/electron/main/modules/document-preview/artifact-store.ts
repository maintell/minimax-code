import { randomUUID, randomBytes } from "node:crypto";
import { constants, lstatSync, realpathSync, openSync, fstatSync, closeSync } from "node:fs";
import { open, lstat, realpath, mkdir, unlink, readdir, rmdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { app } from "electron";
import { PPTX_PREVIEW_LIMITS_V1, PPTX_DOM_BACKEND_ID_V1, safePreviewDiagnosticV1, normalizePreviewBackendIdV1, PPTX_DOM_BACKEND_VERSION_V1, buildPreviewArtifactResourceUrlV1, assertPreviewArtifactManifestV1 } from "@mavis/shared/document-preview";
export { buildArtifactCacheKey } from "./artifact-key";

const CACHE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const RESOURCE_NAME = /^[^\\/\u0000-\u001f\u007f]{1,512}$/u;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;
const CACHE_SCHEMA = 'mavis.preview_artifact_cache.v1';
const MAX_RESOURCES = 16;
const MAX_ENTRY_METADATA_BYTES = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 10;
const DEFAULT_MAX_BYTES = PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LEASES = 32;
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_UNLEASED_ARTIFACT_TTL_MS = 60 * 1000;
const ARTIFACT_TOO_LARGE = 'resource_limit_exceeded';
const ARTIFACT_BACKENDS = new Set([
    'docx-preview',
    'sheetjs-grid',
    PPTX_DOM_BACKEND_ID_V1,
    'libreoffice-native',
]);
const ARTIFACT_KINDS = new Set([
    'html-document.v1',
    'pdf.v1',
    'paged-raster.v1',
    'workbook-grid.v1',
]);
function defaultRootDir() {
    try {
        return path.join(app.getPath('userData'), 'document-preview', 'artifacts');
    }
    catch {
        // The fallback is only useful for unit tests importing the module without
        // a fully initialised Electron app. Production always has userData.
        return path.join(tmpdir(), 'mavis-document-preview', 'artifacts');
    }
}
function failure(code, message, retryable = false, backendId) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable,
            ...(backendId ? { backendId } : {}),
        },
    };
}
function isContained(root, candidate) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return (relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));
}
function isRedirectingStat(info) {
    // Node reports POSIX symlinks and Windows junctions as symbolic links from
    // lstat().  The explicit helper keeps every boundary check reviewable and
    // gives us one place to add a native reparse probe if Node exposes one.
    return info.isSymbolicLink();
}
function identityFromStats(info) {
    const size = typeof info.size === 'bigint' ? Number(info.size) : info.size;
    return {
        dev: String(info.dev),
        ino: String(info.ino),
        size,
        mtimeNs: info.mtimeNs !== undefined
            ? String(info.mtimeNs)
            : String(typeof info.mtimeMs === 'bigint'
                ? info.mtimeMs
                : Math.round((info.mtimeMs ?? 0) * 1000000)),
        ctimeNs: info.ctimeNs !== undefined
            ? String(info.ctimeNs)
            : String(typeof info.ctimeMs === 'bigint'
                ? info.ctimeMs
                : Math.round((info.ctimeMs ?? 0) * 1000000)),
    };
}
function sameFileIdentity(left, right) {
    // Some Windows filesystems expose zero for dev/ino.  In that case the
    // timestamp/size tuple is still useful, while non-zero identities must all
    // match to reject same-size replacement files.
    const identityMatches = (left.dev === '0' || right.dev === '0' || left.dev === right.dev) &&
        (left.ino === '0' || right.ino === '0' || left.ino === right.ino);
    return (identityMatches &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs);
}
function isValidFileIdentity(value) {
    if (!value || typeof value !== 'object')
        return false;
    const candidate = value;
    return (typeof candidate.dev === 'string' &&
        typeof candidate.ino === 'string' &&
        Number.isSafeInteger(candidate.size) &&
        candidate.size >= 0 &&
        typeof candidate.mtimeNs === 'string' &&
        typeof candidate.ctimeNs === 'string');
}
async function readFileNoFollow(filePath) {
    let handle = null;
    try {
        handle = await open(filePath, openFlagsNoFollow());
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || isRedirectingStat(info) || info.size > BigInt(MAX_ENTRY_METADATA_BYTES))
            throw new Error('invalid metadata file');
        return await handle.readFile('utf8');
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
function openFlagsNoFollow() {
    // O_NOFOLLOW is not implemented by Windows.  lstat + descriptor identity
    // checks below provide the equivalent fail-closed behaviour there.
    return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}
function createFlagsNoFollow() {
    return (constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0));
}
async function writeFileNoFollow(filePath, contents) {
    let handle = null;
    try {
        handle = await open(filePath, createFlagsNoFollow(), 0o600);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
async function nearestExistingParent(target) {
    let current = path.resolve(target);
    while (true) {
        try {
            await lstat(current);
            return current;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            const parent = path.dirname(current);
            if (parent === current)
                return current;
            current = parent;
        }
    }
}
/**
 * Create a directory one component at a time, rejecting links at the
 * application-owned boundary.  Ancestors supplied by the OS (for example
 * macOS /var -> /private/var) are canonicalised before we start creating user
 * controlled components.
 */
async function ensureDirectoryNoFollow(directory) {
    const resolved = path.resolve(directory);
    const existing = await nearestExistingParent(resolved);
    const existingInfo = await lstat(existing);
    if (!existingInfo.isDirectory() || isRedirectingStat(existingInfo))
        throw new Error('artifact directory parent is not a real directory');
    const canonicalExisting = await realpath(existing);
    const relative = path.relative(existing, resolved);
    let current = canonicalExisting;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        let info;
        try {
            info = await lstat(current);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            await mkdir(current);
            info = await lstat(current);
        }
        if (!info.isDirectory() || isRedirectingStat(info))
            throw new Error('artifact directory contains a redirecting path component');
    }
    return current;
}
async function walkNoFollow(root, candidate) {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    if (!isContained(resolvedRoot, resolvedCandidate))
        return false;
    try {
        const rootInfo = await lstat(resolvedRoot);
        if (!rootInfo.isDirectory() || isRedirectingStat(rootInfo))
            return false;
        const canonicalRoot = await realpath(resolvedRoot);
        const canonicalCandidate = await realpath(resolvedCandidate);
        if (!isContained(canonicalRoot, canonicalCandidate))
            return false;
        const relative = path.relative(resolvedRoot, resolvedCandidate);
        let current = resolvedRoot;
        for (const component of relative.split(path.sep).filter(Boolean)) {
            current = path.join(current, component);
            const info = await lstat(current);
            if (isRedirectingStat(info))
                return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
/** Remove a tree without ever recursively following a redirecting entry. */
async function removeNoFollow(target) {
    let info;
    try {
        info = await lstat(target);
    }
    catch {
        return;
    }
    if (isRedirectingStat(info) || !info.isDirectory()) {
        await unlink(target).catch(() => undefined);
        return;
    }
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
        await removeNoFollow(path.join(target, entry.name));
    await rmdirNoFollow(target);
}
async function rmdirNoFollow(target) {
    // rm(..., recursive:false) unlinks a directory itself and cannot follow a
    // link; keeping it isolated makes the intent explicit for Windows too.
    await rmdir(target).catch(() => undefined);
}
function cacheDir(rootDir, cacheKey) {
    if (!isValidCacheKey(cacheKey))
        throw new TypeError('invalid artifact cache key');
    return path.join(rootDir, 'cache', cacheKey);
}
export function cacheEntryPath(rootDir, cacheKey) {
    return path.join(cacheDir(rootDir, cacheKey), 'entry.json');
}
function isValidCacheKey(value) {
    return typeof value === 'string' && CACHE_KEY.test(value);
}
function isValidResourceId(value) {
    return typeof value === 'string' && RESOURCE_ID.test(value);
}
function safeRelativeName(value) {
    return (RESOURCE_NAME.test(value) && path.basename(value) === value && value !== '.' && value !== '..');
}
function artifactLimitMessage(totalBytes, limitBytes = PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes) {
    return `Preview artifact exceeds the ${limitBytes} byte limit (${totalBytes})`;
}
async function syncFile(filePath) {
    try {
        const handle = await open(filePath, openFlagsNoFollow());
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    catch {
        // Directory/file fsync is best effort on platforms where Electron's
        // packaged filesystem does not expose it (notably Windows).
    }
}
async function syncDirectory(dirPath) {
    try {
        const handle = await open(dirPath, openFlagsNoFollow());
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    catch {
        // See syncFile: atomic rename remains the durability boundary.
    }
}
function cloneFallbackTrace(trace) {
    return trace.map((entry) => ({ ...entry }));
}
async function validateRegularFileNoFollow(filePath, expectedSize) {
    let handle = null;
    try {
        const info = await lstat(filePath, { bigint: true });
        if (!info.isFile() || isRedirectingStat(info))
            return null;
        if (expectedSize !== undefined && info.size !== BigInt(expectedSize))
            return null;
        handle = await open(filePath, openFlagsNoFollow());
        const opened = await handle.stat({ bigint: true });
        const afterOpen = await lstat(filePath, { bigint: true });
        const openedIdentity = identityFromStats(opened);
        const infoIdentity = identityFromStats(info);
        if (!opened.isFile() ||
            isRedirectingStat(opened) ||
            !afterOpen.isFile() ||
            isRedirectingStat(afterOpen) ||
            afterOpen.dev !== opened.dev ||
            afterOpen.ino !== opened.ino ||
            afterOpen.size !== opened.size ||
            !sameFileIdentity(infoIdentity, openedIdentity) ||
            (expectedSize !== undefined && openedIdentity.size !== expectedSize)) {
            return null;
        }
        return openedIdentity;
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
async function copyRegularFileNoFollow(sourcePath, destinationPath, expectedSize) {
    let sourceHandle = null;
    let destinationHandle = null;
    try {
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
            return null;
        sourceHandle = await open(sourcePath, openFlagsNoFollow());
        const sourceInfo = await sourceHandle.stat({ bigint: true });
        if (!sourceInfo.isFile() ||
            isRedirectingStat(sourceInfo) ||
            sourceInfo.size !== BigInt(expectedSize))
            return null;
        destinationHandle = await open(destinationPath, createFlagsNoFollow(), 0o600);
        // Copy through a bounded buffer.  Artifact resources may be large, but a
        // commit must never allocate the entire resource (or a second copy of it)
        // in the main-process heap.
        const chunkSize = 1024 * 1024;
        const buffer = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(1, expectedSize)));
        let position = 0;
        while (position < expectedSize) {
            const requested = Math.min(buffer.byteLength, expectedSize - position);
            const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
            if (bytesRead <= 0)
                return null;
            let written = 0;
            while (written < bytesRead) {
                const { bytesWritten } = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
                if (bytesWritten <= 0)
                    return null;
                written += bytesWritten;
            }
            position += bytesRead;
        }
        if (position !== expectedSize)
            return null;
        const after = await sourceHandle.stat({ bigint: true });
        if (!after.isFile() ||
            after.dev !== sourceInfo.dev ||
            after.ino !== sourceInfo.ino ||
            after.size !== sourceInfo.size)
            return null;
        await destinationHandle.sync();
        const destinationInfo = await destinationHandle.stat({ bigint: true });
        if (!destinationInfo.isFile() || isRedirectingStat(destinationInfo))
            return null;
        return identityFromStats(destinationInfo);
    }
    catch {
        return null;
    }
    finally {
        await destinationHandle?.close().catch(() => undefined);
        await sourceHandle?.close().catch(() => undefined);
    }
}
function validateRegularFileNoFollowSync(root, filePath, expectedIdentity, expectedSize) {
    let fd = null;
    try {
        const resolvedRoot = path.resolve(root);
        const resolvedFile = path.resolve(filePath);
        if (!isContained(resolvedRoot, resolvedFile))
            return null;
        const rootInfo = lstatSync(resolvedRoot, { bigint: true });
        if (!rootInfo.isDirectory() || isRedirectingStat(rootInfo))
            return null;
        const canonicalRoot = realpathSync.native(resolvedRoot);
        const canonicalFile = realpathSync.native(resolvedFile);
        if (!isContained(canonicalRoot, canonicalFile))
            return null;
        let current = resolvedRoot;
        for (const component of path
            .relative(resolvedRoot, resolvedFile)
            .split(path.sep)
            .filter(Boolean)) {
            current = path.join(current, component);
            const info = lstatSync(current, { bigint: true });
            if (isRedirectingStat(info))
                return null;
        }
        const lexicalInfo = lstatSync(resolvedFile, { bigint: true });
        if (!lexicalInfo.isFile() || isRedirectingStat(lexicalInfo))
            return null;
        const lexicalIdentity = identityFromStats(lexicalInfo);
        if (expectedSize !== undefined && lexicalIdentity.size !== expectedSize)
            return null;
        fd = openSync(resolvedFile, openFlagsNoFollow());
        const opened = fstatSync(fd, { bigint: true });
        const openedIdentity = identityFromStats(opened);
        const afterOpen = lstatSync(resolvedFile, { bigint: true });
        if (!opened.isFile() ||
            isRedirectingStat(opened) ||
            isRedirectingStat(afterOpen) ||
            !afterOpen.isFile() ||
            afterOpen.dev !== opened.dev ||
            afterOpen.ino !== opened.ino ||
            afterOpen.size !== opened.size ||
            !sameFileIdentity(lexicalIdentity, openedIdentity) ||
            (expectedSize !== undefined && openedIdentity.size !== expectedSize) ||
            (expectedIdentity !== undefined && !sameFileIdentity(expectedIdentity, openedIdentity)))
            return null;
        return openedIdentity;
    }
    catch {
        return null;
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch {
                // best effort
            }
        }
    }
}
export class DocumentPreviewArtifactStore {
    constructor(options = {}) {
        this.entries = new Map();
        this.leases = new Map();
        this.commitLocks = new Map();
        /**
         * All cache mutations share one serialization boundary. A prune snapshot is
         * only safe while no lease acquisition or commit can insert/refresh an
         * entry; otherwise it could delete bytes immediately after returning a
         * newly-created lease or cache entry to its caller.
         */
        this.mutationQueue = Promise.resolve();
        this.metadataWrites = new Set();
        /** Serialize last-access metadata writes per immutable cache entry. */
        this.metadataQueues = new Map();
        /** Synchronous resource resolution records an in-memory LRU touch here. */
        this.dirtyMetadataKeys = new Set();
        this.pendingCommits = new Map();
        this.pendingCommitTimers = new Map();
        this.initialized = false;
        this.initializationPromise = null;
        this.lifecycle = 'open';
        this.shutdownPromise = null;
        this.rootDir = options.rootDir ?? defaultRootDir();
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
        this.maxBytes = Math.min(PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes, Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES));
        this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_TTL_MS);
        this.maxLeases = Math.max(1, options.maxLeases ?? Math.max(DEFAULT_MAX_LEASES, this.maxEntries));
        this.maxLeaseBytes = Math.min(PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes, Math.max(1, options.maxLeaseBytes ?? this.maxBytes));
        this.maxLeasesPerSender = Math.max(1, options.maxLeasesPerSender ?? this.maxLeases);
        this.maxLeaseBytesPerSender = Math.min(PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes, Math.max(1, options.maxLeaseBytesPerSender ?? this.maxLeaseBytes));
        this.leaseTtlMs = Math.max(0, options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
        this.unleasedArtifactTtlMs = Math.max(0, options.unleasedArtifactTtlMs ??
            options.pendingArtifactTtlMs ??
            DEFAULT_UNLEASED_ARTIFACT_TTL_MS);
        this.now = options.now ?? (() => Date.now());
    }
    getRootDir() {
        return this.rootDir;
    }
    async initialize(allowClosing = false) {
        if (this.lifecycle === 'closed' || (this.lifecycle === 'closing' && !allowClosing))
            return;
        if (this.initialized)
            return;
        if (this.initializationPromise)
            return this.initializationPromise;
        this.initializationPromise = this.doInitialize();
        try {
            await this.initializationPromise;
            this.initialized = true;
        }
        finally {
            this.initializationPromise = null;
        }
    }
    async doInitialize() {
        const root = await ensureDirectoryNoFollow(this.rootDir);
        const cacheRoot = await ensureDirectoryNoFollow(path.join(root, 'cache'));
        const stagingRoot = await ensureDirectoryNoFollow(path.join(root, 'staging'));
        const stagingEntries = await readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
        await Promise.all(stagingEntries.map((entry) => removeNoFollow(path.join(stagingRoot, entry.name))));
        const cacheEntries = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
        await Promise.all(cacheEntries.map(async (entry) => {
            const directory = path.join(cacheRoot, entry.name);
            const entryInfo = await lstat(directory).catch(() => null);
            if (!entryInfo || isRedirectingStat(entryInfo)) {
                // A redirecting cache entry is untrusted residue.  Remove only the
                // link itself; never recurse through its target.
                if (entryInfo)
                    await removeNoFollow(directory);
                return;
            }
            if (!entryInfo.isDirectory() || !isValidCacheKey(entry.name))
                return;
            const persisted = await this.readAndValidateEntry(directory, entry.name);
            if (persisted)
                this.entries.set(entry.name, persisted);
            else
                await removeNoFollow(directory);
        }));
    }
    async readAndValidateEntry(directory, expectedKey) {
        try {
            if (!(await walkNoFollow(path.dirname(directory), directory)))
                return null;
            const canonicalDirectory = await realpath(directory);
            const canonicalCacheRoot = await realpath(path.join(this.rootDir, 'cache'));
            if (!isContained(canonicalCacheRoot, canonicalDirectory))
                return null;
            const entryPath = path.join(directory, 'entry.json');
            if (!(await walkNoFollow(directory, entryPath)))
                return null;
            const raw = JSON.parse(await readFileNoFollow(entryPath));
            const createdAtMs = raw.createdAtMs;
            const lastAccessMs = raw.lastAccessMs;
            if (raw.schema !== CACHE_SCHEMA ||
                raw.cacheKey !== expectedKey ||
                !isValidCacheKey(raw.cacheKey) ||
                typeof raw.backendId !== 'string' ||
                typeof raw.backendVersion !== 'string' ||
                raw.backendVersion.length === 0 ||
                typeof raw.processorVersion !== 'string' ||
                raw.processorVersion.length === 0 ||
                typeof raw.kind !== 'string' ||
                !ARTIFACT_KINDS.has(raw.kind) ||
                !Array.isArray(raw.resources) ||
                raw.resources.length === 0 ||
                raw.resources.length > MAX_RESOURCES ||
                !Array.isArray(raw.warnings) ||
                raw.warnings.length > 64 ||
                raw.warnings.some((warning) => typeof warning !== 'string' || warning.length === 0) ||
                (raw.pageCount !== undefined &&
                    (!Number.isSafeInteger(raw.pageCount) || raw.pageCount < 0)) ||
                (raw.slideCount !== undefined &&
                    (!Number.isSafeInteger(raw.slideCount) || raw.slideCount < 0)) ||
                typeof createdAtMs !== 'number' ||
                !Number.isSafeInteger(createdAtMs) ||
                createdAtMs < 0 ||
                typeof lastAccessMs !== 'number' ||
                !Number.isSafeInteger(lastAccessMs) ||
                lastAccessMs < 0) {
                return null;
            }
            const backendId = normalizePreviewBackendIdV1(raw.backendId);
            if (!backendId || !ARTIFACT_BACKENDS.has(backendId))
                return null;
            let totalBytes = 0;
            const resources = [];
            const seenIds = new Set();
            const seenPaths = new Set();
            for (const candidate of raw.resources) {
                if (!candidate || typeof candidate !== 'object')
                    return null;
                const resource = candidate;
                const resourceId = resource.resourceId;
                const resourceName = resource.name;
                const resourceMediaType = resource.mediaType;
                const resourceRelativePath = resource.relativePath;
                const resourceSizeBytes = resource.sizeBytes;
                if (!isValidResourceId(resourceId) ||
                    seenIds.has(resourceId) ||
                    typeof resourceName !== 'string' ||
                    !safeRelativeName(resourceName) ||
                    typeof resourceMediaType !== 'string' ||
                    !MEDIA_TYPE.test(resourceMediaType) ||
                    typeof resourceRelativePath !== 'string' ||
                    !safeRelativeName(resourceRelativePath) ||
                    seenPaths.has(resourceRelativePath) ||
                    typeof resourceSizeBytes !== 'number' ||
                    !Number.isSafeInteger(resourceSizeBytes) ||
                    resourceSizeBytes < 0 ||
                    resourceSizeBytes > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes) {
                    return null;
                }
                const sizeBytes = resourceSizeBytes;
                const absolute = path.join(directory, resourceRelativePath);
                if (!(await walkNoFollow(directory, absolute)))
                    return null;
                const identity = await validateRegularFileNoFollow(absolute, sizeBytes);
                if (!identity)
                    return null;
                if (!resource.fileIdentity ||
                    !isValidFileIdentity(resource.fileIdentity) ||
                    !sameFileIdentity(resource.fileIdentity, identity))
                    return null;
                totalBytes += sizeBytes;
                if (totalBytes > this.maxBytes)
                    return null;
                seenIds.add(resourceId);
                seenPaths.add(resourceRelativePath);
                resources.push({
                    resourceId,
                    name: resourceName,
                    mediaType: resourceMediaType,
                    relativePath: resourceRelativePath,
                    sizeBytes,
                    fileIdentity: identity,
                });
            }
            if (raw.totalBytes !== undefined && raw.totalBytes !== totalBytes)
                return null;
            if (totalBytes > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes)
                return null;
            return {
                schema: CACHE_SCHEMA,
                cacheKey: expectedKey,
                backendId: backendId,
                backendVersion: backendId === PPTX_DOM_BACKEND_ID_V1 ? PPTX_DOM_BACKEND_VERSION_V1 : raw.backendVersion,
                processorVersion: raw.processorVersion,
                kind: raw.kind,
                ...(raw.pageCount !== undefined ? { pageCount: raw.pageCount } : {}),
                ...(raw.slideCount !== undefined ? { slideCount: raw.slideCount } : {}),
                warnings: raw.warnings,
                resources,
                totalBytes,
                createdAtMs,
                lastAccessMs,
            };
        }
        catch {
            return null;
        }
    }
    async commitCacheEntry(input) {
        if (this.lifecycle !== 'open') {
            return failure('internal', 'The document preview artifact store is closed', true);
        }
        return this.enqueueMutation(async () => {
            if (!input || !isValidCacheKey(input.cacheKey)) {
                return failure('invalid_request', 'Invalid preview artifact cache key');
            }
            const previous = this.commitLocks.get(input.cacheKey) ?? Promise.resolve(undefined);
            const operation = previous.then(() => this.commitCacheEntryUnlocked(input));
            this.commitLocks.set(input.cacheKey, operation);
            try {
                const result = await operation;
                if (result.ok) {
                    // Keep the just-committed key until acquireLease can attach the
                    // caller's capability.  Without this protection a zero-TTL test (or
                    // a full cache) can prune the new entry between commit and acquire,
                    // making a successful transform impossible to lease.
                    await this.pruneUnlocked(this.now(), new Set([input.cacheKey]));
                }
                return result;
            }
            finally {
                if (this.commitLocks.get(input.cacheKey) === operation)
                    this.commitLocks.delete(input.cacheKey);
            }
        });
    }
    async commitCacheEntryUnlocked(input) {
        const cancelled = () => Boolean(input.signal?.aborted || (input.isActive !== undefined && !input.isActive()));
        try {
            await this.initialize(true);
            if (cancelled())
                return failure('cancelled', 'Preview artifact commit was cancelled', true);
            if (input.backendId === 'system-open') {
                return failure('invalid_request', 'system-open cannot be committed as an artifact');
            }
            if (typeof input.backendVersion !== 'string' ||
                input.backendVersion.length === 0 ||
                typeof input.processorVersion !== 'string' ||
                input.processorVersion.length === 0 ||
                !ARTIFACT_BACKENDS.has(input.backendId) ||
                !ARTIFACT_KINDS.has(input.kind) ||
                !Array.isArray(input.resources) ||
                input.resources.length === 0 ||
                input.resources.length > MAX_RESOURCES ||
                !Number.isSafeInteger(input.maxCommitBytes) ||
                input.maxCommitBytes < 0 ||
                input.maxCommitBytes > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes ||
                !Array.isArray(input.warnings) ||
                input.warnings.some((warning) => typeof warning !== 'string')) {
                return failure('invalid_request', 'Invalid preview artifact metadata', false, input.backendId);
            }
            const seenIds = new Set();
            let totalBytes = 0;
            for (const resource of input.resources) {
                if (!resource ||
                    !isValidResourceId(resource.resourceId) ||
                    seenIds.has(resource.resourceId) ||
                    !safeRelativeName(resource.name) ||
                    !MEDIA_TYPE.test(resource.mediaType) ||
                    !path.isAbsolute(resource.sourcePath) ||
                    !Number.isSafeInteger(resource.sizeBytes) ||
                    resource.sizeBytes < 0 ||
                    resource.sizeBytes > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes) {
                    return failure('invalid_request', 'Invalid preview artifact resource', false, input.backendId);
                }
                seenIds.add(resource.resourceId);
                if (totalBytes > Number.MAX_SAFE_INTEGER - resource.sizeBytes) {
                    return failure(ARTIFACT_TOO_LARGE, artifactLimitMessage(Number.MAX_SAFE_INTEGER, input.maxCommitBytes), false, input.backendId);
                }
                totalBytes += resource.sizeBytes;
                if (totalBytes > input.maxCommitBytes ||
                    totalBytes > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes ||
                    totalBytes > this.maxBytes) {
                    return failure(ARTIFACT_TOO_LARGE, artifactLimitMessage(totalBytes, Math.min(input.maxCommitBytes, this.maxBytes)), false, input.backendId);
                }
            }
            const existing = this.entries.get(input.cacheKey);
            if (existing) {
                if (existing.totalBytes > input.maxCommitBytes) {
                    return failure(ARTIFACT_TOO_LARGE, artifactLimitMessage(existing.totalBytes, input.maxCommitBytes), false, input.backendId);
                }
                // A valid entry wins a concurrent duplicate commit. If it is still
                // waiting for its first lease, register this caller as another owner
                // of the same token; otherwise a cancellation from the first caller
                // could discard bytes needed by the second one.
                const pending = this.pendingCommits.get(input.cacheKey);
                if (pending)
                    pending.owners += 1;
                return {
                    ok: true,
                    value: {
                        cacheKey: input.cacheKey,
                        ...(pending ? { commitToken: pending.token } : {}),
                    },
                };
            }
            const activeUsage = this.activeCacheUsage();
            if (activeUsage.bytes + totalBytes > this.maxBytes ||
                activeUsage.entries + 1 > this.maxEntries) {
                return failure(ARTIFACT_TOO_LARGE, artifactLimitMessage(activeUsage.bytes + totalBytes), false, input.backendId);
            }
            const stagingDir = path.join(this.rootDir, 'staging', `.partial-${randomUUID()}`);
            await ensureDirectoryNoFollow(path.dirname(stagingDir));
            await mkdir(stagingDir);
            try {
                const usedNames = new Set();
                const resources = [];
                for (const resource of input.resources) {
                    if (cancelled())
                        return failure('cancelled', 'Preview artifact commit was cancelled', true);
                    if (!(await validateRegularFileNoFollow(resource.sourcePath, resource.sizeBytes))) {
                        return failure('source_not_found', `Preview artifact source is unavailable: ${resource.resourceId}`, true, input.backendId);
                    }
                    const baseName = path.basename(resource.name);
                    let relativePath = safeRelativeName(baseName) ? baseName : resource.resourceId;
                    if (usedNames.has(relativePath))
                        relativePath = `${resource.resourceId}-${relativePath}`;
                    if (!safeRelativeName(relativePath))
                        relativePath = resource.resourceId;
                    usedNames.add(relativePath);
                    const destination = path.join(stagingDir, relativePath);
                    if (!isContained(stagingDir, destination)) {
                        return failure('invalid_request', 'Invalid preview artifact resource path', false, input.backendId);
                    }
                    const destinationIdentity = await copyRegularFileNoFollow(resource.sourcePath, destination, resource.sizeBytes);
                    if (!destinationIdentity || cancelled()) {
                        return failure(cancelled() ? 'cancelled' : 'artifact_invalid', cancelled()
                            ? 'Preview artifact commit was cancelled'
                            : 'The generated preview artifact is invalid', false, input.backendId);
                    }
                    if (!(await walkNoFollow(stagingDir, destination))) {
                        return failure('artifact_invalid', 'The generated preview artifact is invalid', false, input.backendId);
                    }
                    await syncFile(destination);
                    const verifiedDestination = await validateRegularFileNoFollow(destination, resource.sizeBytes);
                    if (!verifiedDestination || !sameFileIdentity(destinationIdentity, verifiedDestination)) {
                        return failure('artifact_invalid', 'The generated preview artifact is invalid', false, input.backendId);
                    }
                    resources.push({
                        resourceId: resource.resourceId,
                        name: resource.name,
                        mediaType: resource.mediaType,
                        relativePath,
                        sizeBytes: resource.sizeBytes,
                        fileIdentity: verifiedDestination,
                    });
                }
                if (cancelled())
                    return failure('cancelled', 'Preview artifact commit was cancelled', true);
                const now = this.now();
                const metadata = {
                    schema: CACHE_SCHEMA,
                    cacheKey: input.cacheKey,
                    backendId: input.backendId,
                    backendVersion: input.backendVersion,
                    processorVersion: input.processorVersion,
                    kind: input.kind,
                    ...(input.pageCount !== undefined ? { pageCount: input.pageCount } : {}),
                    ...(input.slideCount !== undefined ? { slideCount: input.slideCount } : {}),
                    warnings: [...input.warnings],
                    resources,
                    totalBytes,
                    createdAtMs: now,
                    lastAccessMs: now,
                };
                const stagedEntryPath = path.join(stagingDir, 'entry.json');
                await writeFileNoFollow(stagedEntryPath, `${JSON.stringify(metadata)}\n`);
                await syncFile(stagedEntryPath);
                await syncDirectory(stagingDir);
                const destinationDir = cacheDir(this.rootDir, input.cacheKey);
                if (cancelled())
                    return failure('cancelled', 'Preview artifact commit was cancelled', true);
                try {
                    await rename(stagingDir, destinationDir);
                }
                catch (error) {
                    if (error.code !== 'EEXIST')
                        throw error;
                    const validExisting = await this.readAndValidateEntry(destinationDir, input.cacheKey);
                    if (!validExisting) {
                        await removeNoFollow(destinationDir);
                        if (cancelled())
                            return failure('cancelled', 'Preview artifact commit was cancelled', true);
                        await rename(stagingDir, destinationDir);
                    }
                    else {
                        await removeNoFollow(stagingDir);
                        if (validExisting.totalBytes > input.maxCommitBytes) {
                            return failure(ARTIFACT_TOO_LARGE, artifactLimitMessage(validExisting.totalBytes, input.maxCommitBytes), false, input.backendId);
                        }
                        this.entries.set(input.cacheKey, validExisting);
                        return { ok: true, value: { cacheKey: input.cacheKey } };
                    }
                }
                if (!(await walkNoFollow(path.join(this.rootDir, 'cache'), destinationDir))) {
                    await removeNoFollow(destinationDir);
                    return failure('artifact_invalid', 'The generated preview artifact is invalid', false, input.backendId);
                }
                if (cancelled()) {
                    await removeNoFollow(destinationDir);
                    return failure('cancelled', 'Preview artifact commit was cancelled', true);
                }
                await syncDirectory(path.join(this.rootDir, 'cache'));
                this.entries.set(input.cacheKey, metadata);
                const commitToken = this.newCommitToken();
                this.pendingCommits.set(input.cacheKey, {
                    createdAtMs: now,
                    token: commitToken,
                    owners: 1,
                });
                this.schedulePendingCommitExpiry(input.cacheKey, commitToken);
                return { ok: true, value: { cacheKey: input.cacheKey, commitToken } };
            }
            finally {
                await removeNoFollow(stagingDir);
            }
        }
        catch (error) {
            return failure('internal', `Unable to commit preview artifact: ${String(error)}`, true, input.backendId);
        }
    }
    newCommitToken() {
        let token = randomBytes(16).toString('hex');
        while ([...this.pendingCommits.values()].some((pending) => pending.token === token)) {
            token = randomBytes(16).toString('hex');
        }
        return token;
    }
    /**
     * Revoke a commit that has not yet been leased. The token is deliberately
     * required: a cache key can be shared by unrelated requests, so a cancelled
     * caller must never delete an entry it did not create. The operation is
     * idempotent and serialized with commit/acquire/prune mutations.
     */
    async discardUnleasedCommit(input) {
        if (this.lifecycle === 'closed') {
            return failure('internal', 'The document preview artifact store is closed', true);
        }
        return this.enqueueMutation(async () => {
            await this.initialize(true);
            if (!isValidCacheKey(input.cacheKey) || typeof input.commitToken !== 'string') {
                return failure('invalid_request', 'Invalid preview artifact commit ownership');
            }
            const pending = this.pendingCommits.get(input.cacheKey);
            if (!pending || pending.token !== input.commitToken) {
                // A lease may already have consumed the token, or another cleanup may
                // have won the race. Both outcomes are already fail-closed.
                return { ok: true, value: null };
            }
            if (this.leasesForCache(input.cacheKey)) {
                // Never revoke bytes that became reachable through another lease while
                // cancellation cleanup was waiting in the mutation queue.
                return { ok: true, value: null };
            }
            if (pending.owners > 1) {
                pending.owners -= 1;
                return { ok: true, value: null };
            }
            this.pendingCommits.delete(input.cacheKey);
            this.clearPendingCommitExpiry(input.cacheKey);
            const entry = this.entries.get(input.cacheKey);
            if (!entry)
                return { ok: true, value: null };
            await removeNoFollow(cacheDir(this.rootDir, input.cacheKey));
            this.entries.delete(input.cacheKey);
            this.dirtyMetadataKeys.delete(input.cacheKey);
            return { ok: true, value: null };
        });
    }
    async acquireLease(input) {
        if (this.lifecycle !== 'open') {
            return failure('internal', 'The document preview artifact store is closed', true);
        }
        const cancelled = () => {
            if (input.signal?.aborted)
                return true;
            if (!input.isActive)
                return false;
            try {
                return !input.isActive();
            }
            catch {
                return true;
            }
        };
        return this.enqueueMutation(async () => {
            if (cancelled())
                return failure('cancelled', 'Preview artifact lease was cancelled', true);
            await this.initialize(true);
            if (cancelled())
                return failure('cancelled', 'Preview artifact lease was cancelled', true);
            this.expireLeases(this.now());
            if (!Number.isSafeInteger(input.senderId) ||
                input.senderId < 0 ||
                !isValidCacheKey(input.cacheKey) ||
                !Number.isSafeInteger(input.maxArtifactBytes) ||
                input.maxArtifactBytes < 0 ||
                input.maxArtifactBytes > PPTX_PREVIEW_LIMITS_V1.maxArtifactBytes) {
                return failure('invalid_request', 'Invalid preview artifact lease request');
            }
            const entry = this.entries.get(input.cacheKey);
            if (!entry)
                return failure('source_not_found', `Preview artifact cache entry not found: ${input.cacheKey}`, true);
            if (entry.totalBytes > input.maxArtifactBytes) {
                return failure(ARTIFACT_TOO_LARGE, artifactLimitMessage(entry.totalBytes, input.maxArtifactBytes), false, entry.backendId);
            }
            const leaseUsage = this.leaseUsage();
            const senderUsage = this.leaseUsage(input.senderId);
            if (entry.totalBytes > this.maxLeaseBytes ||
                entry.totalBytes > this.maxLeaseBytesPerSender ||
                leaseUsage.count + 1 > this.maxLeases ||
                senderUsage.count + 1 > this.maxLeasesPerSender ||
                leaseUsage.bytes + entry.totalBytes > this.maxLeaseBytes ||
                senderUsage.bytes + entry.totalBytes > this.maxLeaseBytesPerSender) {
                return failure(ARTIFACT_TOO_LARGE, artifactLimitMessage(Math.max(entry.totalBytes, leaseUsage.bytes + entry.totalBytes)), true, entry.backendId);
            }
            if (cancelled())
                return failure('cancelled', 'Preview artifact lease was cancelled', true);
            // Capability URLs use a fixed-width, non-guessable id.  UUID strings are
            // valid lease ids internally but their hyphens do not belong in the
            // versioned resource URL grammar.
            let previewId = randomBytes(16).toString('hex');
            while (this.leases.has(previewId))
                previewId = randomBytes(16).toString('hex');
            this.leases.set(previewId, {
                senderId: input.senderId,
                cacheKey: input.cacheKey,
                createdAtMs: this.now(),
                totalBytes: entry.totalBytes,
            });
            const previousLastAccessMs = entry.lastAccessMs;
            let published = false;
            try {
                entry.lastAccessMs = this.now();
                // Lease publication is already behind the mutation queue, so finish
                // its LRU metadata write before returning. This keeps capability
                // lifecycle self-contained and prevents a late metadata rename from
                // racing sender teardown or workspace cleanup.
                await this.persistMetadata(entry);
                if (cancelled())
                    return failure('cancelled', 'Preview artifact lease was cancelled', true);
                this.dirtyMetadataKeys.delete(entry.cacheKey);
                const resources = entry.resources.map((resource) => ({
                    resourceId: resource.resourceId,
                    name: resource.name,
                    mediaType: resource.mediaType,
                    url: buildPreviewArtifactResourceUrlV1(previewId, resource.resourceId),
                    sizeBytes: resource.sizeBytes,
                }));
                const manifest = {
                    schema: 'mavis.preview_artifact.v1',
                    previewId,
                    sourceId: input.sourceId,
                    backendId: entry.backendId,
                    backendVersion: entry.backendVersion,
                    kind: entry.kind,
                    ...(entry.pageCount !== undefined ? { pageCount: entry.pageCount } : {}),
                    ...(entry.slideCount !== undefined ? { slideCount: entry.slideCount } : {}),
                    resources,
                    warnings: [...entry.warnings],
                    fallbackTrace: cloneFallbackTrace(input.fallbackTrace),
                    createdAtMs: this.now(),
                };
                try {
                    // Persisted metadata is untrusted state (it may have survived a crash
                    // or been modified outside the process). Validate the complete public
                    // manifest immediately before issuing a capability URL.
                    assertPreviewArtifactManifestV1(manifest);
                }
                catch {
                    return failure('artifact_invalid', 'The generated preview artifact is invalid', true);
                }
                // Prune in the same mutation queue while the provisional lease
                // protects this entry and old, unleased entries are evicted.
                await this.pruneUnlocked(this.now());
                if (cancelled())
                    return failure('cancelled', 'Preview artifact lease was cancelled', true);
                this.pendingCommits.delete(input.cacheKey);
                this.clearPendingCommitExpiry(input.cacheKey);
                published = true;
                return { ok: true, value: manifest };
            }
            finally {
                if (!published) {
                    this.leases.delete(previewId);
                    if (this.entries.get(entry.cacheKey) === entry) {
                        entry.lastAccessMs = previousLastAccessMs;
                        this.dirtyMetadataKeys.add(entry.cacheKey);
                    }
                }
            }
        });
    }
    resolveLeaseResource(previewId, resourceId) {
        if (this.lifecycle !== 'open')
            return null;
        if (!previewId || !isValidResourceId(resourceId))
            return null;
        this.expireLeases(this.now());
        const lease = this.leases.get(previewId);
        if (!lease)
            return null;
        const entry = this.entries.get(lease.cacheKey);
        if (!entry)
            return null;
        const resource = entry.resources.find((candidate) => candidate.resourceId === resourceId);
        if (!resource)
            return null;
        const absolutePath = path.join(cacheDir(this.rootDir, entry.cacheKey), resource.relativePath);
        const identity = validateRegularFileNoFollowSync(cacheDir(this.rootDir, entry.cacheKey), absolutePath, resource.fileIdentity, resource.sizeBytes);
        if (!identity)
            return null;
        entry.lastAccessMs = this.now();
        // Resource resolution is synchronous because the protocol handler calls it
        // while constructing a Response. Keep this hot-path touch in memory and
        // flush it at the next queued mutation or shutdown; no untracked
        // filesystem write can outlive sender teardown.
        this.dirtyMetadataKeys.add(entry.cacheKey);
        return {
            cacheKey: entry.cacheKey,
            previewId,
            resourceId: resource.resourceId,
            name: resource.name,
            mediaType: resource.mediaType,
            absolutePath,
            sizeBytes: resource.sizeBytes,
            fileIdentity: identity,
        };
    }
    /**
     * Returns the main-owned WebContents sender for a live capability lease.
     *
     * Electron's fetch-style protocol handler receives a standard Request and
     * therefore cannot identify the requesting renderer. The default Session's
     * webRequest boundary uses this lookup with its trusted `webContentsId`
     * before protocol dispatch. A missing/expired lease deliberately returns
     * null so the protocol handler can preserve its public HTTP 404 semantics.
     */
    getLeaseOwnerSenderId(previewId) {
        if (this.lifecycle !== 'open' || typeof previewId !== 'string' || !previewId)
            return null;
        this.expireLeases(this.now());
        return this.leases.get(previewId)?.senderId ?? null;
    }
    async releaseLease(input) {
        if (this.lifecycle !== 'open') {
            return failure('internal', 'The document preview artifact store is closed', true);
        }
        return this.enqueueMutation(async () => {
            this.expireLeases(this.now());
            const lease = this.leases.get(input.previewId);
            if (!lease || lease.senderId !== input.senderId) {
                return failure('source_not_found', 'Preview artifact lease not found');
            }
            this.leases.delete(input.previewId);
            this.pendingCommits.delete(lease.cacheKey);
            this.clearPendingCommitExpiry(lease.cacheKey);
            // Releasing the final lease is a natural cache maintenance boundary.
            // Serialize pruning with the release so an in-flight acquire cannot be
            // accidentally evicted between its lease publication and this revoke.
            await this.pruneUnlocked(this.now());
            return { ok: true, value: null };
        });
    }
    async releaseSender(senderId) {
        if (this.lifecycle !== 'open')
            return;
        await this.enqueueMutation(async () => {
            await this.initialize(true);
            this.expireLeases(this.now());
            for (const [previewId, lease] of this.leases) {
                if (lease.senderId === senderId) {
                    this.leases.delete(previewId);
                    this.pendingCommits.delete(lease.cacheKey);
                    this.clearPendingCommitExpiry(lease.cacheKey);
                }
            }
            await this.pruneUnlocked(this.now());
        });
    }
    async prune(nowMs = this.now()) {
        if (this.lifecycle !== 'open')
            return;
        await this.enqueueMutation(async () => {
            await this.initialize(true);
            this.expireLeases(nowMs);
            await this.pruneUnlocked(nowMs);
        });
    }
    leaseUsage(senderId) {
        let count = 0;
        let bytes = 0;
        for (const lease of this.leases.values()) {
            if (senderId !== undefined && lease.senderId !== senderId)
                continue;
            count += 1;
            bytes += lease.totalBytes;
        }
        return { count, bytes };
    }
    activeCacheUsage() {
        const keys = new Set();
        let bytes = 0;
        for (const lease of this.leases.values()) {
            if (keys.has(lease.cacheKey))
                continue;
            const entry = this.entries.get(lease.cacheKey);
            if (!entry)
                continue;
            keys.add(lease.cacheKey);
            bytes += entry.totalBytes;
        }
        return { entries: keys.size, bytes };
    }
    expireLeases(nowMs) {
        for (const [previewId, lease] of this.leases) {
            if (nowMs - lease.createdAtMs < this.leaseTtlMs)
                continue;
            this.leases.delete(previewId);
        }
    }
    schedulePendingCommitExpiry(cacheKey, token) {
        this.clearPendingCommitExpiry(cacheKey);
        if (this.unleasedArtifactTtlMs <= 0) {
            const timer = setTimeout(() => {
                this.pendingCommitTimers.delete(cacheKey);
                void this.enqueueMutation(async () => {
                    const pending = this.pendingCommits.get(cacheKey);
                    if (pending?.token === token && !this.leasesForCache(cacheKey)) {
                        this.pendingCommits.delete(cacheKey);
                        this.entries.delete(cacheKey);
                        await removeNoFollow(cacheDir(this.rootDir, cacheKey));
                    }
                });
            }, 0);
            timer.unref?.();
            this.pendingCommitTimers.set(cacheKey, timer);
            return;
        }
        const timer = setTimeout(() => {
            this.pendingCommitTimers.delete(cacheKey);
            void this.enqueueMutation(async () => {
                const pending = this.pendingCommits.get(cacheKey);
                if (pending?.token === token &&
                    this.now() - pending.createdAtMs >= this.unleasedArtifactTtlMs &&
                    !this.leasesForCache(cacheKey)) {
                    this.pendingCommits.delete(cacheKey);
                    this.entries.delete(cacheKey);
                    await removeNoFollow(cacheDir(this.rootDir, cacheKey));
                }
            });
        }, this.unleasedArtifactTtlMs);
        timer.unref?.();
        this.pendingCommitTimers.set(cacheKey, timer);
    }
    clearPendingCommitExpiry(cacheKey) {
        const timer = this.pendingCommitTimers.get(cacheKey);
        if (timer !== undefined)
            clearTimeout(timer);
        this.pendingCommitTimers.delete(cacheKey);
    }
    leasesForCache(cacheKey) {
        for (const lease of this.leases.values())
            if (lease.cacheKey === cacheKey)
                return true;
        return false;
    }
    async pruneUnlocked(nowMs, protectedKeys = new Set()) {
        this.expireLeases(nowMs);
        const activeKeys = new Set(protectedKeys);
        for (const lease of this.leases.values())
            activeKeys.add(lease.cacheKey);
        for (const [key, pending] of this.pendingCommits) {
            if (nowMs - pending.createdAtMs < this.unleasedArtifactTtlMs) {
                activeKeys.add(key);
            }
            else if (!this.leasesForCache(key)) {
                this.pendingCommits.delete(key);
                this.clearPendingCommitExpiry(key);
                const pendingEntry = this.entries.get(key);
                if (pendingEntry) {
                    await removeNoFollow(cacheDir(this.rootDir, key));
                    this.entries.delete(key);
                }
            }
        }
        const candidates = [...this.entries.values()]
            .filter((entry) => !activeKeys.has(entry.cacheKey))
            .sort((left, right) => left.lastAccessMs - right.lastAccessMs);
        let totalBytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.totalBytes, 0);
        let entryCount = this.entries.size;
        for (const entry of candidates) {
            const expired = this.ttlMs === 0 || nowMs - entry.lastAccessMs >= this.ttlMs;
            if (!expired && entryCount <= this.maxEntries && totalBytes <= this.maxBytes)
                continue;
            await removeNoFollow(cacheDir(this.rootDir, entry.cacheKey));
            this.entries.delete(entry.cacheKey);
            this.clearPendingCommitExpiry(entry.cacheKey);
            this.dirtyMetadataKeys.delete(entry.cacheKey);
            entryCount -= 1;
            totalBytes -= entry.totalBytes;
        }
        await this.flushDirtyMetadataUnlocked();
    }
    async shutdown() {
        if (this.shutdownPromise)
            return this.shutdownPromise;
        // Close admission synchronously. Calls that were already enqueued still
        // drain through the mutation queue; new transforms/leases fail closed and
        // cannot publish state after the before-quit boundary starts.
        this.lifecycle = 'closing';
        this.shutdownPromise = (async () => {
            // Do not clear leases or mark the store uninitialized while a queued
            // commit/acquire/prune operation can still publish filesystem state. The
            // Electron before-quit gate relies on this promise as the cache lifecycle
            // boundary.
            await this.mutationQueue.catch(() => undefined);
            // Startup may call initialize() outside the mutation queue. Wait for
            // that in-flight scan too, otherwise it could repopulate `entries`
            // after shutdown clears the store.
            await this.initializationPromise?.catch(() => undefined);
            await this.flushDirtyMetadataUnlocked();
            // resolveLeaseResource() is synchronous and rejects new calls once the
            // lifecycle is closing. Any metadata writes it started before admission
            // closed are tracked here and must settle before the store is retired.
            while (this.metadataWrites.size > 0) {
                await Promise.allSettled([...this.metadataWrites]);
            }
            this.leases.clear();
            this.entries.clear();
            for (const timer of this.pendingCommitTimers.values())
                clearTimeout(timer);
            this.pendingCommitTimers.clear();
            this.pendingCommits.clear();
            this.metadataQueues.clear();
            this.initialized = false;
            this.lifecycle = 'closed';
        })();
        return this.shutdownPromise;
    }
    persistMetadata(entry) {
        const key = entry.cacheKey;
        const previous = this.metadataQueues.get(key) ?? Promise.resolve();
        const payload = `${JSON.stringify(entry)}\n`;
        const operation = previous
            .catch(() => undefined)
            .then(async () => {
            if (this.lifecycle === 'closed' || this.entries.get(key) !== entry)
                return;
            const directory = cacheDir(this.rootDir, key);
            const temporary = path.join(directory, `.entry-${randomUUID()}.tmp`);
            try {
                await writeFileNoFollow(temporary, payload);
                await syncFile(temporary);
                // Prune may have removed this immutable entry while the write was
                // waiting for the per-key queue. Never recreate a retired cache dir.
                if (this.entries.get(key) !== entry)
                    return;
                await rename(temporary, cacheEntryPath(this.rootDir, key));
                await syncDirectory(directory);
            }
            finally {
                await rm(temporary, { force: true }).catch(() => undefined);
            }
        })
            .catch(() => undefined);
        this.metadataQueues.set(key, operation);
        this.metadataWrites.add(operation);
        void operation.then(() => {
            this.metadataWrites.delete(operation);
            if (this.metadataQueues.get(key) === operation)
                this.metadataQueues.delete(key);
        }, () => {
            this.metadataWrites.delete(operation);
            if (this.metadataQueues.get(key) === operation)
                this.metadataQueues.delete(key);
        });
        return operation;
    }
    async flushDirtyMetadataUnlocked() {
        const keys = [...this.dirtyMetadataKeys];
        for (const key of keys) {
            const entry = this.entries.get(key);
            if (!entry) {
                this.dirtyMetadataKeys.delete(key);
                continue;
            }
            await this.persistMetadata(entry);
            this.dirtyMetadataKeys.delete(key);
        }
    }
    enqueueMutation(operation) {
        const run = this.mutationQueue.then(operation);
        // Keep the queue usable after an operation fails while preserving the
        // original result/rejection for the caller.
        this.mutationQueue = run.then(() => undefined, () => undefined);
        return run;
    }
}

/** Shared main-process store used by IPC and the privileged artifact scheme. */
export let sharedDocumentPreviewArtifactStore = new DocumentPreviewArtifactStore();
