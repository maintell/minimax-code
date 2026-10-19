import { randomBytes } from "node:crypto";
import { readdir, realpath, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PPTX_PREVIEW_LIMITS_V1 } from "@mavis/shared/document-preview";
import { noopDocumentPreviewLogger, describeDocumentPreviewError } from "./logging";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const ASSET_ID = /^asset_[A-Za-z0-9_-]{1,240}$/u;
const MAX_ASSET_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_FILE_NAME_LENGTH = 256;
const MAX_MIME_TYPE_LENGTH = 256;
const MAX_DEFAULT_ASSET_BYTES = 100 * 1024 * 1024;
const SIDE_CAR_SUFFIX = '.asset.json';
const SIDECAR_INDEX_TTL_MS = 1000;
export let ASSET_AUTHORITY_DEFAULTS = Object.freeze({
    maxConcurrentResolutions: 16,
    maxConcurrentResolutionsPerSender: 4,
});
const issuedAssetResolutions = new WeakSet();
function validSenderId(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function positiveSafeInteger(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function validAssetId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_ASSET_ID_LENGTH &&
        ASSET_ID.test(value));
}
function validSessionId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_SESSION_ID_LENGTH &&
        !CONTROL_CHARACTER.test(value));
}
function validFileName(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_FILE_NAME_LENGTH &&
        !CONTROL_CHARACTER.test(value) &&
        !value.includes('/') &&
        !value.includes('\\'));
}
function validMimeType(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_MIME_TYPE_LENGTH &&
        !CONTROL_CHARACTER.test(value));
}
function isContained(root, candidate) {
    const relative = path.relative(root, candidate);
    return (relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)));
}
function identityFromStat(info) {
    return {
        dev: info.dev.toString(),
        ino: info.ino.toString(),
        size: info.size.toString(),
        mtimeMs: String(info.mtimeMs),
    };
}
function sameIdentity(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs);
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function validRelativePath(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 4096 &&
        !CONTROL_CHARACTER.test(value) &&
        !path.posix.isAbsolute(value) &&
        !path.win32.isAbsolute(value) &&
        !/^[A-Za-z]:/u.test(value) &&
        !value.startsWith('\\\\'));
}
function matchesSessionScope(recordSessionId, claimSessionId) {
    // Sidecars written before session ownership existed remain available only
    // to explicitly unscoped main-process callers. A session-bound renderer
    // claim can never adopt such an asset; scoped records require exact match.
    return recordSessionId === claimSessionId;
}
function parseSidecar(value) {
    if (!isRecord(value))
        return null;
    const assetId = value.assetId;
    const fileName = value.fileName;
    const mimeType = value.mimeType;
    const relativePath = value.relativePath;
    const bytes = value.bytes;
    const sha256 = value.sha256;
    const sessionId = value.sessionId;
    const maxBytes = typeof fileName === 'string' && fileName.toLowerCase().endsWith('.pptx')
        ? PPTX_PREVIEW_LIMITS_V1.maxInputBytes
        : MAX_DEFAULT_ASSET_BYTES;
    if (!validAssetId(assetId) ||
        !validFileName(fileName) ||
        !validMimeType(mimeType) ||
        !validRelativePath(relativePath) ||
        typeof bytes !== 'number' ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > maxBytes ||
        typeof sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(sha256) ||
        (sessionId !== undefined && !validSessionId(sessionId))) {
        return null;
    }
    return {
        assetId,
        fileName,
        mimeType,
        relativePath,
        bytes,
        sha256,
        ...(sessionId === undefined ? {} : { sessionId }),
    };
}
async function listSidecars(root, logger = noopDocumentPreviewLogger) {
    const result = [];
    const visit = async (directory) => {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        }
        catch (error) {
            logger.warn({
                msg: '[DocumentPreview][asset-authority] sidecar directory scan failed',
                directory,
                ...describeDocumentPreviewError(error),
            });
            return;
        }
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isSymbolicLink())
                continue;
            if (entry.isDirectory()) {
                await visit(entryPath);
            }
            else if (entry.isFile() && entry.name.endsWith(SIDE_CAR_SUFFIX)) {
                result.push(entryPath);
            }
        }
    };
    await visit(root);
    return result;
}
async function canonicalAssetsRoot(value, logger = noopDocumentPreviewLogger) {
    try {
        const canonical = await realpath(value);
        const info = await lstat(canonical, { bigint: true });
        return info.isDirectory() && !info.isSymbolicLink() ? canonical : null;
    }
    catch (error) {
        logger.warn({
            msg: '[DocumentPreview][asset-authority] assets root could not be canonicalized',
            assetsRoot: value,
            ...describeDocumentPreviewError(error),
        });
        return null;
    }
}
async function resolveSidecar(assetsRoot, assetId, sessionId, findSidecars, logger = noopDocumentPreviewLogger) {
    const sidecars = await findSidecars(assetsRoot, assetId);
    for (const sidecarPath of sidecars) {
        let sidecarInfo;
        try {
            sidecarInfo = await lstat(sidecarPath, { bigint: true });
            if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink())
                continue;
            const parsed = parseSidecar(JSON.parse(await readFile(sidecarPath, 'utf8')));
            if (!parsed || parsed.assetId !== assetId)
                continue;
            if (!matchesSessionScope(parsed.sessionId, sessionId))
                continue;
            // The sidecar's sibling is the only path source of truth. Never follow
            // `absolutePath` from a renderer or a mutable sidecar field.
            const siblingPath = sidecarPath.slice(0, -SIDE_CAR_SUFFIX.length);
            const canonicalFile = await realpath(siblingPath);
            if (!isContained(assetsRoot, canonicalFile))
                continue;
            const fileInfo = await lstat(siblingPath, { bigint: true });
            if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
                continue;
            // Local-runtime manifests are relative to the v2 root (the parent of
            // v2/assets), while the authority itself is rooted at v2/assets.
            const expectedRelative = path
                .relative(path.dirname(assetsRoot), canonicalFile)
                .replace(/[\\/]/gu, '/');
            if (expectedRelative !== parsed.relativePath)
                continue;
            const canonicalSidecar = await realpath(sidecarPath);
            if (canonicalSidecar !== sidecarPath)
                continue;
            if (Number(fileInfo.size) !== parsed.bytes)
                continue;
            return {
                senderId: -1,
                assetId: parsed.assetId,
                ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
                absolutePath: canonicalFile,
                assetRoot: assetsRoot,
                fileName: parsed.fileName,
                mimeType: parsed.mimeType,
                identity: identityFromStat(fileInfo),
                sidecarPath,
                sidecarIdentity: identityFromStat(sidecarInfo),
                bytes: parsed.bytes,
                sha256: parsed.sha256,
                nonce: '',
            };
        }
        catch (error) {
            // A malformed or concurrently replaced sidecar is not an asset match.
            // Logging separates a transient IO error from a clean fail-closed miss.
            logger.warn({
                msg: '[DocumentPreview][asset-authority] sidecar candidate discarded',
                sidecarPath,
                assetId,
                ...describeDocumentPreviewError(error),
            });
        }
    }
    return null;
}
export function isTrustedAssetResolution(value) {
    return (Boolean(value) &&
        typeof value === 'object' &&
        issuedAssetResolutions.has(value) &&
        validSenderId(value.senderId) &&
        validAssetId(value.assetId) &&
        typeof value.absolutePath === 'string' &&
        typeof value.assetRoot === 'string');
}
/**
 * Revalidate capability ownership plus file/sidecar metadata without reading
 * the potentially 100MiB asset body. The source registry must compare the
 * expected bytes/SHA-256 against its single opened-descriptor digest.
 */
