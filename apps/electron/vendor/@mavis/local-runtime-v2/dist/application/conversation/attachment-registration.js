import { basename, posix } from 'node:path';
import { isLegacyAssetNodeId } from '@mavis/shared/drive-assets';
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
        const source = toAttachmentSource(attachment, index);
        return source ? [source] : [];
    });
    if (sources.length === 0)
        return emptyMaterializedAttachments();
    // A native Drive asset is reference-only: the agent downloads it with the
    // space skill when it needs the contents. Everything else, legacy `cs_`
    // items included, keeps the single all-or-nothing batch registration.
    const plainSources = sources.filter((source) => source.registration !== undefined);
    const registered = plainSources.length > 0
        ? await registerPlainAttachments(registration, input, plainSources)
        : [];
    let plainIndex = 0;
    const materialized = sources.map((source) => withSize({
        ...(source.registration ? { registered: registered[plainIndex++] } : {}),
        ...(source.drive ? { drive: source.drive } : {}),
    }, source.sizeBytes));
    return {
        executionAttachments: materialized.map(toExecutionAttachment),
        displayAttachments: materialized.map(toDisplayAttachment),
        wireAttachments: materialized.map(toWireAttachment),
        discardCreated: createDiscardCreated(registration, input.sessionId, registered),
    };
}
async function registerPlainAttachments(registration, input, sources) {
    let registered;
    try {
        registered = await registration.register({
            sessionId: input.sessionId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            attachments: sources.map((source) => source.registration),
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
    return registered.map((attachment, index) => validateRegisteredAttachment(attachment, index));
}
export function attachmentRegistrationResponse(error) {
    return error.reason === 'too-large'
        ? { status: 413, key: 'local_attachment_too_large', message: error.message }
        : { status: 415, key: 'local_attachment_unreadable', message: error.message };
}
function toAttachmentSource(input, index) {
    const drive = driveAssetAttachment(input, index);
    // Any local source a caller still sends for a native asset is ignored.
    if (drive && !isLegacyAssetNodeId(drive.driveNodeId)) {
        return withSize({ drive }, drive.type === 'folder' ? undefined : input.meta?.sizeBytes);
    }
    const registration = toRegistrationSource(input, index);
    if (!registration)
        return undefined;
    return withSize({ registration: registration.attachment, ...(drive ? { drive } : {}) }, registration.sizeBytes);
}
function driveAssetAttachment(input, index) {
    const driveNodeId = nonEmpty(input.local?.driveNodeId);
    if (!driveNodeId)
        return undefined;
    const drivePath = nonEmpty(input.local?.drivePath);
    const meta = input.meta ?? {};
    const mimeType = nonEmpty(meta.mimeType);
    const type = driveAssetType(meta.attachmentType, mimeType);
    return {
        type,
        fileName: driveAssetFileName(meta.fileName, drivePath, index),
        ...(mimeType && type !== 'folder' ? { mimeType } : {}),
        driveNodeId,
        ...(drivePath ? { drivePath } : {}),
    };
}
function driveAssetType(attachmentType, mimeType) {
    if (attachmentType === 'folder')
        return 'folder';
    return attachmentType === 'image' || mimeType?.startsWith('image/') ? 'image' : 'file';
}
function driveAssetFileName(fileName, drivePath, index) {
    return (nonEmpty(fileName) ??
        nonEmpty(drivePath ? posix.basename(drivePath) : undefined) ??
        `attachment-${String(index)}`);
}
function withSize(value, sizeBytes) {
    return sizeBytes !== undefined ? { ...value, sizeBytes } : value;
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
    // A legacy `cs_` item runs as its registered copy, without asset facts.
    if (input.registered)
        return toRegisteredExecutionAttachment(input.registered);
    const drive = input.drive;
    return {
        type: drive.type,
        fileName: drive.fileName,
        ...(drive.mimeType ? { mimeType: drive.mimeType } : {}),
        driveNodeId: drive.driveNodeId,
        ...(drive.drivePath ? { drivePath: drive.drivePath } : {}),
        ...(input.sizeBytes !== undefined ? { sizeBytes: input.sizeBytes } : {}),
    };
}
function toRegisteredExecutionAttachment(input) {
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
function toDisplayAttachment(input) {
    const { registered, drive, sizeBytes } = input;
    // A registered copy (validated non-empty mimeType) wins over the Drive reference.
    const identity = registered ?? drive;
    return {
        meta: {
            attachmentType: identity.type,
            fileName: identity.fileName,
            ...(identity.mimeType ? { mimeType: identity.mimeType } : {}),
            ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        },
        local: { ...registeredLocalRef(registered), ...driveLocalRef(drive) },
    };
}
function registeredLocalRef(registered) {
    if (!registered)
        return {};
    return {
        ...(nonEmpty(registered.assetId) ? { assetId: registered.assetId } : {}),
        ...(nonEmpty(registered.filePath) ? { filePath: registered.filePath } : {}),
        ...(nonEmpty(registered.desktopPath) ? { desktopPath: registered.desktopPath } : {}),
        ...(nonEmpty(registered.dataUrl) ? { dataUrl: registered.dataUrl } : {}),
    };
}
function driveLocalRef(drive) {
    if (!drive)
        return {};
    return {
        driveNodeId: drive.driveNodeId,
        ...(drive.drivePath ? { drivePath: drive.drivePath } : {}),
    };
}
function toWireAttachment(input) {
    const display = toDisplayAttachment(input);
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
function registrationFailureReason(error) {
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