import { toUserModelSelection } from '../conversation/model-selection.js';
import { basename } from 'node:path';
import { isInlineDisplayDataUrl, } from '../../service/session-system/index.js';
export function toQueueMessageInput(input) {
    return {
        content: input.content ?? '',
        ...(input.computerUse ? { computerUse: { enable: input.computerUse.enable } } : {}),
        attachments: (input.attachments ?? []).flatMap((attachment) => {
            const mapped = toQueueAttachment(attachment);
            return mapped ? [mapped] : [];
        }),
    };
}
export function toQueueMessageUpdate(input) {
    if (input.content === undefined && input.attachments === undefined)
        return undefined;
    return toQueueMessageInput(input);
}
export function mergeQueueMessageUpdate(existing, input) {
    if (input.content === undefined && input.attachments === undefined)
        return undefined;
    const update = toQueueMessageInput(input);
    return {
        ...existing,
        ...(input.content !== undefined ? { content: update.content } : {}),
        ...(input.attachments !== undefined ? { attachments: update.attachments } : {}),
    };
}
export function toQueueModelOverride(input) {
    const selection = toUserModelSelection(input);
    const fields = {
        providerId: 'provider_id',
        modelId: 'model_id',
        variant: 'variant',
        reasoning: 'reasoning',
        contextLimit: 'context_limit',
        thinking: 'thinking',
    };
    const override = Object.fromEntries(Object.entries(selection).map(([key, value]) => [
        fields[key],
        value,
    ]));
    return Object.keys(override).length > 0 ? override : undefined;
}
export function toQueuedMessageItemView(item, overrides = {}) {
    return {
        itemId: item.itemId,
        sessionId: item.sessionId,
        status: overrides.status ?? item.status,
        source: item.source,
        content: item.message.displayContent ?? (item.source === 'thread-goal' ? '' : item.message.content),
        attachments: item.message.attachments.map(toAttachmentView),
        ...(item.model ? { modelInfo: toModelInfoView(item.model) } : {}),
        createdAt: item.createdAt,
        ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
        ...(overrides.finishedAt !== undefined ? { finishedAt: overrides.finishedAt } : {}),
        ...(item.message.source === 'code_review' ? { reviewRequest: { scope: 'local_changes' } } : {}),
        ...(item.message.computerUse ? { computerUse: item.message.computerUse } : {}),
    };
}
function toQueueAttachment(input) {
    const drive = toQueueDriveAsset(input);
    const location = toQueueAttachmentLocation(input) ?? (drive ? { filePath: '' } : undefined);
    if (!location)
        return undefined;
    const mimeType = input.meta?.mimeType ?? '';
    const fileName = nonEmptyString(input.meta?.fileName) ??
        (location.filePath ? basename(location.filePath) : 'attachment');
    return {
        type: queueAttachmentType(input, mimeType, drive),
        fileName,
        mimeType,
        ...location,
        ...drive,
    };
}
function queueAttachmentType(input, mimeType, drive) {
    if (drive && input.meta?.attachmentType === 'folder')
        return 'folder';
    return input.meta?.attachmentType === 'image' || mimeType.startsWith('image/') ? 'image' : 'file';
}
/** A Drive asset reference is kept even when it has no local source. */
function toQueueDriveAsset(input) {
    const driveNodeId = nonEmptyString(input.local?.driveNodeId);
    if (!driveNodeId)
        return undefined;
    const drivePath = nonEmptyString(input.local?.drivePath);
    const sizeBytes = input.meta?.sizeBytes;
    return {
        driveNodeId,
        ...(drivePath ? { drivePath } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
}
function toQueueAttachmentLocation(input) {
    const filePath = nonEmptyString(input.local?.filePath);
    const candidateDataUrl = nonEmptyString(input.local?.dataUrl);
    const dataUrl = isInlineDisplayDataUrl(candidateDataUrl) ? undefined : candidateDataUrl;
    const assetId = nonEmptyString(input.local?.assetId);
    if (!filePath && !dataUrl)
        return undefined;
    return {
        filePath: filePath ?? '',
        ...(dataUrl ? { dataUrl } : {}),
        ...(assetId ? { assetId } : {}),
    };
}
function toAttachmentView(attachment) {
    return {
        meta: {
            attachmentType: attachment.type,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            ...(attachment.driveNodeId && attachment.sizeBytes !== undefined
                ? { sizeBytes: attachment.sizeBytes }
                : {}),
        },
        local: {
            filePath: attachment.filePath,
            ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
            ...(attachment.dataUrl && !isInlineDisplayDataUrl(attachment.dataUrl)
                ? { dataUrl: attachment.dataUrl }
                : {}),
            ...(attachment.driveNodeId ? { driveNodeId: attachment.driveNodeId } : {}),
            ...(attachment.drivePath ? { drivePath: attachment.drivePath } : {}),
        },
    };
}
function toModelInfoView(model) {
    return {
        ...(model.provider_id ? { providerId: model.provider_id } : {}),
        ...(model.model_id ? { modelId: model.model_id } : {}),
        ...(model.variant !== undefined ? { variant: model.variant } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.context_limit !== undefined ? { contextLimit: model.context_limit } : {}),
        ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
    };
}
function nonEmptyString(value) {
    return value && value.length > 0 ? value : undefined;
}
//# sourceMappingURL=wire.js.map