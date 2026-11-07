import { isThreadGoalKickoffQueueItem } from '@mavis/goal';
import { isChannelQueueSource } from '../../../../infra/conversation/queue-source.js';
import {} from '../../../../infra/conversation/queue-contracts.js';
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
//# sourceMappingURL=queue-serialization.js.map