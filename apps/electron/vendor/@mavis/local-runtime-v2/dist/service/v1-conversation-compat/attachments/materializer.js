import { needsAttachmentRegistration, requireRegisteredAttachment, withoutInlineDataUrl, } from './normalization.js';
export function createV1ConversationAttachmentMaterializer(options) {
    return {
        materialize: (input) => materializeMessage(options.registration, input),
    };
}
async function materializeMessage(registration, input) {
    const attachments = input.message.attachments;
    if (!attachments || attachments.length === 0) {
        return { message: input.message, discardCreated: async () => undefined };
    }
    const pending = attachments.flatMap((attachment, index) => needsAttachmentRegistration(attachment) ? [{ attachment, index }] : []);
    const registered = pending.length === 0
        ? []
        : await registration.register({
            sessionId: input.sessionId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            attachments: pending.map(({ attachment }) => attachment),
        });
    if (registered.length !== pending.length) {
        throw new TypeError('Attachment registration returned an invalid result count.');
    }
    const registeredByIndex = new Map(pending.map(({ index }, resultIndex) => [
        index,
        requireRegisteredAttachment(registered[resultIndex], resultIndex),
    ]));
    return {
        message: {
            ...input.message,
            attachments: attachments.map((attachment, index) => withoutInlineDataUrl({ ...attachment, ...registeredByIndex.get(index) })),
        },
        discardCreated: createDiscardCreated(registration, input.sessionId, registered),
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
            // The original Turn or Queue rejection remains authoritative.
        }
    };
}
//# sourceMappingURL=materializer.js.map