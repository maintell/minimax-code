import { readLocalMessageInputs, } from './input.js';
import { completeQueuedMessagesForDrain, drainQueuedMessagesForInjection, failQueuedMessagesForDrain, startQueuedMessagesForDrain, } from './queue-serialization.js';
import { normalizeQueueSourceLabel } from './queue-source.js';
import { readLocalModelOverride, } from '../model-provider/model-selection.js';
export { buildQueuedDrainRequestBody, serializeInjectableQueuedMessage, serializeQueuedMessage, } from './queue-serialization.js';
export { isChannelQueueSource, mapMessageSourceToTurnCaller } from './queue-source.js';
export class LocalMessageQueueStore {
    options;
    queues = new Map();
    sessionLocks = new Map();
    hydratedSessions = new Set();
    constructor(options) {
        this.options = options;
    }
    countQueueOp(op, source) {
        this.options.metricsClient?.counter('message_queue_op_total', 1, {
            op,
            source: normalizeQueueSourceLabel(source),
        });
    }
    async list(sessionId) {
        return (await this.loadQueue(sessionId)).filter(isQueuedListItem);
    }
    async find(sessionId, itemId) {
        return (await this.loadQueue(sessionId)).find((item) => item.itemId === itemId && isActiveQueuedMessage(item));
    }
    async enqueue(session, body, options) {
        this.assertWritable('enqueue');
        return this.withSessionLock(session.sessionId, async () => {
            const [message] = readLocalMessageInputs(body);
            if (!message || isEmptyQueuedMessage(message))
                return undefined;
            const model = readModelOverride(body);
            const clientRequestId = options?.clientRequestId ??
                readOptionalString(body, ['clientRequestId', 'client_request_id']);
            const expiresAt = options?.expiresAt ?? readOptionalNumber(body, ['expiresAt', 'expires_at']);
            const queue = await this.loadQueue(session.sessionId);
            if (clientRequestId) {
                const existing = queue.find((candidate) => candidate.clientRequestId === clientRequestId && isActiveQueuedMessage(candidate));
                if (existing)
                    return existing;
            }
            const item = {
                itemId: this.options.makeId('queue'),
                sessionId: session.sessionId,
                agentName: session.agentName,
                source: options?.source ?? 'api',
                status: 'queued',
                message,
                // Persist channelContext at the queue-item level so the channel
                // drain can locate the IM binding across runtime restarts (the
                // underlying message.channelContext is also kept for downstream
                // prompt assembly, but the queue store needs the copy too).
                ...(message.channelContext ? { channelContext: message.channelContext } : {}),
                ...(model ? { model } : {}),
                turnId: this.options.makeId('turn_queue_item'),
                createdAt: this.options.nowMs(),
                ...(clientRequestId ? { clientRequestId } : {}),
                ...(options?.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
                ...(expiresAt !== undefined ? { expiresAt } : {}),
            };
            // Latest-wins per dedupeKey: cancel the still-queued previous item and
            // take its slot (mirrors daemon SessionInboundQueue.insertItem).
            const replaced = item.dedupeKey
                ? queue.find((candidate) => candidate.status === 'queued' && candidate.dedupeKey === item.dedupeKey)
                : undefined;
            if (replaced) {
                replaced.status = 'cancelled';
                replaced.finishedAt = this.options.nowMs();
                queue[queue.indexOf(replaced)] = item;
            }
            else {
                queue.push(item);
            }
            await this.replaceQueue(session.sessionId, queue);
            this.countQueueOp('enqueue', item.source);
            if (replaced)
                this.emitUpdated(replaced);
            this.emitUpdated(item);
            return item;
        });
    }
    async claimSource(sessionId, itemId, source) {
        this.assertWritable('claim-source');
        return this.withSessionLock(sessionId, async () => {
            const item = await this.find(sessionId, itemId);
            if (!item)
                return undefined;
            if (item.status !== 'queued')
                return 'not_editable';
            item.source = source;
            await this.replaceQueue(sessionId, this.queues.get(sessionId) ?? []);
            this.emitUpdated(item);
            return item;
        });
    }
    async update(sessionId, itemId, body) {
        this.assertWritable('update');
        return this.withSessionLock(sessionId, async () => {
            const item = await this.find(sessionId, itemId);
            if (!item)
                return undefined;
            if (item.status !== 'queued')
                return 'not_editable';
            const hasMessageUpdate = hasAnyOwn(body, ['content', 'attachments']);
            const hasModelUpdate = hasAnyOwn(body, ['model']);
            const expiresAt = readOptionalNumber(body, ['expiresAt', 'expires_at']);
            if (hasMessageUpdate) {
                const [message] = readLocalMessageInputs(body);
                if (!message || isEmptyQueuedMessage(message))
                    return 'invalid';
                item.message = message;
            }
            if (hasModelUpdate)
                item.model = readModelOverride(body);
            if (expiresAt !== undefined)
                item.expiresAt = expiresAt;
            await this.replaceQueue(sessionId, this.queues.get(sessionId) ?? []);
            this.countQueueOp('edit', item.source);
            this.emitUpdated(item);
            return item;
        });
    }
    async cancel(sessionId, itemId) {
        this.assertWritable('cancel');
        return this.withSessionLock(sessionId, async () => {
            const item = await this.find(sessionId, itemId);
            if (!item)
                return undefined;
            if (item.status !== 'queued')
                return 'not_editable';
            item.status = 'cancelled';
            item.finishedAt = this.options.nowMs();
            await this.replaceQueue(sessionId, this.queues.get(sessionId) ?? []);
            this.countQueueOp('delete', item.source);
            this.emitUpdated(item);
            return item;
        });
    }
    async reorder(sessionId, body) {
        this.assertWritable('reorder');
        return this.withSessionLock(sessionId, async () => {
            const requestedIds = readQueueItemIds(body);
            const current = await this.loadQueue(sessionId);
            const queue = current.filter(isQueuedListItem);
            const requestedSet = new Set(requestedIds);
            if (requestedIds.length === 0 ||
                requestedSet.size !== requestedIds.length ||
                requestedSet.size !== queue.length ||
                queue.some((item) => !requestedSet.has(item.itemId))) {
                return 'invalid';
            }
            const byId = new Map(queue.map((item) => [item.itemId, item]));
            const next = requestedIds.map((id) => byId.get(id));
            await this.replaceQueue(sessionId, [
                ...next,
                ...current.filter((item) => !isQueuedListItem(item)),
            ]);
            this.emitUpdated(undefined, sessionId);
            return next;
        });
    }
    async startDrain(sessionId, itemIds) {
        this.assertWritable('start-drain');
        await this.withSessionLock(sessionId, async () => {
            const queue = await this.loadQueue(sessionId);
            const changed = queue.filter((item) => itemIds.includes(item.itemId));
            // Only queued→running transitions are a dequeue; repeat drains of an
            // already-running item must not double count.
            const dequeued = changed.filter((item) => item.status === 'queued');
            await this.replaceQueue(sessionId, startQueuedMessagesForDrain(queue, itemIds, this.options.nowMs()));
            for (const item of dequeued)
                this.countQueueOp('dequeue', item.source);
            this.emitUpdates(changed);
        });
    }
    async finishDrain(sessionId, itemIds, status) {
        this.assertWritable('finish-drain');
        await this.withSessionLock(sessionId, async () => {
            const queue = await this.loadQueue(sessionId);
            const changed = queue.filter((item) => itemIds.includes(item.itemId));
            await this.replaceQueue(sessionId, status === 'finished'
                ? completeQueuedMessagesForDrain(queue, itemIds, this.options.nowMs())
                : failQueuedMessagesForDrain(queue, itemIds, this.options.nowMs(), status === 'aborted' ? 'Turn aborted' : 'Turn failed'));
            this.emitUpdates(changed);
        });
    }
    async drainInjectable(sessionId) {
        this.assertWritable('drain-injectable');
        return this.withSessionLock(sessionId, async () => {
            const { drained, remaining } = drainQueuedMessagesForInjection(await this.loadQueue(sessionId), this.options.nowMs());
            await this.replaceQueue(sessionId, remaining);
            for (const item of drained)
                this.countQueueOp('dequeue', item.source);
            this.emitUpdates(drained);
            return drained;
        });
    }
    async deleteSession(sessionId) {
        this.assertWritable('delete-session');
        await this.withSessionLock(sessionId, async () => {
            this.queues.delete(sessionId);
            this.hydratedSessions.delete(sessionId);
            await this.options.store?.deleteSession(sessionId);
        });
    }
    async loadQueue(sessionId) {
        const raw = this.options.store
            ? await this.options.store.list(sessionId)
            : (this.queues.get(sessionId) ?? []);
        const recoverRunning = this.options.store ? !this.hydratedSessions.has(sessionId) : false;
        const { items, changed, expired } = normalizeLoadedQueue(raw, this.options.nowMs(), recoverRunning);
        this.hydratedSessions.add(sessionId);
        this.queues.set(sessionId, items);
        if (changed) {
            this.assertWritable('normalize');
            await this.replaceQueue(sessionId, items);
        }
        this.emitUpdates(expired);
        return items;
    }
    async replaceQueue(sessionId, queue) {
        const active = queue.filter(isActiveQueuedMessage);
        this.queues.set(sessionId, active);
        await this.options.store?.replaceSession(sessionId, active);
    }
    async withSessionLock(sessionId, fn) {
        const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
        let release;
        const next = new Promise((resolve) => {
            release = resolve;
        });
        const lock = previous.catch(() => undefined).then(() => next);
        this.sessionLocks.set(sessionId, lock);
        await previous.catch(() => undefined);
        try {
            return await fn();
        }
        finally {
            release();
            if (this.sessionLocks.get(sessionId) === lock)
                this.sessionLocks.delete(sessionId);
        }
    }
    assertWritable(operation) {
        this.options.assertWritable?.(operation);
    }
    emitUpdates(items) {
        for (const item of items)
            this.emitUpdated(item);
    }
    emitUpdated(item, sessionId = item?.sessionId) {
        if (!sessionId)
            return;
        const queuedCount = (this.queues.get(sessionId) ?? []).filter((next) => next.status === 'queued').length;
        this.options.onUpdated?.({
            sessionId,
            ...(item
                ? {
                    itemId: item.itemId,
                    status: item.status,
                    ...(item.failedReason ? { failedReason: item.failedReason } : {}),
                }
                : {}),
            queuedCount,
        });
    }
}
function normalizeLoadedQueue(queue, now, recoverRunning) {
    let changed = false;
    const expired = [];
    const items = [];
    for (const item of queue.filter(isActiveQueuedMessage)) {
        // Harvest stale queued items so list/drain never hand out prompts past
        // their deadline (mirrors daemon SessionInboundQueue.pickNextBatch).
        if (item.status === 'queued' && item.expiresAt !== undefined && now >= item.expiresAt) {
            changed = true;
            expired.push({ ...item, status: 'expired', finishedAt: item.finishedAt ?? now });
            continue;
        }
        if (recoverRunning && item.status === 'running') {
            changed = true;
            items.push({
                ...item,
                status: 'failed',
                finishedAt: item.finishedAt ?? now,
                failedReason: item.failedReason ?? 'Local runtime restarted before this queued message completed.',
            });
            continue;
        }
        items.push(item);
    }
    return { items, changed: changed || items.length !== queue.length, expired };
}
export function isActiveQueuedMessage(item) {
    return item.status === 'queued' || item.status === 'running' || item.status === 'failed';
}
function isQueuedListItem(item) {
    return item.status === 'queued';
}
export function readModelOverride(data) {
    return readLocalModelOverride(data.model);
}
function isEmptyQueuedMessage(message) {
    return message.content.length === 0 && message.attachments.length === 0;
}
export function readQueueItemIds(data) {
    const raw = data.itemIds ?? data.item_ids;
    return Array.isArray(raw)
        ? raw.filter((value) => typeof value === 'string')
        : [];
}
function hasAnyOwn(data, keys) {
    return keys.some((key) => Object.prototype.hasOwnProperty.call(data, key));
}
function readOptionalString(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
function readOptionalNumber(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value === 'string' && value.trim().length > 0) {
            const parsed = Number(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
    return undefined;
}
//# sourceMappingURL=queue.js.map