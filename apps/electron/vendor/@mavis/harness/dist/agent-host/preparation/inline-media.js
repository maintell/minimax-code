import { findDegenerateImageReason, findProviderVideoProblem, } from '@mavis/agent-core/pi-turn-runner';
import { encodeAttachmentImage, nativeMultimodalKindForMime, selectMultimodalAttachments, } from '@mavis/agent-tools/multimodal-attachments';
/**
 * Inline media selection; file bytes come from the run's compute file system.
 *
 * Images are encoded to `encoding` before the capability limits are checked,
 * so a large original that encodes small enough is still sent inline. An
 * image that cannot be decoded is never inlined and stays a path reference:
 * history would replay its bytes into every later request.
 *
 * Media the model provider would reject on its own is not inlined either,
 * for every model alike, and its reason is returned by key: an image with an
 * edge below 8 px or an aspect ratio above 200:1 (see
 * `findDegenerateImageReason`), and a video with a broken container or one
 * that breaks a provider video rule (see `findProviderVideoProblem`). Once in
 * history such media would be replaced by a placeholder on every request, so
 * the agent is told about it now instead. The videos-per-request limit is left
 * to the outbound guard.
 */
export async function prepareLocalInlineMedia(candidates, capabilities, encoding, fs) {
    const encoded = (await Promise.all(candidates.map((candidate) => encodeInlineImage(candidate, capabilities, encoding, fs)))).filter((candidate) => candidate !== undefined);
    const selected = selectMultimodalAttachments(encoded.filter((candidate) => candidate.rejectedReason === undefined), capabilities);
    // A video is checked only once selected, so a file over the size limits is
    // never read; a rejected one still counts toward the count and body limits
    // it was selected under.
    const materialized = await Promise.all(selected.kept.map(({ candidate, kind, mime }) => materializeInlineMedia(candidate, kind, mime, fs)));
    const available = materialized.flatMap((item) => item && item.rejectedReason === undefined ? [item] : []);
    const rejectedReasons = new Map();
    for (const item of [...encoded, ...materialized]) {
        if (item?.rejectedReason !== undefined)
            rejectedReasons.set(item.key, item.rejectedReason);
    }
    return {
        rejectedReasons,
        attachments: available.map(({ attachment }) => attachment),
        items: available.map(({ key, attachment }) => ({ key, attachment })),
        inlinedKeys: new Set(available.map(({ key }) => key)),
        dimensionNotes: new Map(available.flatMap(({ key, dimensionNote }) => dimensionNote ? [[key, dimensionNote]] : [])),
    };
}
async function materializeInlineMedia(candidate, kind, mime, fs) {
    const data = candidate.data ?? (await readInlineMediaData(candidate, fs));
    if (!data)
        return undefined;
    if (kind === 'video') {
        const problem = await findProviderVideoProblem(data);
        if (problem)
            return { key: candidate.key, rejectedReason: problem.reason };
    }
    return {
        key: candidate.key,
        attachment: { type: 'image', data, mimeType: mime },
        ...(candidate.dimensionNote ? { dimensionNote: candidate.dimensionNote } : {}),
    };
}
/**
 * The original is checked first, so the reason names the size the user's
 * file has rather than the scaled copy; the encoded copy is checked too,
 * because formats other than PNG and JPEG are only measured once re-encoded.
 */
async function encodeInlineImage(candidate, capabilities, encoding, fs) {
    if (nativeMultimodalKindForMime(candidate.mime) !== 'image' ||
        capabilities?.support_image !== true) {
        return candidate;
    }
    const bytes = await readInlineMediaBytes(candidate, fs);
    if (!bytes)
        return candidate;
    const originalReason = findDegenerateImageReason(bytes, candidate.mime);
    if (originalReason !== undefined)
        return { ...candidate, rejectedReason: originalReason };
    const image = await encodedInlineImage(candidate, bytes, encoding);
    if (!image)
        return undefined;
    const rejectedReason = findDegenerateImageReason(image.data, image.mime);
    return rejectedReason === undefined ? image : { ...image, rejectedReason };
}
/** The candidate with its inline image data; undefined when the image cannot be decoded. */
async function encodedInlineImage(candidate, bytes, encoding) {
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
async function readInlineMediaData(candidate, fs) {
    const bytes = await readInlineMediaBytes(candidate, fs);
    return bytes ? Buffer.from(bytes).toString('base64') : undefined;
}
async function readInlineMediaBytes(candidate, fs) {
    if (candidate.data)
        return Buffer.from(candidate.data, 'base64');
    if (!fs)
        return undefined;
    try {
        return await fs.readFile(candidate.filePath);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=inline-media.js.map