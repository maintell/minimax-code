import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile, } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PPTX_PREVIEW_LIMITS_V1 } from '@mavis/shared/pptx-rendering';
import { formatV2TimestampParts, isPathInside, resolveV2AssetDir, resolveV2DirectoryContract, sanitizeV2PathSegment, } from '../legacy-db/v2-paths.js';
import { readRemoteAssetSource } from './assets-remote-source.js';
const DEFAULT_MAX_LOCAL_ASSET_BYTES = 100 * 1024 * 1024;
const LOCAL_ASSET_STREAM_BUFFER_BYTES = 64 * 1024;
export class LocalAssetManifestDiagnosticSource {
    id = 'asset-manifest';
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    describe() {
        return {
            label: 'Local asset manifest',
            privacy: 'masked',
            uploadDefault: 'consent-required',
        };
    }
    async collect(input) {
        const records = listAssetSidecars(resolveV2DirectoryContract(this.dataDir).assets)
            .flatMap((filePath) => readAssetSidecar(filePath))
            .filter((record) => record.createdAtMs >= input.sinceMs)
            .map((record) => ({
            assetId: record.assetId,
            kind: record.kind,
            sourceKind: record.sourceKind,
            fileName: record.fileName,
            mimeType: record.mimeType,
            bytes: record.bytes,
            sha256: record.sha256,
            relativePath: record.relativePath,
            createdAtMs: record.createdAtMs,
            diagnosticUploadDefault: record.diagnosticUploadDefault,
            rawIncluded: false,
            ...(record.sessionId ? { sessionId: record.sessionId } : {}),
            ...(record.turnId ? { turnId: record.turnId } : {}),
        }));
        if (records.length === 0)
            return [];
        const content = Buffer.from(`${JSON.stringify({
            schemaVersion: 1,
            generatedAtMs: input.nowMs,
            rawAssetsIncluded: false,
            assets: records,
        }, null, 2)}\n`, 'utf-8');
        return [
            {
                name: 'mavis-assets/asset-manifest.json',
                content,
                bytes: content.byteLength,
                source: this.id,
                privacy: 'masked',
                uploadDefault: 'consent-required',
            },
        ];
    }
}
/** Resolve one immutable v2 asset only when its sidecar owns the exact Session. */
export async function resolveSessionLocalAsset(input) {
    const assetId = input.assetId.trim();
    const sessionId = input.sessionId.trim();
    if (!assetId || !sessionId)
        return undefined;
    return listRegisteredV2Assets(input.dataDir).find((record) => record.assetId === assetId && record.sessionId === sessionId);
}
/** Resolves either an immutable asset path or its original local source path within one Session. */
export function resolveSessionLocalAssetSource(input) {
    const sessionId = input.sessionId.trim();
    const candidate = canonicalExistingPath(input.filePath);
    if (!sessionId || !candidate)
        return undefined;
    const record = listRegisteredV2Assets(input.dataDir).find((asset) => {
        if (asset.sessionId !== sessionId)
            return false;
        if (canonicalExistingPath(asset.absolutePath) === candidate)
            return true;
        return asset.sourcePath ? canonicalExistingPath(asset.sourcePath) === candidate : false;
    });
    if (!record)
        return undefined;
    return {
        filePath: (record.sourcePath && canonicalExistingPath(record.sourcePath)) || record.absolutePath,
        fileName: record.fileName,
        assetPath: record.absolutePath,
    };
}
/**
 * Adopt a Session-owned file into the shared v2 asset store. Assets with the
 * same immutable bytes are reused inside one Session; an overwritten source
 * path receives a new assetId because its sha256 changes.
 */
