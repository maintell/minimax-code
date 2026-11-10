import { queueRoutingFingerprint } from '../routing.js';
import { isQueueMessageInput, isQueueMessageSource, isQueueImmediateSendBatch } from './codec.js';
export function validEnqueue(input) {
    return (input.session.sessionId.length > 0 &&
        input.session.agentName.length > 0 &&
        isQueueMessageSource(input.source ?? 'api') &&
        (input.queuePlacement === undefined || input.queuePlacement === 'front') &&
        isQueueMessageInput(input.message) &&
        !emptyMessage(input.message) &&
        validEnqueueMetadata(input));
}
export function validUpdate(input) {
    return (input.sessionId.length > 0 &&
        input.itemId.length > 0 &&
        (input.message !== undefined || input.model !== undefined || input.expiresAt !== undefined) &&
        (input.message === undefined ||
            (isQueueMessageInput(input.message) && !emptyMessage(input.message))) &&
        (input.expiresAt === undefined || Number.isFinite(input.expiresAt)));
}
export function makeQueued(input, itemId, nowMs) {
    const source = input.source ?? 'api';
    return {
        itemId,
        ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        sessionId: input.session.sessionId,
        agentName: input.session.agentName,
        source,
        status: 'queued',
        message: input.message,
        ...(input.message.channelContext ? { channelContext: input.message.channelContext } : {}),
        ...(input.model ? { model: input.model } : {}),
        createdAt: input.createdAt ?? nowMs,
        immediateSendBatch: input.immediateSendBatch,
        ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
        ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    };
}
export function completePermutation(items, ids) {
    return (ids.length > 0 &&
        items.length === ids.length &&
        new Set(ids).size === ids.length &&
        ids.every((id) => items.some((item) => item.itemId === id)));
}
export function routingFingerprint(item) {
    return queueRoutingFingerprint(item);
}
function emptyMessage(message) {
    return message.content.length === 0 && message.attachments.length === 0;
}
function validEnqueueMetadata(input) {
    return ((input.immediateSendBatch === undefined ||
        isQueueImmediateSendBatch(input.immediateSendBatch)) &&
        (input.createdAt === undefined || Number.isFinite(input.createdAt)) &&
        (input.expiresAt === undefined || Number.isFinite(input.expiresAt)));
}
function activeClaim(item, liveness) {
    if (liveness.scope?.claimedAtOrBeforeMs !== undefined &&
        item.claimedAt !== undefined &&
        item.claimedAt <= liveness.scope.claimedAtOrBeforeMs) {
        return false;
    }
    return (Boolean(item.claimOwnerId) &&
        item.claimedAt !== undefined &&
        (item.claimLeaseExpiresAt ?? item.claimedAt + liveness.claimLeaseMs) > liveness.nowMs &&
        liveness.isOwnerAlive(item.claimOwnerId));
}
export function transferExpired(item, nowMs) {
    return item.expiresAt !== undefined && item.expiresAt <= nowMs;
}
export function groupRecoverable(items, liveness) {
    const grouped = new Map();
    items.forEach((item) => {
        if (item.status !== 'claimed' || !item.claimId)
            return;
        grouped.set(item.claimId, [...(grouped.get(item.claimId) ?? []), item]);
    });
    return new Map([...grouped].filter(([, claimed]) => !claimed.some((item) => activeClaim(item, liveness))));
}
export function replaceItemMessage(item, message) {
    const { channelContext, ...withoutContext } = item;
    void channelContext;
    const replacement = {
        ...message,
        ...(item.message.clientIntent !== undefined ? { clientIntent: item.message.clientIntent } : {}),
    };
    return {
        ...withoutContext,
        message: replacement,
        ...(replacement.channelContext ? { channelContext: replacement.channelContext } : {}),
    };
}
//# sourceMappingURL=policy.js.map