export async function verifyTrustedAssetResolution(value, expectedSenderId, logger = noopDocumentPreviewLogger) {
    if (!isTrustedAssetResolution(value))
        return false;
    if (expectedSenderId !== undefined && value.senderId !== expectedSenderId)
        return false;
    try {
        const root = await realpath(value.assetRoot);
        if (root !== value.assetRoot)
            return false;
        const rootInfo = await lstat(root, { bigint: true });
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
            return false;
        const canonicalFile = await realpath(value.absolutePath);
        if (canonicalFile !== value.absolutePath || !isContained(root, canonicalFile))
            return false;
        const fileInfo = await stat(canonicalFile, { bigint: true });
        if (!fileInfo.isFile())
            return false;
        if (!sameIdentity(value.identity, identityFromStat(fileInfo)))
            return false;
        const sidecarCanonical = await realpath(value.sidecarPath);
        if (sidecarCanonical !== value.sidecarPath)
            return false;
        const sidecarInfo = await lstat(value.sidecarPath, { bigint: true });
        if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink())
            return false;
        if (!sameIdentity(value.sidecarIdentity, identityFromStat(sidecarInfo)))
            return false;
        const parsed = parseSidecar(JSON.parse(await readFile(value.sidecarPath, 'utf8')));
        if (!parsed ||
            parsed.assetId !== value.assetId ||
            parsed.sessionId !== value.sessionId ||
            parsed.fileName !== value.fileName ||
            parsed.mimeType !== value.mimeType ||
            parsed.bytes !== value.bytes ||
            parsed.sha256 !== value.sha256) {
            return false;
        }
        return true;
    }
    catch (error) {
        logger.warn({
            msg: '[DocumentPreview][asset-authority] trusted asset revalidation failed with an IO error',
            assetId: isTrustedAssetResolution(value) ? value.assetId : undefined,
            ...describeDocumentPreviewError(error),
        });
        return false;
    }
}
export function createMainOwnedAssetAuthority(options = {}) {
    const logger = options.logger ?? noopDocumentPreviewLogger;
    let dataDirResolverPromise = null;
    let cachedDataDir = null;
    let cachedAssetsRoot = null;
    const resolveAssetsRoot = async () => {
        if (options.assetsRoot)
            return canonicalAssetsRoot(options.assetsRoot, logger);
        if (!dataDirResolverPromise) {
            dataDirResolverPromise = import('../local-runtime/data-dir').then(({ resolveLocalRuntimeDataDir }) => resolveLocalRuntimeDataDir);
        }
        const resolveLocalRuntimeDataDir = await dataDirResolverPromise;
        const dataDir = resolveLocalRuntimeDataDir();
        if (dataDir !== cachedDataDir) {
            cachedDataDir = dataDir;
            cachedAssetsRoot = null;
        }
        if (cachedAssetsRoot) {
            const stillCanonical = await canonicalAssetsRoot(cachedAssetsRoot, logger);
            if (stillCanonical === cachedAssetsRoot)
                return cachedAssetsRoot;
            cachedAssetsRoot = null;
        }
        cachedAssetsRoot = await canonicalAssetsRoot(path.join(dataDir, 'v2', 'assets'), logger);
        return cachedAssetsRoot;
    };
    const scanSidecars = options.scanSidecars ?? ((root) => listSidecars(root, logger));
    let sidecarIndexRoot = null;
    let sidecarIndex = null;
    let sidecarIndexExpiresAt = 0;
    let sidecarIndexRefresh = null;
    const resetSidecarIndexRoot = (root) => {
        if (sidecarIndexRoot === root)
            return;
        sidecarIndexRoot = root;
        sidecarIndex = null;
        sidecarIndexExpiresAt = 0;
        sidecarIndexRefresh = null;
    };
    const refreshSidecarIndex = (root) => {
        resetSidecarIndexRoot(root);
        if (sidecarIndexRefresh)
            return sidecarIndexRefresh;
        const refreshRoot = root;
        const refresh = scanSidecars(root)
            .then(async (paths) => {
            const byAssetId = new Map();
            for (const sidecarPath of paths) {
                try {
                    const parsed = parseSidecar(JSON.parse(await readFile(sidecarPath, 'utf8')));
                    if (!parsed)
                        continue;
                    const bucket = byAssetId.get(parsed.assetId) ?? [];
                    bucket.push(sidecarPath);
                    byAssetId.set(parsed.assetId, bucket);
                }
                catch {
                    // A malformed sidecar is ignored; resolveSidecar remains fail closed.
                }
            }
            if (sidecarIndexRoot === refreshRoot) {
                sidecarIndex = byAssetId;
                sidecarIndexExpiresAt = Date.now() + SIDECAR_INDEX_TTL_MS;
            }
            return byAssetId;
        })
            .catch((error) => {
            logger.warn({
                msg: '[DocumentPreview][asset-authority] sidecar index refresh failed',
                root: refreshRoot,
                ...describeDocumentPreviewError(error),
            });
            return new Map();
        })
            .finally(() => {
            if (sidecarIndexRefresh === refresh)
                sidecarIndexRefresh = null;
        });
        sidecarIndexRefresh = refresh;
        return refresh;
    };
    const readSidecarIndex = async (root, forceRefresh) => {
        resetSidecarIndexRoot(root);
        if (sidecarIndexRefresh) {
            return { index: await sidecarIndexRefresh, refreshed: true };
        }
        if (!forceRefresh && sidecarIndex && Date.now() < sidecarIndexExpiresAt) {
            return { index: sidecarIndex, refreshed: false };
        }
        return { index: await refreshSidecarIndex(root), refreshed: true };
    };
    const findSidecars = async (root, assetId) => {
        const cached = await readSidecarIndex(root, false);
        const matches = cached.index.get(assetId) ?? [];
        if (matches.length > 0 || cached.refreshed)
            return matches;
        const refreshed = await readSidecarIndex(root, true);
        return refreshed.index.get(assetId) ?? [];
    };
    const senderEpochs = new Map();
    const senderAlive = new Map();
    const maxConcurrentResolutions = positiveSafeInteger(options.maxConcurrentResolutions, ASSET_AUTHORITY_DEFAULTS.maxConcurrentResolutions);
    const maxConcurrentResolutionsPerSender = Math.min(maxConcurrentResolutions, positiveSafeInteger(options.maxConcurrentResolutionsPerSender, ASSET_AUTHORITY_DEFAULTS.maxConcurrentResolutionsPerSender));
    let activeResolutions = 0;
    const activeResolutionsBySender = new Map();
    const reserveSenderResolution = (senderId) => {
        const active = activeResolutionsBySender.get(senderId) ?? 0;
        if (activeResolutions >= maxConcurrentResolutions ||
            active >= maxConcurrentResolutionsPerSender) {
            return false;
        }
        activeResolutions += 1;
        activeResolutionsBySender.set(senderId, active + 1);
        return true;
    };
    const releaseSenderResolution = (senderId) => {
        activeResolutions = Math.max(0, activeResolutions - 1);
        const active = activeResolutionsBySender.get(senderId) ?? 0;
        if (active <= 1)
            activeResolutionsBySender.delete(senderId);
        else
            activeResolutionsBySender.set(senderId, active - 1);
    };
    return {
        async resolve(input) {
            if (!validSenderId(input?.senderId) ||
                !validAssetId(input?.assetId) ||
                (input.sessionId !== undefined && !validSessionId(input.sessionId))) {
                return null;
            }
            const senderId = input.senderId;
            if (!reserveSenderResolution(senderId)) {
                // A cap rejection is not a not-found: log so the two are separable.
                logger.warn({
                    msg: '[DocumentPreview][asset-authority] resolution rejected by concurrency cap',
                    senderId,
                    assetId: input.assetId,
                    activeResolutions,
                    activeForSender: activeResolutionsBySender.get(senderId) ?? 0,
                    maxConcurrentResolutions,
                    maxConcurrentResolutionsPerSender,
                });
                return null;
            }
            try {
                const epoch = senderEpochs.get(senderId) ?? 0;
                senderAlive.set(senderId, true);
                const isCurrent = () => senderAlive.get(senderId) !== false && (senderEpochs.get(senderId) ?? 0) === epoch;
                const root = await resolveAssetsRoot();
                if (!root || !isCurrent())
                    return null;
                const resolved = await resolveSidecar(root, input.assetId, input.sessionId, findSidecars, logger);
                if (!resolved || !isCurrent())
                    return null;
                await options.beforeCommit?.();
                if (!isCurrent())
                    return null;
                const capability = Object.freeze({
                    ...resolved,
                    senderId,
                    nonce: randomBytes(24).toString('base64url'),
                });
                issuedAssetResolutions.add(capability);
                return capability;
            }
            finally {
                releaseSenderResolution(senderId);
            }
        },
        releaseSender(senderId) {
            if (!validSenderId(senderId))
                return;
            senderEpochs.set(senderId, (senderEpochs.get(senderId) ?? 0) + 1);
            senderAlive.set(senderId, false);
        },
    };
}
