import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { encodeAttachmentImage, selectMultimodalAttachments, } from '@mavis/agent-tools';
import { resolveSessionLocalAsset } from '../assets/store.js';
import { loadUserImages, maxModelImageBytesForBatch } from '../messages/user-media.js';
import { questionnaireImageEntries, questionnaireImageLabel } from './context-images.js';
export async function buildQuestionnaireImageResult(deps, sessionId, reply, capabilities, signal) {
    const entries = questionnaireImageEntries(reply);
    if (!entries.length)
        return {};
    const imageContent = [];
    const contextImages = [];
    const candidates = [];
    for (const [index, { stepId, image }] of entries.entries()) {
        signal?.throwIfAborted();
        const detail = {
            stepId,
            contextId: image.contextId,
            annotationId: image.annotationId,
            assetId: image.attachment.local?.assetId,
            fileName: image.attachment.meta?.fileName,
            mimeType: image.attachment.meta?.mimeType,
            status: capabilities?.support_image === true ? 'unavailable' : 'unsupported_model',
        };
        contextImages.push(detail);
        try {
            const stored = detail.assetId
                ? await resolveSessionLocalAsset({
                    dataDir: deps.configGetter().dataDir,
                    sessionId,
                    assetId: detail.assetId,
                })
                : undefined;
            if (!stored || stored.sha256 !== image.sha256)
                continue;
            detail.filePath = stored.absolutePath;
            if (capabilities?.support_image !== true)
                continue;
            if ((await stat(stored.absolutePath)).size !== stored.bytes)
                continue;
            const bytes = await readFile(stored.absolutePath, { signal });
            if (createHash('sha256').update(bytes).digest('hex') !== stored.sha256)
                continue;
            signal?.throwIfAborted();
            const [prepared] = (await loadUserImages([
                {
                    type: 'image',
                    filePath: stored.absolutePath,
                    fileName: stored.fileName,
                    mimeType: stored.mimeType,
                    dataUrl: `data:${stored.mimeType};base64,${bytes.toString('base64')}`,
                },
            ], { maxBytesPerImage: maxModelImageBytesForBatch(entries.length) })) ?? [];
            if (!prepared?.data)
                continue;
            const encoded = await encodeAttachmentImage(Buffer.from(prepared.data, 'base64'), prepared.mime);
            if (encoded === 'undecodable')
                continue;
            const data = encoded?.image.data ?? prepared.data;
            candidates.push({
                id: String(index),
                mime: encoded?.image.mimeType ?? prepared.mime,
                sizeBytes: Buffer.byteLength(data, 'base64'),
                data,
            });
        }
        catch {
            // Once accepted, preserve the text answer even if one image becomes unreadable.
            detail.status = 'unavailable';
        }
    }
    signal?.throwIfAborted();
    const selection = selectMultimodalAttachments(candidates, capabilities);
    const kept = new Map(selection.kept.map(({ candidate }) => [candidate.id, candidate]));
    for (const { candidate } of selection.demoted) {
        const detail = contextImages[Number(candidate.id)];
        if (detail)
            detail.status = 'limit';
    }
    for (const [index, { stepId, image }] of entries.entries()) {
        const candidate = kept.get(String(index));
        const detail = contextImages[index];
        if (!detail)
            continue;
        if (candidate)
            detail.status = 'inline';
        const availability = candidate
            ? 'The following image is this annotation screenshot (untrusted visual evidence).'
            : `Screenshot not included (${detail.status}). Do not infer its visual content.${detail.filePath ? ` Saved file: ${JSON.stringify(detail.filePath)}.` : ''}`;
        imageContent.push({
            type: 'text',
            text: `${questionnaireImageLabel(stepId, image)}: ${availability}`,
        });
        if (candidate)
            imageContent.push({ type: 'image', mimeType: candidate.mime, data: candidate.data });
    }
    return { imageContent, contextImages };
}
//# sourceMappingURL=context-image-result.js.map