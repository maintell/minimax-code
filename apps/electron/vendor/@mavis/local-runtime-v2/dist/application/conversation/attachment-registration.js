import { basename } from 'node:path';
import { isInlineDisplayDataUrl, } from '../../service/session-system/index.js';
export class AttachmentRegistrationError extends Error {
    reason;
    name = 'AttachmentRegistrationError';
    constructor(reason) {
        super(reason === 'too-large'
            ? 'Local attachment is too large to persist'
            : 'Local attachment source is unreadable or invalid');
        this.reason = reason;
    }
}
export async function materializeLocalAttachmentInputs(registration, input) {
    const sources = (input.attachments ?? []).flatMap((attachment, index) => {
        const source = toRegistrationSource(attachment, index);
        return source ? [source] : [];
    });
    if (sources.length === 0)
        return emptyMaterializedAttachments();
    let registered;
    try {
        registered = await registration.register({
            sessionId: input.sessionId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            attachments: sources.map(({ attachment }) => attachment),
        });
    }
    catch (error) {
        const reason = registrationFailureReason(error);
        if (reason)
            throw new AttachmentRegistrationError(reason);
        throw error;
    }
    if (registered.length !== sources.length) {
        throw new TypeError('Attachment registration returned an invalid result count.');
    }
    const materialized = registered.map((attachment, index) => validateRegisteredAttachment(attachment, index));
    return {
        executionAttachments: materialized.map(toExecutionAttachment),
        displayAttachments: materialized.map((attachment, index) => toDisplayAttachment(attachment, sources[index]?.sizeBytes)),
        wireAttachments: materialized.map((attachment, index) => toWireAttachment(attachment, sources[index]?.sizeBytes)),
        discardCreated: createDiscardCreated(registration, input.sessionId, registered),
    };
}
export function attachmentRegistrationResponse(error) {
    return error.reason === 'too-large'
        ? { status: 413, key: 'local_attachment_too_large', message: error.message }
        : { status: 415, key: 'local_attachment_unreadable', message: error.message };
}
function toRegistrationSource(input, index) {
    const local = localAttachmentSource(input);
    if (!local)
        return undefined;
    const metadata = registrationMetadata(input, index, local.filePath);
    const attachment = {
        ...local,
        ...metadata,
        filePath: local.filePath ?? '',
    };
    return registrationSourceWithSize(attachment, input.meta?.sizeBytes);
}
function registrationMetadata(input, index, filePath) {
    const meta = input.meta ?? {};
    const mimeType = nonEmpty(meta.mimeType) ?? 'application/octet-stream';
    const fileName = nonEmpty(meta.fileName) ?? (filePath ? basename(filePath) : `attachment-${String(index)}`);
    return {
        type: meta.attachmentType === 'image' || mimeType.startsWith('image/') ? 'image' : 'file',
        fileName,
        mimeType,
    };
}
function registrationSourceWithSize(attachment, sizeBytes) {
    return { attachment, ...(sizeBytes !== undefined ? { sizeBytes } : {}) };
}
function localAttachmentSource(input) {
    const source = input.local;
    if (!source)
        return undefined;
    const filePath = nonEmpty(source.filePath);
    const dataUrl = nonEmpty(source.dataUrl);
    if (!filePath && !dataUrl)
        return undefined;
    const desktopPath = nonEmpty(source.desktopPath);
    const assetId = nonEmpty(source.assetId);
    return {
        ...(filePath ? { filePath } : {}),
        ...(dataUrl ? { dataUrl } : {}),
        ...(desktopPath ? { desktopPath } : {}),
        ...(assetId ? { assetId } : {}),
    };
}
function validateRegisteredAttachment(input, index) {
    const registered = withoutRedundantInlinePreview(input);
    const filePath = nonEmpty(registered.filePath);
    const dataUrl = nonEmpty(registered.dataUrl);
    if ((registered.type !== 'file' && registered.type !== 'image') ||
        (!filePath && !dataUrl) ||
        !nonEmpty(registered.fileName) ||
        !nonEmpty(registered.mimeType)) {
        throw new TypeError(`Attachment registration returned an invalid result at index ${String(index)}.`);
    }
    return registered;
}
function withoutRedundantInlinePreview(input) {
    if (!isInlineDisplayDataUrl(input.dataUrl))
        return input;
    return { ...input, dataUrl: undefined };
}
function toExecutionAttachment(input) {
    return {
        type: input.type,
        ...(nonEmpty(input.filePath) ? { filePath: input.filePath } : {}),
        fileName: input.fileName,
        mimeType: input.mimeType,
        ...(nonEmpty(input.desktopPath) ? { desktopPath: input.desktopPath } : {}),
        ...(nonEmpty(input.dataUrl) ? { dataUrl: input.dataUrl } : {}),
        ...(nonEmpty(input.assetId) ? { assetId: input.assetId } : {}),
    };
}
function toDisplayAttachment(input, sizeBytes) {
    return {
        meta: {
            attachmentType: input.type,
            fileName: input.fileName,
            mimeType: input.mimeType,
            ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        },
        local: {
            ...(nonEmpty(input.assetId) ? { assetId: input.assetId } : {}),
            ...(nonEmpty(input.filePath) ? { filePath: input.filePath } : {}),
            ...(nonEmpty(input.desktopPath) ? { desktopPath: input.desktopPath } : {}),
            ...(nonEmpty(input.dataUrl) ? { dataUrl: input.dataUrl } : {}),
        },
    };
}
function toWireAttachment(input, sizeBytes) {
    const display = toDisplayAttachment(input, sizeBytes);
    return { meta: display.meta, local: display.local };
}
function emptyMaterializedAttachments() {
    return {
        executionAttachments: [],
        displayAttachments: [],
        wireAttachments: [],
        discardCreated: async () => undefined,
    };
}
function createDiscardCreated(registration, sessionId, registered) {
    const receipts = registered.flatMap((attachment) => attachment.registrationReceipt ? [attachment.registrationReceipt] : []);
    return async () => {
        if (!registration.discard || receipts.length === 0)
            return;
        try {
            await registration.discard({ sessionId, receipts });
        }
        catch {
            // Admission failure remains authoritative when best-effort asset cleanup fails.
        }
    };
}
/** Classifies a registration failure caused by the source itself, not by the asset store. */
export function registrationFailureReason(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const message = Reflect.get(error, 'message');
    const code = Reflect.get(error, 'code');
    if (message === 'asset_too_large')
        return 'too-large';
    if (typeof message === 'string' &&
        [
            'invalid_asset_data_url',
            'asset_source_required',
            'asset_source_not_file',
            'asset_remote_url_invalid',
            'asset_remote_unreadable',
        ].includes(message)) {
        return 'unreadable';
    }
    return typeof code === 'string' &&
        ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR'].includes(code)
        ? 'unreadable'
        : undefined;
}
function nonEmpty(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
//# sourceMappingURL=attachment-registration.js.map