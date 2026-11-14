import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectMessageAssetItems } from '@mavis/shared/asset-markup';
import { inferAssetMimeType, isImageAsset, MIME_BY_EXTENSION, } from '@mavis/shared/media-asset-meta';
import { rewriteForkAssetMarkup } from '../../service/session-system/index.js';
import { registrationFailureReason, } from '../conversation/attachment-registration.js';
const V2_STORED_ASSET_PREFIX_RE = /^\d{2}-\d{2}-\d{2}-\d{3}-asset_\d{8}-\d{6}-\d{3}_[a-f0-9]{12}_[a-f0-9]{8}-(.+)$/iu;
const EXTENSION_BY_MIME = new Map(Object.entries(MIME_BY_EXTENSION).map(([ext, mime]) => [mime.toLowerCase(), `.${ext}`]));
/** Registration creates child-owned assets; both history and display use the same exact mapping. */
export async function copySideChatAssets(input) {
    const { sources, markupValues } = await collectAssetSources(input.display, input.history, input.workspaceDir, input.registration);
    const replacements = new Map();
    const receipts = [];
    const discard = async () => {
        if (receipts.length)
            await input.registration.discard?.({ sessionId: input.sessionId, receipts });
    };
    try {
        for (const [original, source] of sources) {
            const filePath = resolveLocalAssetPath(input.workspaceDir, original);
            // Dropping the source asset identity prevents the ordinary registration fast path from reusing Main ownership.
            const { assetId: oldId, ...attachment } = source;
            const registered = await registerInheritedSource(input.registration, input.sessionId, {
                ...attachment,
                filePath,
            });
            if (!registered)
                continue;
            if (registered.registrationReceipt)
                receipts.push(registered.registrationReceipt);
            replacements.set(original, registered.filePath);
            replacements.set(filePath, registered.filePath);
            replacements.set(pathToFileURL(filePath).href, pathToFileURL(registered.filePath).href);
            if (oldId && registered.assetId)
                replacements.set(oldId, registered.assetId);
        }
        for (const markup of markupValues)
            replacements.set(markup, rewriteForkAssetMarkup(markup, replacements));
        return {
            display: input.display.map((message) => rewriteAssetReferences(message, replacements)),
            replacements,
            discard,
        };
    }
    catch (error) {
        try {
            await discard();
        }
        catch {
            /* Preserve the preparation error. */
        }
        throw error;
    }
}
/**
 * Inherited history is copied best-effort, like an ordinary fork: a file Main already lost
 * (renamed, moved, deleted) or cannot persist keeps the reference Main shows.
 */
async function registerInheritedSource(registration, sessionId, attachment) {
    let registered;
    try {
        registered = await registration.register({ sessionId, attachments: [attachment] });
    }
    catch (error) {
        if (registrationFailureReason(error))
            return undefined;
        throw error;
    }
    if (!registered[0])
        throw new Error('Attachment registration returned no asset');
    return registered[0];
}
function rewriteAssetReferences(value, replacements) {
    if (typeof value === 'string')
        return (replacements.get(value) ?? value);
    if (Array.isArray(value))
        return value.map((item) => rewriteAssetReferences(item, replacements));
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        key === 'msg_content' && typeof item === 'string'
            ? rewriteForkAssetMarkup(item, replacements)
            : rewriteAssetReferences(item, replacements),
    ]));
}
async function collectAssetSources(display, history, workspaceDir, registration) {
    const sources = new Map();
    const markupValues = new Set();
    const attachmentLists = [];
    const canonical = await collectCanonicalAssets(history);
    for (const value of display) {
        const record = value;
        // The caller supplies either display rows or queued input, whose batch members own their attachments.
        attachmentLists.push(record.attachments, asRecord(record.message)?.attachments);
        const batch = asRecord(record.immediateSendBatch);
        if (Array.isArray(batch?.members)) {
            for (const member of batch.members)
                attachmentLists.push(asRecord(asRecord(member)?.message)?.attachments);
        }
    }
    attachmentLists.push(...canonical.attachments);
    for (const attachments of attachmentLists) {
        if (!Array.isArray(attachments))
            continue;
        for (const attachment of attachments) {
            const item = asRecord(attachment);
            const source = item && attachmentSource(item);
            if (source)
                sources.set(source.filePath, source);
        }
    }
    // Asset markup is an assistant output format, not an arbitrary history string.
    // User/system reminders and tool arguments can contain documentation examples.
    const assistantText = display.flatMap((value) => {
        const record = value;
        return record.role === 'assistant' && typeof record.msg_content === 'string'
            ? [record.msg_content]
            : [];
    });
    for (const content of [...assistantText, ...canonical.markupText]) {
        addMarkupSources(content, { workspaceDir, registration, sources, markupValues });
    }
    return { sources, markupValues };
}
/**
 * Canonical history is visited one record at a time, active first and then each archived
 * generation; only attachment lists and Assistant text that carries asset markup are kept.
 */
