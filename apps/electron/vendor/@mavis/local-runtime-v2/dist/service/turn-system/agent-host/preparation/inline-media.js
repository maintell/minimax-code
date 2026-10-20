import { readFile } from 'node:fs/promises';
import { encodeAttachmentImage, nativeMultimodalKindForMime, selectMultimodalAttachments, } from '@mavis/agent-tools';
/**
 * Concrete local media IO kept outside the AgentHost orchestration core.
 *
 * Images are encoded to `encoding` before the capability limits are checked,
 * so a large original that encodes small enough is still sent inline. An
 * image that cannot be decoded is never inlined and stays a path reference:
 * history would replay its bytes into every later request.
 */
export async function prepareLocalInlineMedia(candidates, capabilities, encoding) {
    const encoded = await Promise.all(candidates.map((candidate) => encodeInlineImage(candidate, capabilities, encoding)));
    const selected = selectMultimodalAttachments(encoded.filter((candidate) => candidate !== undefined), capabilities);
    const materialized = await Promise.all(selected.kept.map(async ({ candidate, mime }) => {
        const data = candidate.data ?? (await readInlineMediaData(candidate));
        if (!data)
            return undefined;
        return {
            key: candidate.key,
            attachment: { type: 'image', data, mimeType: mime },
            dimensionNote: candidate.dimensionNote,
        };
    }));
    const available = materialized.filter((item) => item !== undefined);
    return {
        attachments: available.map(({ attachment }) => attachment),
        items: available.map(({ key, attachment }) => ({ key, attachment })),
        inlinedKeys: new Set(available.map(({ key }) => key)),
        dimensionNotes: new Map(available.flatMap(({ key, dimensionNote }) => dimensionNote ? [[key, dimensionNote]] : [])),
    };
}
async function encodeInlineImage(candidate, capabilities, encoding) {
    if (nativeMultimodalKindForMime(candidate.mime) !== 'image' ||
        capabilities?.support_image !== true) {
        return candidate;
    }
    const bytes = await readInlineMediaBytes(candidate);
    if (!bytes)
        return candidate;
    const encoded = await encodeAttachmentImage(bytes, candidate.mime, encoding);
    if (encoded === 'undecodable')
        return undefined;
    if (!encoded) {
        return candidate.data
            ? candidate
            : { ...candidate, data: Buffer.from(bytes).toString('base64'), sizeBytes: bytes.length };
    }
    return {
        ...candidate,
        data: encoded.image.data,
        mime: encoded.image.mimeType,
        sizeBytes: Buffer.byteLength(encoded.image.data, 'base64'),
        ...(encoded.dimensionNote ? { dimensionNote: encoded.dimensionNote } : {}),
    };
}
async function readInlineMediaData(candidate) {
    const bytes = await readInlineMediaBytes(candidate);
    return bytes ? Buffer.from(bytes).toString('base64') : undefined;
}
async function readInlineMediaBytes(candidate) {
    if (candidate.data)
        return Buffer.from(candidate.data, 'base64');
    try {
        return await readFile(candidate.filePath);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=inline-media.js.map