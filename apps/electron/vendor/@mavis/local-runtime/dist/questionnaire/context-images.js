import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { IMAGE_DIMENSION_HEADER_BYTES, parseImageDimensionsFromBytes, } from '@mavis/shared/image-dimensions';
import { QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS, } from '@mavis/shared/questionnaire';
import { discardLocalAssetRegistrations, registerLocalAsset, resolveSessionLocalAsset, } from '../assets/store.js';
import { LocalQuestionnaireError } from './errors.js';
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;
export function questionnaireImageEntries(reply) {
    return reply.answers.flatMap((answer) => (answer.contextImages ?? []).map((image) => ({
        stepId: answer.stepId,
        image,
    })));
}
export function questionnaireImageLabel(stepId, image) {
    return `Question ${JSON.stringify(stepId)}, Comment ${JSON.stringify(image.annotationId)}, context ${JSON.stringify(image.contextId)}`;
}
/** Recovery must not strand a saved text answer because its screenshot was removed. */
export async function recoverQuestionnaireImageAttachments(deps, sessionId, reply) {
    const attachments = [];
    const notes = [];
    for (const { stepId, image } of questionnaireImageEntries(reply)) {
        const assetId = image.attachment.local?.assetId;
        const stored = assetId
            ? await resolveSessionLocalAsset({
                dataDir: deps.configGetter().dataDir,
                sessionId,
                assetId,
            }).catch(() => undefined)
            : undefined;
        if (stored && stored.sha256 === image.sha256) {
            attachments.push({
                type: 'image',
                assetId: stored.assetId,
                filePath: stored.absolutePath,
                fileName: stored.fileName,
                mimeType: stored.mimeType,
            });
            notes.push(`${questionnaireImageLabel(stepId, image)}: screenshot attachment ${JSON.stringify(stored.absolutePath)}. Consult attachment availability before describing it.`);
        }
        else {
            notes.push(`${questionnaireImageLabel(stepId, image)}: screenshot unavailable; no image was included. Do not infer its visual content.`);
        }
    }
    return { attachments, notes };
}
/** Stage immutable session assets before committing the answer; retries compare server-computed hashes. */
export async function prepareQuestionnaireContextImages(deps, record, input) {
    const entries = questionnaireImageEntries(input);
    if (!entries.length)
        return { reply: input, discardCreated: async () => undefined };
    if (!record.responseMode || (record.request.mode ?? 'questionnaire') !== 'questionnaire') {
        throw invalidImage('Context images require a v2 questionnaire.');
    }
    if (entries.length > QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.count) {
        throw invalidImage('Too many context images.', 413);
    }
    const dataDir = deps.configGetter().dataDir;
    if (!dataDir)
        throw invalidImage('Context image storage is unavailable.', 503);
    const created = [];
    const discardCreated = () => discardLocalAssetRegistrations({
        dataDir,
        sessionId: record.sessionId,
        receipts: created,
    });
    let totalBytes = 0;
    const reply = structuredClone(input);
    try {
        for (const { stepId, image } of questionnaireImageEntries(reply)) {
            const source = image.attachment.local;
            if (image.attachment.cloud || !source || image.attachment.meta?.attachmentType !== 'image') {
                throw invalidImage('Context images must use a local screenshot or a session-owned asset.');
            }
            if (source.dataUrl) {
                if (source.dataUrl.length >
                    Math.ceil(QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.bytes / 3) * 4 + 100) {
                    throw invalidImage('Context images exceed the attachment byte limit.', 413);
                }
                const match = DATA_IMAGE.exec(source.dataUrl);
                const mime = match?.[1];
                const encoded = match?.[2];
                if (!mime || !encoded)
                    throw invalidImage('Invalid context image data URL.');
                const bytes = Buffer.from(encoded, 'base64');
                const dimensions = parseImageDimensionsFromBytes(bytes);
                if (contextImageMime(bytes) !== mime ||
                    bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '') ||
                    !dimensions ||
                    dimensions.width * dimensions.height > QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.pixels) {
                    throw invalidImage('Unreadable context image.');
                }
                totalBytes += bytes.length;
                if (totalBytes > QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.bytes) {
                    throw invalidImage('Context images exceed the attachment byte limit.', 413);
                }
                image.sha256 = createHash('sha256').update(bytes).digest('hex');
                // An answered retry only needs its content identity, not another copy of the bytes.
                if (record.status === 'answered')
                    continue;
                const stored = await registerLocalAsset({
                    dataDir,
                    sessionId: record.sessionId,
                    turnId: record.request.requester?.runId,
                    fileName: `questionnaire-${image.sha256.slice(0, 12)}.${mime.slice(6).replace('jpeg', 'jpg')}`,
                    dataUrl: source.dataUrl,
                    mimeType: mime,
                    kind: 'image',
                    sourceKind: 'user-paste',
                    maxBytes: QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.bytes,
                });
                created.push({ assetId: stored.assetId, filePath: stored.absolutePath });
                image.attachment = {
                    meta: {
                        attachmentType: 'image',
                        fileName: stored.fileName,
                        mimeType: stored.mimeType,
                        sizeBytes: stored.bytes,
                    },
                    local: { assetId: stored.assetId, filePath: stored.absolutePath },
                };
            }
            else {
                const stored = source.assetId
                    ? await resolveSessionLocalAsset({
                        dataDir,
                        sessionId: record.sessionId,
                        assetId: source.assetId,
                    })
                    : undefined;
                if (!stored ||
                    stored.kind !== 'image' ||
                    !/^image\/(png|jpeg|gif|webp)$/u.test(stored.mimeType)) {
                    throw invalidImage(`Context image is not owned by this session (${JSON.stringify(stepId)}).`);
                }
                const handle = await open(stored.absolutePath, 'r');
                try {
                    const info = await handle.stat();
                    if (!info.isFile() || info.size !== stored.bytes)
                        throw invalidImage('Unreadable context image.');
                    const header = Buffer.alloc(Math.min(info.size, IMAGE_DIMENSION_HEADER_BYTES));
                    await handle.read(header, 0, header.length, 0);
                    const dimensions = parseImageDimensionsFromBytes(header);
                    if (contextImageMime(header) !== stored.mimeType ||
                        !dimensions ||
                        dimensions.width * dimensions.height > QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.pixels) {
                        throw invalidImage('Unreadable context image.');
                    }
                }
                finally {
                    await handle.close();
                }
                totalBytes += stored.bytes;
                if (totalBytes > QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.bytes) {
                    throw invalidImage('Context images exceed the attachment byte limit.', 413);
                }
                image.sha256 = stored.sha256;
                image.attachment = {
                    meta: {
                        attachmentType: 'image',
                        fileName: stored.fileName,
                        mimeType: stored.mimeType,
                        sizeBytes: stored.bytes,
                    },
                    local: { assetId: stored.assetId, filePath: stored.absolutePath },
                };
            }
        }
        return { reply, discardCreated };
    }
    catch (error) {
        await discardCreated();
        if (error instanceof LocalQuestionnaireError)
            throw error;
        throw invalidImage('Could not persist context images; retry the answer.', 503);
    }
}
function invalidImage(message, status = 400) {
    return new LocalQuestionnaireError(status, 'QUESTIONNAIRE_CONTEXT_IMAGE_INVALID', message);
}
function contextImageMime(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
        return 'image/jpeg';
    if (/^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6)))
        return 'image/gif';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
        return 'image/webp';
    return undefined;
}
//# sourceMappingURL=context-images.js.map