async function collectCanonicalAssets(history) {
    const attachments = [];
    const markupText = [];
    const visit = (record) => {
        const list = record.message.attachments;
        if (Array.isArray(list) && list.length > 0)
            attachments.push(list);
        for (const content of assistantTextContents(record.message)) {
            if (collectMessageAssetItems(content).length > 0)
                markupText.push(content);
        }
    };
    history.active.forEach(visit);
    for (const snapshot of history.snapshots)
        await history.forEachSnapshotRecord(snapshot, visit);
    return { attachments, markupText };
}
function assistantTextContents(message) {
    if (message.role !== 'assistant')
        return [];
    if (typeof message.content === 'string')
        return [message.content];
    if (!Array.isArray(message.content))
        return [];
    return message.content.flatMap((value) => {
        const block = asRecord(value);
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    });
}
/**
 * SideChat shares Main's workspaceDir, so ordinary workspace deliverables stay at their original
 * paths like a non-isolated Fork (`records-only`). Only files stored inside `<dataDir>/v2/assets`
 * are Session-scoped and must be copied to Side ownership, preserving their real file extension.
 */
function addMarkupSources(content, context) {
    const assets = collectMessageAssetItems(content);
    if (assets.length)
        context.markupValues.add(content);
    for (const asset of assets) {
        if (!asset.path ||
            /^(https?:|data:|drive:)/iu.test(asset.path) ||
            context.sources.has(asset.path))
            continue;
        const resolvedPath = resolveLocalAssetPath(context.workspaceDir, asset.path);
        const stored = context.registration.inspectStoredAsset?.(resolvedPath);
        if (!stored)
            continue;
        context.sources.set(asset.path, storedMarkupSource(asset, resolvedPath, stored));
    }
}
function storedMarkupSource(asset, resolvedPath, stored) {
    const mimeType = usableMimeType(stored.mimeType) ?? inferAssetMimeType(asset) ?? 'application/octet-stream';
    const isImage = stored.kind === 'image' || mimeType.startsWith('image/') || isImageAsset(asset);
    const pathBaseName = stripStoredAssetPrefix(basename(resolvedPath));
    const fallbackExt = extname(pathBaseName) || EXTENSION_BY_MIME.get(mimeType.toLowerCase()) || '';
    const fileName = ensureExtension(stored.fileName.trim() || pathBaseName, fallbackExt);
    return {
        type: isImage ? 'image' : 'file',
        filePath: asset.path,
        fileName,
        mimeType,
        ...(stored.assetId ? { assetId: stored.assetId } : {}),
    };
}
function resolveLocalAssetPath(workspaceDir, rawPath) {
    if (rawPath.startsWith('file:'))
        return fileURLToPath(rawPath);
    if (rawPath.startsWith('~/'))
        return resolve(homedir(), rawPath.slice(2));
    return resolve(workspaceDir, rawPath);
}
function stripStoredAssetPrefix(name) {
    return V2_STORED_ASSET_PREFIX_RE.exec(name)?.[1] ?? name;
}
function usableMimeType(value) {
    const trimmed = value?.trim();
    return trimmed && trimmed.toLowerCase() !== 'application/octet-stream' ? trimmed : undefined;
}
function ensureExtension(fileName, fallbackExt) {
    if (!fallbackExt || extname(fileName))
        return fileName;
    return `${fileName}${fallbackExt}`;
}
function attachmentSource(record) {
    const local = asRecord(record.local) ?? record;
    const meta = asRecord(record.meta) ?? record;
    if (typeof local.filePath !== 'string' || !local.filePath)
        return undefined;
    return {
        type: meta.attachmentType === 'image' || record.type === 'image' ? 'image' : 'file',
        filePath: local.filePath,
        fileName: typeof meta.fileName === 'string' ? meta.fileName : basename(local.filePath),
        mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
        ...(typeof local.assetId === 'string' ? { assetId: local.assetId } : {}),
    };
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=sidechat-asset-copy.js.map