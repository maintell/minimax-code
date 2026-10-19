import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PPTX_PREVIEW_LIMITS_V1 } from '@mavis/shared/pptx-rendering';
import { formatV2TimestampParts, isPathInside, resolveV2AssetDir, resolveV2DirectoryContract, sanitizeV2PathSegment, } from '../persistence/layout/v2-paths.js';
import { readRemoteAssetSource } from './remote-source.js';
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
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        sourceKind: 'generated',
        sourcePath: canonicalSource,
        sessionId,
        ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
        maxBytes,
    }, {
        buffer: sourceBytes,
        mimeType: input.mimeType || mimeFromPath(canonicalSource),
    });
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
        const root = resolveV2DirectoryContract(input.dataDir).root;
        const record = {
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
            rm(tempPath, { force: true }).catch(() => undefined),
            ...(targetPath
                ? [
                    rm(targetPath, { force: true }).catch(() => undefined),
                    rm(`${targetPath}.asset.json`, { force: true }).catch(() => undefined),
                ]
                : []),
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
    const root = resolveV2DirectoryContract(input.dataDir).root;
    const record = {
        schemaVersion: 1,
        assetId,
        kind: input.kind ?? inferAssetKind(input.mimeType ?? source.mimeType, fileName),
        sourceKind: input.sourceKind ?? 'unknown',
        fileName,
        mimeType: input.mimeType || source.mimeType || 'application/octet-stream',
        bytes: source.buffer.byteLength,
        sha256,
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
            const sourcePath = attachment.filePath || undefined;
            const inlineDataUrl = attachment.dataUrl?.startsWith('data:')
                ? attachment.dataUrl
                : undefined;
            const sourceDataUrl = attachment.dataUrl && !inlineDataUrl ? attachment.dataUrl : undefined;
            const remoteSourceUrl = !sourcePath && !inlineDataUrl ? sourceDataUrl : undefined;
            const desktopPath = attachment.desktopPath ?? (!inlineDataUrl ? sourcePath : undefined);
            if (!sourcePath && !inlineDataUrl && !remoteSourceUrl) {
                output.push(attachment);
                continue;
            }
            const record = await registerLocalAsset({
                dataDir: input.dataDir,
                fileName: attachment.fileName,
                mimeType: attachment.mimeType,
                kind: attachment.type === 'image' ? 'image' : undefined,
                sourceKind: inlineDataUrl ? 'user-paste' : 'user-upload',
                sourcePath,
                ...(remoteSourceUrl ? { sourceUrl: remoteSourceUrl } : {}),
                dataUrl: inlineDataUrl,
                ...(sourcePath && !inlineDataUrl && !remoteSourceUrl && isPptxFileName(attachment.fileName)
                    ? { maxBytes: PPTX_PREVIEW_LIMITS_V1.maxInputBytes }
                    : {}),
                ...(input.remoteAssetTransport ? { remoteAssetTransport: input.remoteAssetTransport } : {}),
                sessionId: input.sessionId,
                turnId: input.turnId,
                nowMs: input.nowMs,
            });
            created.push({ assetId: record.assetId, filePath: record.absolutePath });
            output.push({
                type: attachment.type,
                filePath: record.absolutePath,
                fileName: record.fileName,
                mimeType: record.mimeType,
                ...(desktopPath ? { desktopPath } : {}),
                assetId: record.assetId,
                ...(sourceDataUrl ? { dataUrl: sourceDataUrl } : {}),
            });
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
            let chunkOffset = 0;
            while (chunkOffset < bytesRead) {
                const { bytesWritten } = await targetHandle.write(chunk, chunkOffset, bytesRead - chunkOffset, sourceOffset + chunkOffset);
                if (bytesWritten <= 0)
                    throw new Error('asset_target_unwritable');
                chunkOffset += bytesWritten;
            }
            sourceOffset += bytesRead;
        }
        const after = await sourceHandle.stat();
        if (after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ino !== before.ino ||
            after.dev !== before.dev) {
            throw new Error('asset_source_changed');
        }
        return {
            bytes: sourceOffset,
            mimeType: input.mimeType ?? mimeFromPath(sourcePath),
            sha256: hash.digest('hex'),
        };
    }
    finally {
        await targetHandle?.close().catch(() => undefined);
        await sourceHandle.close().catch(() => undefined);
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
export async function registerLocalMessageInputAttachments(input) {
    return Promise.all(input.messages.map(async (message) => ({
        ...message,
        attachments: await registerMessageAttachments({
            dataDir: input.dataDir,
            attachments: message.attachments,
            sessionId: input.sessionId,
            turnId: input.turnId,
            nowMs: input.nowMs,
        }),
    })));
}
export function inferAssetKind(mimeType, fileName) {
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
function mimeFromPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png')
        return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg')
        return 'image/jpeg';
    if (ext === '.gif')
        return 'image/gif';
    if (ext === '.webp')
        return 'image/webp';
    if (ext === '.pdf')
        return 'application/pdf';
    if (ext === '.json')
        return 'application/json';
    if (ext === '.md' || ext === '.markdown')
        return 'text/markdown';
    if (ext === '.txt')
        return 'text/plain';
    return 'application/octet-stream';
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
        typeof record.assetId === 'string' &&
        typeof record.fileName === 'string' &&
        typeof record.mimeType === 'string' &&
        typeof record.bytes === 'number' &&
        typeof record.sha256 === 'string' &&
        typeof record.relativePath === 'string' &&
        typeof record.createdAtMs === 'number');
}
//# sourceMappingURL=store.js.map