export async function registerSessionLocalAsset(input) {
    const sessionId = input.sessionId.trim();
    if (!sessionId)
        throw new Error('asset_session_required');
    const canonicalSource = await realpath(expandHomePath(input.sourcePath));
    const sourceInfo = await stat(canonicalSource);
    if (!sourceInfo.isFile())
        throw new Error('asset_source_not_file');
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES;
    if (sourceInfo.size > maxBytes)
        throw new Error('asset_too_large');
    const sourceBytes = await readFile(canonicalSource);
    const sha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const reusable = listRegisteredV2Assets(input.dataDir).find((record) => record.sessionId === sessionId &&
        record.sha256 === sha256 &&
        record.bytes === sourceBytes.byteLength &&
        isSameAssetSource(record, canonicalSource));
    if (reusable)
        return reusable;
    return materializeLocalAsset({
        dataDir: input.dataDir,
        fileName: input.fileName?.trim() || path.basename(canonicalSource),
        ...sessionAssetMetadata(input),
        sourceKind: 'generated',
        sourcePath: canonicalSource,
        sessionId,
        maxBytes,
    }, {
        buffer: sourceBytes,
        mimeType: input.mimeType || mimeFromPath(canonicalSource),
    });
}
function sessionAssetMetadata(input) {
    return {
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    };
}
export async function registerLocalAsset(input) {
    return materializeLocalAsset(input);
}
async function materializeLocalAsset(input, preparedSource) {
    const now = input.nowMs?.() ?? Date.now();
    const stamp = formatV2TimestampParts(now);
    const fileName = sanitizeV2PathSegment(input.fileName, 'attachment');
    const dir = resolveV2AssetDir(input.dataDir, now);
    await mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.attachment.${randomUUID().slice(0, 8)}.tmp`);
    let targetPath;
    try {
        const source = await stageAssetSource(input, tempPath, preparedSource);
        const assetId = `asset_${stamp.compact}_${source.sha256.slice(0, 12)}_${randomUUID().slice(0, 8)}`;
        const targetName = `${stamp.time}-${assetId}-${fileName}`;
        targetPath = path.join(dir, targetName);
        const record = createAssetRecord({ input, source, assetId, fileName, targetPath, now });
        await writeFile(`${targetPath}.asset.json`, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
        await rename(tempPath, targetPath);
        await writeFile(path.join(dir, 'assets.jsonl'), `${JSON.stringify(record)}\n`, {
            encoding: 'utf-8',
            flag: 'a',
        });
        return record;
    }
    catch (err) {
        await Promise.all([
            safeRm(tempPath),
            ...(targetPath ? [safeRm(targetPath), safeRm(`${targetPath}.asset.json`)] : []),
        ]);
        throw err;
    }
}
export function registerLocalAssetSync(input) {
    const now = input.nowMs?.() ?? Date.now();
    const source = readAssetSourceSync(input);
    const sha256 = createHash('sha256').update(source.buffer).digest('hex');
    const stamp = formatV2TimestampParts(now);
    const fileName = sanitizeV2PathSegment(input.fileName, 'attachment');
    const assetId = `asset_${stamp.compact}_${sha256.slice(0, 12)}_${randomUUID().slice(0, 8)}`;
    const dir = resolveV2AssetDir(input.dataDir, now);
    mkdirSync(dir, { recursive: true });
    const targetName = `${stamp.time}-${assetId}-${fileName}`;
    const targetPath = path.join(dir, targetName);
    const tempPath = path.join(dir, `.${targetName}.${randomUUID().slice(0, 8)}.tmp`);
    const record = createAssetRecord({
        input,
        source: { bytes: source.buffer.byteLength, sha256, mimeType: source.mimeType },
        assetId,
        fileName,
        targetPath,
        now,
    });
    try {
        writeFileSync(tempPath, source.buffer);
        writeFileSync(`${targetPath}.asset.json`, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
        renameSync(tempPath, targetPath);
        writeFileSync(path.join(dir, 'assets.jsonl'), `${JSON.stringify(record)}\n`, {
            encoding: 'utf-8',
            flag: 'a',
        });
    }
    catch (err) {
        safeRmSync(tempPath);
        safeRmSync(targetPath);
        safeRmSync(`${targetPath}.asset.json`);
        throw err;
    }
    return record;
}
function createAssetRecord(context) {
    const { input, source, assetId, fileName, targetPath, now } = context;
    const root = resolveV2DirectoryContract(input.dataDir).root;
    return {
        schemaVersion: 1,
        assetId,
        kind: input.kind ?? inferAssetKind(input.mimeType ?? source.mimeType, fileName),
        sourceKind: input.sourceKind ?? 'unknown',
        fileName,
        mimeType: input.mimeType || source.mimeType || 'application/octet-stream',
        bytes: source.bytes,
        sha256: source.sha256,
        absolutePath: targetPath,
        relativePath: path.relative(root, targetPath).replaceAll(path.sep, '/'),
        createdAtMs: now,
        privacy: 'raw-user-asset',
        diagnosticUploadDefault: 'never',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
        ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
    };
}
export async function registerMessageAttachments(input) {
    const output = [];
    const created = [];
    try {
        for (const attachment of input.attachments) {
            if (attachment.assetId &&
                isRegisteredV2AssetPath(input.dataDir, attachment.filePath, attachment.assetId)) {
                output.push(attachment);
                continue;
            }
            output.push(await registerMessageAttachment(input, attachment, created));
        }
    }
    catch (error) {
        await discardLocalAssetRegistrations({
            dataDir: input.dataDir,
            sessionId: input.sessionId,
            receipts: created,
        });
        throw error;
    }
    return output;
}
function attachmentSource(attachment) {
    const sourcePath = attachment.filePath || undefined;
    const inlineDataUrl = attachment.dataUrl?.startsWith('data:') ? attachment.dataUrl : undefined;
    const sourceDataUrl = attachment.dataUrl && !inlineDataUrl ? attachment.dataUrl : undefined;
    const remoteSourceUrl = !sourcePath && !inlineDataUrl ? sourceDataUrl : undefined;
    const desktopPath = attachment.desktopPath ?? (!inlineDataUrl ? sourcePath : undefined);
    return { sourcePath, inlineDataUrl, sourceDataUrl, remoteSourceUrl, desktopPath };
}
async function registerMessageAttachment(input, attachment, created) {
    const source = attachmentSource(attachment);
    const { sourcePath, inlineDataUrl, remoteSourceUrl, desktopPath, sourceDataUrl } = source;
    if (!sourcePath && !inlineDataUrl && !remoteSourceUrl)
        return attachment;
    const record = await registerLocalAsset({
        dataDir: input.dataDir,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        kind: attachment.type === 'image' ? 'image' : undefined,
        sourceKind: inlineDataUrl ? 'user-paste' : 'user-upload',
        sourcePath,
        ...(remoteSourceUrl ? { sourceUrl: remoteSourceUrl } : {}),
        dataUrl: inlineDataUrl,
        ...attachmentRegistrationOptions(input, attachment, source),
        sessionId: input.sessionId,
        turnId: input.turnId,
        nowMs: input.nowMs,
    });
    created.push({ assetId: record.assetId, filePath: record.absolutePath });
    return {
        type: attachment.type,
        filePath: record.absolutePath,
        fileName: record.fileName,
        mimeType: record.mimeType,
        ...(desktopPath ? { desktopPath } : {}),
        assetId: record.assetId,
        ...(sourceDataUrl ? { dataUrl: sourceDataUrl } : {}),
    };
}
function attachmentRegistrationOptions(input, attachment, source) {
    return {
        ...(source.sourcePath &&
            !source.inlineDataUrl &&
            !source.remoteSourceUrl &&
            isPptxFileName(attachment.fileName)
            ? { maxBytes: PPTX_PREVIEW_LIMITS_V1.maxInputBytes }
            : {}),
        ...(input.remoteAssetTransport ? { remoteAssetTransport: input.remoteAssetTransport } : {}),
    };
}
function isPptxFileName(fileName) {
    return path.extname(fileName).toLowerCase() === '.pptx';
}
async function stageAssetSource(input, tempPath, preparedSource) {
    const sourcePath = input.sourcePath;
    if (!preparedSource && sourcePath && !input.dataUrl && !input.sourceUrl) {
        return stageLocalPathAssetSource(input, sourcePath, tempPath);
    }
    const source = preparedSource ?? (await readAssetSource(input));
    await writeFile(tempPath, source.buffer, { flag: 'wx', mode: 0o600 });
    return {
        bytes: source.buffer.byteLength,
        mimeType: source.mimeType,
        sha256: createHash('sha256').update(source.buffer).digest('hex'),
    };
}
async function stageLocalPathAssetSource(input, sourcePath, tempPath) {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES;
    const sourceHandle = await open(sourcePath, 'r');
    let targetHandle;
    try {
        const before = await sourceHandle.stat();
        if (!before.isFile())
            throw new Error('asset_source_not_file');
        if (before.size > maxBytes)
            throw new Error('asset_too_large');
        targetHandle = await open(tempPath, 'wx', 0o600);
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(LOCAL_ASSET_STREAM_BUFFER_BYTES);
        let sourceOffset = 0;
        while (sourceOffset < before.size) {
            const requested = Math.min(buffer.byteLength, before.size - sourceOffset);
            const { bytesRead } = await sourceHandle.read(buffer, 0, requested, sourceOffset);
            if (bytesRead <= 0)
                throw new Error('asset_source_unreadable');
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            await writeAssetChunk(targetHandle, chunk, sourceOffset);
            sourceOffset += bytesRead;
        }
        assertAssetSourceUnchanged(before, await sourceHandle.stat());
        return {
            bytes: sourceOffset,
            mimeType: input.mimeType ?? mimeFromPath(sourcePath),
            sha256: hash.digest('hex'),
        };
    }
    finally {
        await closeAssetHandle(targetHandle);
        await closeAssetHandle(sourceHandle);
    }
}
function assertAssetSourceUnchanged(before, after) {
    if (after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino ||
        after.dev !== before.dev) {
        throw new Error('asset_source_changed');
    }
}
async function writeAssetChunk(handle, chunk, sourceOffset) {
    let chunkOffset = 0;
    while (chunkOffset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, chunkOffset, chunk.byteLength - chunkOffset, sourceOffset + chunkOffset);
        if (bytesWritten <= 0)
            throw new Error('asset_target_unwritable');
        chunkOffset += bytesWritten;
    }
}
async function closeAssetHandle(handle) {
    try {
        await handle?.close();
    }
    catch {
        // Closing a staged source must not replace its materialization result.
    }
}
/** Removes only request-scoped assets that never reached durable admission. */
export async function discardLocalAssetRegistrations(input) {
    await Promise.all(input.receipts.map(async ({ assetId, filePath }) => {
        try {
            if (!isRegisteredV2AssetPath(input.dataDir, filePath, assetId))
                return;
            const [record] = readAssetSidecar(`${filePath}.asset.json`);
            if (!record || record.sessionId !== input.sessionId)
                return;
            await Promise.all([
                rm(filePath, { force: true }),
                rm(`${filePath}.asset.json`, { force: true }),
            ]);
        }
        catch {
            // Cleanup is best effort and must not replace the original admission failure.
        }
    }));
}
function inferAssetKind(mimeType, fileName) {
    const mime = (mimeType ?? '').toLowerCase();
    const ext = path.extname(fileName).toLowerCase();
    if (mime.startsWith('image/'))
        return 'image';
    if (mime.startsWith('audio/'))
        return 'audio';
    if (mime.startsWith('video/'))
        return 'video';
    if (mime === 'application/pdf')
        return 'document';
    if ([
        '.pdf',
        '.doc',
        '.docx',
        '.ppt',
        '.pptx',
        '.xls',
        '.xlsx',
        '.csv',
        '.numbers',
        '.pages',
        '.key',
    ].includes(ext)) {
        return 'document';
    }
    if (['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z'].includes(ext))
        return 'archive';
    if (mime.startsWith('text/'))
        return 'file';
    if (mime)
        return 'binary';
    return 'file';
}
function isV2AssetPath(dataDir, filePath) {
    if (!filePath)
        return false;
    try {
        const assetsRoot = realpathSync(resolveV2DirectoryContract(dataDir).assets);
        const assetPath = realpathSync(filePath);
        return isPathInside(assetsRoot, assetPath);
    }
    catch {
        return false;
    }
}
function isRegisteredV2AssetPath(dataDir, filePath, assetId) {
    if (!isV2AssetPath(dataDir, filePath))
        return false;
    const sidecarPath = `${filePath}.asset.json`;
    try {
        const sidecarInfo = lstatSync(sidecarPath);
        if (sidecarInfo.isSymbolicLink() || !sidecarInfo.isFile())
            return false;
        const [record] = readAssetSidecar(sidecarPath);
        if (!record || record.assetId !== assetId)
            return false;
        const root = resolveV2DirectoryContract(dataDir).root;
        const recordedPath = path.join(root, record.relativePath);
        const fileInfo = statSync(filePath);
        return (fileInfo.isFile() &&
            fileInfo.size === record.bytes &&
            realpathSync(recordedPath) === realpathSync(filePath));
    }
    catch {
        return false;
    }
}
function listRegisteredV2Assets(dataDir) {
    const contract = resolveV2DirectoryContract(dataDir);
    return listAssetSidecars(contract.assets).flatMap((sidecarPath) => {
        const [record] = readAssetSidecar(sidecarPath);
        if (!record)
            return [];
        const filePath = path.join(contract.root, record.relativePath);
        if (!isRegisteredV2AssetPath(dataDir, filePath, record.assetId))
            return [];
        try {
            return [{ ...record, absolutePath: realpathSync(filePath) }];
        }
        catch {
            return [];
        }
    });
}
const SESSION_ASSET_INDEX_REFRESH_MS = 1_000;
/**
 * Per-Session view of the shared v2 asset store, cheap enough for every
 * permission check. The store is one dated tree shared by all Sessions, and
 * each asset's sidecar names the Session that registered it.
 *
 * All file-system work is asynchronous, so even the cold first scan of a large
 * store never blocks the runtime's event loop; concurrent callers share one
 * in-flight scan. A directory is re-read only when its mtime changes (adding
 * or removing an asset changes it), and the tree is re-walked at most once per
 * refresh interval.
 */
export function createSessionAssetPathIndex(dataDir, options = {}) {
    const nowMs = options.nowMs ?? Date.now;
    const refreshIntervalMs = options.refreshIntervalMs ?? SESSION_ASSET_INDEX_REFRESH_MS;
    let directories = new Map();
    let refreshedAtMs;
    let inFlight;
    const scan = async () => {
        const contract = resolveV2DirectoryContract(dataDir);
        const assetsRoot = await undefinedOnFsError(realpath(contract.assets));
        const next = new Map();
        if (assetsRoot) {
            for (const { directory, mtimeMs } of await listAssetDirectories(contract.assets)) {
                const previous = directories.get(directory);
                next.set(directory, previous?.mtimeMs === mtimeMs
                    ? previous
                    : {
                        mtimeMs,
                        entries: await readAssetDirectoryEntries(contract.root, assetsRoot, directory),
                    });
            }
        }
        directories = next;
    };
    const refresh = () => {
        if (inFlight)
            return inFlight;
        const now = nowMs();
        if (refreshedAtMs !== undefined && now - refreshedAtMs < refreshIntervalMs) {
            return Promise.resolve();
        }
        refreshedAtMs = now;
        inFlight = (async () => {
            try {
                await scan();
            }
            finally {
                inFlight = undefined;
            }
        })();
        return inFlight;
    };
    return {
        async listSessionAssetPaths(sessionIds) {
            const wanted = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
            if (wanted.size === 0)
                return [];
            await refresh();
            const paths = [];
            for (const { entries } of directories.values()) {
                for (const entry of entries) {
                    if (wanted.has(entry.sessionId))
                        paths.push(entry.filePath);
                }
            }
            return paths;
        },
    };
}
/** Resolves to `undefined` when the file-system call rejects. */
async function undefinedOnFsError(operation) {
    try {
        return await operation;
    }
    catch {
        return undefined;
    }
}
/** Real (non-symlink) directories under the asset root, with their mtimes. */
async function listAssetDirectories(root) {
    const found = [];
    const visit = async (directory) => {
        const info = await undefinedOnFsError(lstat(directory));
        if (!info || info.isSymbolicLink() || !info.isDirectory())
            return;
        found.push({ directory, mtimeMs: info.mtimeMs });
        const names = (await undefinedOnFsError(readdir(directory))) ?? [];
        for (const name of names) {
            // Asset files and sidecars carry an extension; dated directories do not.
            if (!name.includes('.'))
                await visit(path.join(directory, name));
        }
    };
    await visit(root);
    return found;
}
/**
 * Valid Session-owned assets in one directory. Each sidecar is read once; the
 * asset must sit next to it, be a regular file of the recorded size, and
 * resolve inside the canonical asset root.
 */
async function readAssetDirectoryEntries(v2Root, assetsRoot, directory) {
    const names = (await undefinedOnFsError(readdir(directory))) ?? [];
    const entries = [];
    for (const name of names) {
        if (!name.endsWith('.asset.json'))
            continue;
        const entry = await readAssetDirectoryEntry(v2Root, assetsRoot, path.join(directory, name));
        if (entry)
            entries.push(entry);
    }
    return entries;
}
async function readAssetDirectoryEntry(v2Root, assetsRoot, sidecarPath) {
    try {
        const sidecarInfo = await lstat(sidecarPath);
        if (sidecarInfo.isSymbolicLink() || !sidecarInfo.isFile())
            return undefined;
        const parsed = JSON.parse(await readFile(sidecarPath, 'utf-8'));
        if (!isLocalRuntimeAssetRecord(parsed) || !parsed.sessionId)
            return undefined;
        const filePath = path.join(v2Root, parsed.relativePath);
        if (`${filePath}.asset.json` !== sidecarPath)
            return undefined;
        const fileInfo = await stat(filePath);
        if (!fileInfo.isFile() || fileInfo.size !== parsed.bytes)
            return undefined;
        if (!isPathInside(assetsRoot, await realpath(filePath)))
            return undefined;
        return { sessionId: parsed.sessionId, filePath };
    }
    catch {
        return undefined;
    }
}
function isSameAssetSource(record, canonicalSource) {
    if (record.absolutePath === canonicalSource)
        return true;
    if (!record.sourcePath)
        return false;
    try {
        return realpathSync(record.sourcePath) === canonicalSource;
    }
    catch {
        return false;
    }
}
function expandHomePath(sourcePath) {
    return sourcePath.startsWith('~/') ? path.resolve(homedir(), sourcePath.slice(2)) : sourcePath;
}
function canonicalExistingPath(sourcePath) {
    try {
        return realpathSync(expandHomePath(sourcePath));
    }
    catch {
        return undefined;
    }
}
async function readAssetSource(input) {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES;
    if (input.dataUrl) {
        const decoded = decodeDataUrl(input.dataUrl, maxBytes);
        if (decoded === 'too_large')
            throw new Error('asset_too_large');
        if (!decoded)
            throw new Error('invalid_asset_data_url');
        return decoded;
    }
    if (input.sourceUrl) {
        return readRemoteAssetSource({
            url: input.sourceUrl,
            maxBytes,
            ...(input.remoteAssetTransport ? { transport: input.remoteAssetTransport } : {}),
        });
    }
    throw new Error('asset_source_required');
}
function readAssetSourceSync(input) {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_LOCAL_ASSET_BYTES;
    if (input.dataUrl) {
        const decoded = decodeDataUrl(input.dataUrl, maxBytes);
        if (decoded === 'too_large')
            throw new Error('asset_too_large');
        if (!decoded)
            throw new Error('invalid_asset_data_url');
        return decoded;
    }
    if (input.sourceUrl)
        throw new Error('asset_remote_source_requires_async_registration');
    if (!input.sourcePath)
        throw new Error('asset_source_required');
    const info = statSync(input.sourcePath);
    if (!info.isFile())
        throw new Error('asset_source_not_file');
    if (info.size > maxBytes)
        throw new Error('asset_too_large');
    return {
        buffer: readFileSync(input.sourcePath),
        mimeType: input.mimeType ?? mimeFromPath(input.sourcePath),
    };
}
function decodeDataUrl(dataUrl, maxBytes) {
    if (!dataUrl.startsWith('data:'))
        return null;
    const comma = dataUrl.indexOf(',');
    if (comma < 0)
        return null;
    const meta = dataUrl.slice('data:'.length, comma);
    const body = dataUrl.slice(comma + 1);
    const [rawMime = '', ...rawParams] = meta.split(';');
    const mimeType = (rawMime || 'application/octet-stream').toLowerCase();
    const isBase64 = rawParams.some((param) => param.toLowerCase() === 'base64');
    const estimatedBytes = isBase64 ? Math.floor(body.replace(/=+$/, '').length * 0.75) : body.length;
    if (estimatedBytes > maxBytes)
        return 'too_large';
    try {
        const buffer = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
        if (buffer.byteLength > maxBytes)
            return 'too_large';
        return {
            mimeType,
            buffer,
        };
    }
    catch {
        return null;
    }
}
const ASSET_MIME_BY_EXTENSION = new Map([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.pdf', 'application/pdf'],
    ['.json', 'application/json'],
    ['.md', 'text/markdown'],
    ['.markdown', 'text/markdown'],
    ['.txt', 'text/plain'],
]);
function mimeFromPath(filePath) {
    return (ASSET_MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream');
}
async function safeRm(filePath) {
    try {
        await rm(filePath, { force: true });
    }
    catch {
        // Best effort cleanup after a failed asset materialization.
    }
}
function safeRmSync(filePath) {
    try {
        rmSync(filePath, { force: true });
    }
    catch {
        // Best effort cleanup after a failed asset materialization.
    }
}
function listAssetSidecars(root) {
    const files = [];
    const visit = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of entries) {
            const filePath = path.join(dir, name);
            let info;
            try {
                info = lstatSync(filePath);
            }
            catch {
                continue;
            }
            if (info.isSymbolicLink())
                continue;
            if (info.isDirectory()) {
                visit(filePath);
                continue;
            }
            if (info.isFile() && name.endsWith('.asset.json'))
                files.push(filePath);
        }
    };
    visit(root);
    return files;
}
function readAssetSidecar(filePath) {
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
        return isLocalRuntimeAssetRecord(parsed) ? [parsed] : [];
    }
    catch {
        return [];
    }
}
function isLocalRuntimeAssetRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return (record.schemaVersion === 1 &&
        [record.assetId, record.fileName, record.mimeType, record.sha256, record.relativePath].every((field) => typeof field === 'string') &&
        typeof record.bytes === 'number' &&
        typeof record.createdAtMs === 'number');
}
//# sourceMappingURL=assets-store.js.map