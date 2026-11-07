import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { encodeAttachmentImage, selectMultimodalAttachments, } from '@mavis/agent-tools';
import { resolveSessionLocalAsset, } from '../../../infra/file/assets-store.js';
import { loadUserImages, maxModelImageBytesForBatch, } from '../../../infra/conversation/user-media.js';
import { questionnaireImageEntries, questionnaireImageLabel } from './context-images.js';
export async function buildQuestionnaireImageResult(deps, input) {
    const { reply, capabilities, signal } = input;
    const entries = questionnaireImageEntries(reply);
    if (!entries.length)
        return {};
    const imageContent = [];
    const contextImages = [];
    const candidates = [];
    const source = {
        deps,
        sessionId: input.sessionId,
        capabilities,
        signal,
        batchSize: entries.length,
    };
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
        await collectImageCandidate(source, { index, image, detail }, candidates);
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
        appendImageContent(imageContent, { stepId, image, detail, candidate });
    }
    return { imageContent, contextImages };
}
async function collectImageCandidate(source, entry, candidates) {
    try {
        const verified = await readVerifiedImage(source, entry);
        if (!verified)
            return;
        const candidate = await toImageCandidate(source, entry.index, verified);
        if (candidate)
            candidates.push(candidate);
    }
    catch {
        // Once accepted, preserve the text answer even if one image becomes unreadable.
        entry.detail.status = 'unavailable';
    }
}
async function readVerifiedImage(source, { image, detail }) {
    const stored = detail.assetId
        ? await resolveSessionLocalAsset({
            dataDir: source.deps.configGetter().dataDir,
            sessionId: source.sessionId,
            assetId: detail.assetId,
        })
        : undefined;
    if (!stored || stored.sha256 !== image.sha256)
        return undefined;
    detail.filePath = stored.absolutePath;
    if (source.capabilities?.support_image !== true)
        return undefined;
    if ((await stat(stored.absolutePath)).size !== stored.bytes)
        return undefined;
    const bytes = await readFile(stored.absolutePath, { signal: source.signal });
    if (createHash('sha256').update(bytes).digest('hex') !== stored.sha256)
        return undefined;
    source.signal?.throwIfAborted();
    return { stored, bytes };
}
async function toImageCandidate(source, index, { stored, bytes }) {
    const [prepared] = (await loadUserImages([
        {
            type: 'image',
            filePath: stored.absolutePath,
            fileName: stored.fileName,
            mimeType: stored.mimeType,
            dataUrl: `data:${stored.mimeType};base64,${bytes.toString('base64')}`,
        },
    ], { maxBytesPerImage: maxModelImageBytesForBatch(source.batchSize) })) ?? [];
    if (!prepared?.data)
        return undefined;
    const encoded = await encodeAttachmentImage(Buffer.from(prepared.data, 'base64'), prepared.mime);
    if (encoded === 'undecodable')
        return undefined;
    const data = encoded?.image.data ?? prepared.data;
    return {
        id: String(index),
        mime: encoded?.image.mimeType ?? prepared.mime,
        sizeBytes: Buffer.byteLength(data, 'base64'),
        data,
    };
}
function appendImageContent(imageContent, entry) {
    const { stepId, image, detail, candidate } = entry;
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
//# sourceMappingURL=context-image-result.js.map