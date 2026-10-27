import { createHash } from 'node:crypto';
import { sanitizeDisplayAttachment } from '../session-system/index.js';
import { parseBackgroundTaskOriginMetadata, } from '../turn-system/index.js';
/**
 * Maps the neutral v1 consumer contract into TurnSystem message delivery.
 */
export function createV1CompatibleTurnSubmission(options) {
    return {
        submit: async (input) => {
            const materialized = await options.attachmentMaterializer.materialize({
                sessionId: input.sessionId,
                ...(input.requestedTurnId ? { turnId: input.requestedTurnId } : {}),
                message: input.message,
            });
            const message = materialized.message;
            return retainAcceptedRegistration(() => options.turns.submit({
                sessionId: input.sessionId,
                input: toAgentInput(message, false),
                provenance: turnProvenance(input),
                allowQueue: input.allowQueue,
                ...(input.queuePlacement ? { queuePlacement: input.queuePlacement } : {}),
                ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
                ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
                ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
                ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
                delivery: toDeliveryOptions(message),
            }), (result) => result.accepted, materialized.discardCreated);
        },
        resumeUserInput: async (input) => {
            const materialized = await options.attachmentMaterializer.materialize({
                sessionId: input.sessionId,
                message: input.message,
            });
            const message = materialized.message;
            return retainAcceptedRegistration(() => options.turns.resumeUserInput({
                sessionId: input.sessionId,
                input: toAgentInput(message, false),
                provenance: { ...turnProvenance(input), source: 'questionnaire' },
                resume: {
                    kind: 'questionnaire',
                    requestId: input.requestId,
                    ...(input.owner ? { owner: input.owner } : {}),
                },
                ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
                delivery: toDeliveryOptions(message),
            }), (result) => result.accepted, materialized.discardCreated);
        },
        steer: async (input) => {
            const materialized = await options.attachmentMaterializer.materialize({
                sessionId: input.sessionId,
                ...(input.requestedTurnId ? { turnId: input.requestedTurnId } : {}),
                message: input.message,
            });
            const message = materialized.message;
            return retainAcceptedRegistration(() => options.turns.steer({
                sessionId: input.sessionId,
                input: toAgentInput(message, isTrustedBackgroundDelivery(input)),
                provenance: turnProvenance(input),
                producerId: input.producerId,
                idempotencyKey: input.idempotencyKey,
                ...(input.activationDisplayContent !== undefined
                    ? { activationDisplayContent: input.activationDisplayContent }
                    : {}),
                ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
                preDelivery: input.preDelivery,
                ...(input.receiptAliases?.length ? { receiptAliases: input.receiptAliases } : {}),
                delivery: toDeliveryOptions(message),
            }), (result) => result.delivered, materialized.discardCreated);
        },
    };
}
async function retainAcceptedRegistration(operation, accepted, discardCreated) {
    try {
        const result = await operation();
        if (!accepted(result))
            await discardCreated();
        return result;
    }
    catch (error) {
        await discardCreated();
        throw error;
    }
}
function toDeliveryOptions(message) {
    return {
        ...(message.hideUserMessage ? { hideUserMessage: true } : {}),
        ...(message.displayContent !== undefined ? { displayContent: message.displayContent } : {}),
        ...(message.attachments
            ? {
                displayAttachments: message.attachments.map(toDisplayAttachment),
            }
            : {}),
    };
}
function toDisplayAttachment(attachment) {
    return sanitizeDisplayAttachment(Object.fromEntries(Object.entries(attachment)));
}
function turnProvenance(input) {
    const review = input.source === 'code_review' ? reviewOrigin(input.message.origin) : undefined;
    const sourceContext = {
        ...(input.message.origin !== undefined ? { origin: input.message.origin } : {}),
        ...(review ? { review } : {}),
        ...(input.message.channelContext ? { channelContext: input.message.channelContext } : {}),
    };
    return {
        source: input.source,
        routingFingerprint: digest({
            sessionId: input.sessionId,
            source: input.source,
            ...routingIdentity(input),
            ...('requestedTurnId' in input ? { requestedTurnId: input.requestedTurnId } : {}),
            message: input.message,
        }),
        ...(Object.keys(sourceContext).length > 0 ? { sourceContext } : {}),
    };
}
function routingIdentity(input) {
    if ('requestId' in input)
        return { requestId: input.requestId };
    if ('producerId' in input) {
        return { producerId: input.producerId, idempotencyKey: input.idempotencyKey };
    }
    return input.clientRequestId ? { clientRequestId: input.clientRequestId } : {};
}
function reviewOrigin(value) {
    if (!isRecord(value))
        return undefined;
    const review = Reflect.get(value, 'review');
    if (!isRecord(review))
        return undefined;
    const trigger = Reflect.get(review, 'trigger');
    const scope = Reflect.get(review, 'scope');
    if (scope !== 'local_changes' || !isReviewTrigger(trigger))
        return undefined;
    return { trigger, scope };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isReviewTrigger(value) {
    return value === 'slash' || value === 'natural_language' || value === 'subagent';
}
function toAgentInput(message, trustBackgroundOrigin) {
    const origin = trustBackgroundOrigin
        ? parseBackgroundTaskOriginMetadata(message.origin)
        : undefined;
    return {
        text: message.content,
        ...(message.attachments ? { attachments: message.attachments.map(toAgentAttachment) } : {}),
        ...(message.model ? { model: { ...message.model } } : {}),
        ...(origin ? { origin } : {}),
        ...(message.channelContext ? { channelContext: { ...message.channelContext } } : {}),
        ...(message.quotedMessage ? { quotedMessage: { ...message.quotedMessage } } : {}),
    };
}
function toAgentAttachment(attachment) {
    // 展示元数据留在 displayAttachments，执行输入只投影 AgentHost 契约字段。
    const { type, filePath, fileName, mimeType, desktopPath, dataUrl, assetId, error } = attachment;
    return { type, filePath, fileName, mimeType, desktopPath, dataUrl, assetId, error };
}
function isTrustedBackgroundDelivery(input) {
    return input.source === 'background-task' && input.producerId === 'background-task-delivery';
}
function digest(value) {
    return `sha256:${createHash('sha256')
        .update(JSON.stringify(canonicalValue(value)))
        .digest('hex')}`;
}
function canonicalValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalValue);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]));
}
//# sourceMappingURL=v1-compatible-turn-submission.service.js.map