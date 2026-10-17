import { isChannelQueueSource } from './queue.js';
import { isThreadGoalKickoffQueueItem, readThreadGoalKickoffDisplayContent, } from '../thread-goal/kickoff.js';
export function serializeQueuedMessage(item) {
    const kickoffDisplayContent = readThreadGoalKickoffDisplayContent(item.message.origin);
    const reviewRequest = item.message.source === 'code_review' ? { scope: 'local_changes' } : undefined;
    return {
        itemId: item.itemId,
        item_id: item.itemId,
        sessionId: item.sessionId,
        session_id: item.sessionId,
        agentName: item.agentName,
        agent_name: item.agentName,
        source: item.source,
        status: item.status,
        content: kickoffDisplayContent ?? item.message.content,
        attachments: item.message.attachments.map(serializeQueuedAttachment),
        ...(item.model ? { model: item.model } : {}),
        createdAt: item.createdAt,
        created_at: item.createdAt,
        ...(item.clientRequestId
            ? { clientRequestId: item.clientRequestId, client_request_id: item.clientRequestId }
            : {}),
        ...(item.expiresAt !== undefined
            ? { expiresAt: item.expiresAt, expires_at: item.expiresAt }
            : {}),
        ...(item.startedAt ? { startedAt: item.startedAt, started_at: item.startedAt } : {}),
        ...(item.finishedAt ? { finishedAt: item.finishedAt, finished_at: item.finishedAt } : {}),
        ...(item.failedReason
            ? { failedReason: item.failedReason, failed_reason: item.failedReason }
            : {}),
        ...(reviewRequest ? { reviewRequest, review_request: reviewRequest } : {}),
    };
}
export function serializeInjectableQueuedMessage(item) {
    const serialized = serializeQueuedMessage(item);
    return {
        itemId: item.itemId,
        source: item.source,
        origin: undefined,
        content: item.message.content,
        attachments: serialized.attachments,
        createdAt: item.createdAt,
        enqueuedAtMs: item.createdAt,
        turnId: item.turnId,
    };
}
export function buildQueuedDrainRequestBody(items, turnId) {
    const [first, ...rest] = items;
    if (!first)
        return { content: '', queuedMessages: [], turnId };
    return {
        ...serializeQueuedDrainMessage(first),
        queuedMessages: rest.map(serializeQueuedDrainMessage),
        turnId,
    };
}
export function completeQueuedMessagesForDrain(queue, completedIds, now) {
    const ids = new Set(completedIds);
    for (const item of queue) {
        if (!ids.has(item.itemId))
            continue;
        item.status = 'completed';
        item.startedAt = item.startedAt ?? now;
        item.finishedAt = now;
    }
    return queue.filter((item) => !ids.has(item.itemId));
}
export function startQueuedMessagesForDrain(queue, itemIds, now) {
    const ids = new Set(itemIds);
    for (const item of queue) {
        if (!ids.has(item.itemId) || item.status !== 'queued')
            continue;
        item.status = 'running';
        item.startedAt = item.startedAt ?? now;
        item.failedReason = undefined;
    }
    return queue;
}
export function failQueuedMessagesForDrain(queue, itemIds, now, reason) {
    const ids = new Set(itemIds);
    for (const item of queue) {
        if (!ids.has(item.itemId) || item.status === 'completed' || item.status === 'cancelled')
            continue;
        item.status = 'failed';
        item.startedAt = item.startedAt ?? now;
        item.finishedAt = now;
        item.failedReason = reason;
    }
    return queue;
}
export function drainQueuedMessagesForInjection(queue, now) {
    const drained = [];
    const remaining = [];
    for (const item of queue) {
        // Cron and channel items must remain whole-turn queued work. They should
        // never be injected mid-turn as user follow-up text:
        //   - cron: a cron prompt can still interrupt the active agent loop
        //   - channel: the reply must route back to the originating IM chat via
        //     the channel idle-drain (drainQueuedChannelMessages), not land in
        //     the SSE stream where the desktop UI consumes it.
        if (item.status === 'queued' &&
            item.source !== 'cron' &&
            !isChannelQueueSource(item.source) &&
            !isThreadGoalKickoffQueueItem(item) &&
            item.message.content.trim().length > 0 &&
            item.message.attachments.length === 0) {
            item.status = 'injected';
            item.startedAt = item.startedAt ?? now;
            item.finishedAt = now;
            drained.push(item);
        }
        else {
            remaining.push(item);
        }
    }
    return { drained, remaining };
}
function serializeQueuedAttachment(attachment) {
    return {
        type: attachment.type,
        filePath: attachment.filePath,
        file_path: attachment.filePath,
        fileName: attachment.fileName,
        file_name: attachment.fileName,
        mimeType: attachment.mimeType,
        mime_type: attachment.mimeType,
        ...(attachment.desktopPath
            ? { desktopPath: attachment.desktopPath, desktop_path: attachment.desktopPath }
            : {}),
        ...(attachment.assetId ? { assetId: attachment.assetId, asset_id: attachment.assetId } : {}),
        ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl, data_url: attachment.dataUrl } : {}),
    };
}
function serializeQueuedDrainMessage(item) {
    const source = item.message.source ?? item.source;
    const reviewRequest = item.message.source === 'code_review' ? { scope: 'local_changes' } : undefined;
    return {
        content: item.message.content,
        attachments: item.message.attachments,
        queueItemId: item.itemId,
        ...(source ? { source } : {}),
        ...(item.message.origin !== undefined ? { origin: item.message.origin } : {}),
        ...(item.model ? { model: item.model } : {}),
        // Persist a queue-level copy of channelContext so the channel idle-drain
        // can locate the IM binding on the drain frame even if the underlying
        // message attachment objects are dropped during message normalization.
        // Stays consistent with `message.channelContext` (enqueue keeps both in
        // sync, see LocalMessageQueueStore.enqueue).
        ...(item.channelContext ? { channelContext: item.channelContext } : {}),
        ...(reviewRequest ? { reviewRequest, review_request: reviewRequest } : {}),
    };
}
//# sourceMappingURL=queue-serialization.js.map