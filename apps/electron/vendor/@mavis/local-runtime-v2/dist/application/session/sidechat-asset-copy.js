import { basename, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectMessageAssetItems } from '@mavis/shared/asset-markup';
import { rewriteForkAssetMarkup } from '../../service/session-system/index.js';
import { registrationFailureReason, } from '../conversation/attachment-registration.js';
/** Registration creates child-owned assets; both history and display use the same exact mapping. */
export async function copySideChatAssets(input) {
    const { sources, markupValues } = collectAssetSources(input.display, input.history);
    const replacements = new Map();
    const receipts = [];
    const discard = async () => {
        if (receipts.length)
            await input.registration.discard?.({ sessionId: input.sessionId, receipts });
    };
    try {
        for (const [original, source] of sources) {
            const filePath = original.startsWith('file:')
                ? fileURLToPath(original)
                : resolve(input.workspaceDir, original);
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
function collectAssetSources(display, history) {
    const sources = new Map();
    const markupValues = new Set();
    const attachmentLists = [];
    const canonicalMessages = [
        ...history.active,
        ...history.snapshots.flatMap((snapshot) => snapshot.records),
    ].map((record) => record.message);
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
    attachmentLists.push(...canonicalMessages.map((message) => message.attachments));
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
    for (const content of [...assistantText, ...canonicalMessages.flatMap(assistantTextContents)])
        addMarkupSources(content, sources, markupValues);
    return { sources, markupValues };
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
function addMarkupSources(content, sources, markupValues) {
    const assets = collectMessageAssetItems(content);
    if (assets.length)
        markupValues.add(content);
    for (const asset of assets) {
        if (!asset.path || /^(https?:|data:|drive:)/iu.test(asset.path) || sources.has(asset.path))
            continue;
        sources.set(asset.path, {
            type: 'file',
            filePath: asset.path,
            fileName: asset.name ?? basename(asset.path),
            mimeType: 'application/octet-stream',
        });
    }
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