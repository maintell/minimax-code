import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { legacyQueues, queueItems, queuePauses, queueRowMigrations, } from '../../../../infra/db/schema/queue.js';
import { QueueClaimNotAcceptedError, QueueClaimNotFoundError, QueueEnqueueAdmissionError, } from './contract.js';
import { decodeQueueRow, encodeQueueItem, isQueueItem } from './codec.js';
import { completePermutation, makeQueued, routingFingerprint, validEnqueue, validUpdate, } from './policy.js';
import { ensureQueueRowsReadyInTransaction } from './readiness.js';
import { queueExecutionSource, queueRoutingProvenance } from '../routing.js';
const DEFAULT_CLAIM_LEASE_MS = 30_000;
export function createQueueRepository(options) {
    return new DrizzleQueueRepository(options);
}
class DrizzleQueueRepository {
    options;
    nowMs;
    makeId;
    claimOwnerId;
    claimLeaseMs;
    isClaimOwnerAlive;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.makeId = options.makeId ?? ((prefix) => `${prefix}_${randomUUID()}`);
        this.claimOwnerId = options.claimOwnerId?.trim() || `queue-claim:${randomUUID()}`;
        this.claimLeaseMs = positiveInteger(options.claimLeaseMs, DEFAULT_CLAIM_LEASE_MS);
        this.isClaimOwnerAlive = options.isClaimOwnerAlive ?? (() => true);
    }
    async listPendingSessionIds() {
        return this.options.db
            .selectDistinct({ sessionId: queueItems.sessionId })
            .from(queueItems)
            .where(inArray(queueItems.status, ['queued', 'claimed']))
            .orderBy(asc(queueItems.sessionId))
            .all()
            .map(({ sessionId }) => sessionId);
    }
    async snapshot(sessionId) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            this.reconcilePause(db, sessionId);
            return committed(this.executionSnapshot(db, sessionId), expiredItems.map((item) => removalFact(item, 'expired', nowMs)));
        });
    }
    async pauseIfPending(input) {
        return this.transaction(input.sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, input.sessionId, nowMs);
            this.reconcilePause(db, input.sessionId);
            const inserted = this.pendingCount(db, input.sessionId) > 0
                ? db
                    .insert(queuePauses)
                    .values({
                    sessionId: input.sessionId,
                    cause: input.cause,
                    triggerTurnId: input.triggerTurnId,
                    pausedAtMs: nowMs,
                })
                    .onConflictDoNothing({ target: queuePauses.sessionId })
                    .run().changes > 0
                : false;
            return committed(this.executionSnapshot(db, input.sessionId), [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...(inserted ? [executionStateFact(input.sessionId, true)] : []),
            ]);
        });
    }
    async continueQueue(sessionId, expectedPause) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            this.reconcilePause(db, sessionId);
            const deleted = db
                .delete(queuePauses)
                .where(expectedPause
                ? and(eq(queuePauses.sessionId, sessionId), eq(queuePauses.cause, expectedPause.cause), eq(queuePauses.triggerTurnId, expectedPause.triggerTurnId), eq(queuePauses.pausedAtMs, expectedPause.pausedAtMs))
                : eq(queuePauses.sessionId, sessionId))
                .run().changes > 0;
            return committed(this.executionSnapshot(db, sessionId), [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...(deleted ? [executionStateFact(sessionId, false)] : []),
            ]);
        });
    }
    async list(sessionId) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            return committed(this.rowsByStatus(db, sessionId, 'queued'), expiredItems.map((item) => removalFact(item, 'expired', nowMs)));
        });
    }
    async findByClientRequestId(sessionId, clientRequestId) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            return committed(this.findByClientRequest(db, sessionId, clientRequestId), expiredItems.map((item) => removalFact(item, 'expired', nowMs)));
        });
    }
    async get(sessionId, itemId) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            return committed(this.find(db, sessionId, itemId), expiredItems.map((item) => removalFact(item, 'expired', nowMs)));
        });
    }
    async enqueue(input) {
        if (!validEnqueue(input))
            return committed(undefined);
        return this.mutationTransaction(input.session.sessionId, (db) => this.enqueueInTransaction(db, input));
    }
    async updateQueued(input) {
        if (!validUpdate(input))
            return committed('invalid');
        return this.mutationTransaction(input.sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, input.sessionId, nowMs);
            const facts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
            if (input.expiresAt !== undefined && input.expiresAt <= nowMs) {
                return committed('invalid', facts);
            }
            const item = this.find(db, input.sessionId, input.itemId);
            if (!item)
                return committed(undefined, facts);
            if (item.status !== 'queued')
                return committed('not_editable', facts);
            if (item.source !== 'api')
                return committed('not_editable', facts);
            const messageUpdated = input.message
                ? replaceItemMessage(item, input.message)
                : item;
            const updated = {
                ...messageUpdated,
                ...modelUpdate(input),
                ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
            };
            this.write(db, updated);
            return committed(updated, facts);
        });
    }
    async cancel(sessionId, itemId) {
        return this.mutationTransaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const facts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
            const item = this.find(db, sessionId, itemId);
            if (!item)
                return committed(undefined, facts);
            if (item.status !== 'queued')
                return committed('not_editable', facts);
            this.deleteItem(db, sessionId, itemId);
            return committed(item, [...facts, removalFact(item, 'cancelled', nowMs)]);
        });
    }
    async clearUserManageable(sessionId) {
        return this.mutationTransaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const clearedItems = this.clearQueuedApi(db, sessionId);
            const clearedPause = this.pendingCount(db, sessionId) === 0 &&
                db.delete(queuePauses).where(eq(queuePauses.sessionId, sessionId)).run().changes > 0;
            return committed(clearedItems, [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...clearedItems.map((item) => removalFact(item, 'cancelled', nowMs)),
                ...(clearedPause ? [executionStateFact(sessionId, false)] : []),
            ]);
        });
    }
    async promoteQueuedSource(sessionId, itemId, source) {
        return this.mutationTransaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const facts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
            const item = this.find(db, sessionId, itemId);
            if (!item)
                return committed(undefined, facts);
            if (item.status !== 'queued')
                return committed('not_editable', facts);
            const updated = { ...item, source };
            this.write(db, updated);
            return committed(updated, facts);
        });
    }
    async reorder(input) {
        return this.mutationTransaction(input.sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, input.sessionId, nowMs);
            const facts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
            if (this.hasClaimed(db, input.sessionId))
                return committed('invalid', facts);
            const items = this.rowsByStatus(db, input.sessionId, 'queued');
            if (!completePermutation(items, input.itemIds))
                return committed('invalid', facts);
            const byId = new Map(items.map((item) => [item.itemId, item]));
            const reordered = input.itemIds.flatMap((id) => {
                const item = byId.get(id);
                return item ? [item] : [];
            });
            this.replaceRows(db, input.sessionId, reordered);
            return committed(reordered, facts);
        });
    }
    async claimNext(input) {
        return this.transaction(input.sessionId, (db) => {
            const nowMs = input.nowMs ?? this.nowMs();
            const expiredItems = this.deleteExpired(db, input.sessionId, nowMs);
            const facts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
            if (!input.itemId && !input.continuePaused && this.pause(db, input.sessionId)) {
                return committed(undefined, facts);
            }
            if (this.hasClaimed(db, input.sessionId))
                return committed(undefined, facts);
            const selected = this.claimCandidate(db, input);
            if (!selected || (input.allowedSources && !input.allowedSources.includes(selected.source))) {
                return committed(undefined, facts);
            }
            const claimId = this.makeId('claim');
            const claimed = this.claim(db, selected, {
                claimId,
                claimedAt: nowMs,
                leaseExpiresAt: nowMs + this.claimLeaseMs,
            });
            return committed(dispatchItem(claimed, claimSelection(input)), facts);
        });
    }
    async prepareDelivery(input) {
        if (!input.turnId)
            throw new TypeError('Queue delivery requires a Turn identity');
        this.transaction(input.sessionId, (db) => {
            const items = this.claimRows(db, input.sessionId, input.claimId);
            if (items.length === 0)
                throw new QueueClaimNotFoundError(input.sessionId, input.claimId);
            for (const item of items) {
                const attempts = item.deliveryAttempts ?? [];
                const existing = attempts.find((attempt) => attempt.claimId === input.claimId);
                if (existing && existing.turnId !== input.turnId)
                    throw new Error('Queue delivery claim already belongs to another Turn');
                if (!existing)
                    this.write(db, {
                        ...item,
                        deliveryAttempts: [...attempts, { claimId: input.claimId, turnId: input.turnId }],
                    });
            }
            return committed(undefined);
        });
    }
    async acknowledgeClaim(sessionId, claimId, turnId, acceptanceLookup) {
        if (!claimId)
            throw new QueueClaimNotFoundError(sessionId, claimId);
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const claimed = this.claimRows(db, sessionId, claimId);
            if (claimed.length === 0)
                throw new QueueClaimNotFoundError(sessionId, claimId);
            const query = claimQuery(claimed, claimId, turnId);
            if (!acceptanceLookup || !acceptanceLookup.isAcceptedInTransaction(db, query)) {
                throw new QueueClaimNotAcceptedError(sessionId, claimId, turnId);
            }
            acceptanceLookup.markAcknowledgedInTransaction(db, query);
            claimed.forEach((item) => this.deleteItem(db, sessionId, item.itemId));
            return committed(claimed, [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...claimed.map((item) => removalFact(item, 'accepted', nowMs)),
            ]);
        });
    }
    async releaseClaim(sessionId, claimId, reason) {
        if (!claimId)
            return committed([]);
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const claimed = this.claimRows(db, sessionId, claimId);
            const facts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
            const released = claimed.flatMap((item) => {
                if (expired(item, nowMs)) {
                    this.deleteItem(db, sessionId, item.itemId);
                    facts.push(removalFact(item, 'expired', nowMs));
                    return [];
                }
                const releasedItem = this.release(db, item);
                facts.push({
                    ...requeueFact(releasedItem, nowMs),
                    ...(reason ? { admissionReason: reason } : {}),
                });
                return [releasedItem];
            });
            return committed(released, facts);
        });
    }
    async rejectClaim(sessionId, claimId, reason) {
        if (!claimId)
            throw new QueueClaimNotFoundError(sessionId, claimId);
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const claimed = this.claimRows(db, sessionId, claimId);
            if (claimed.length === 0)
                throw new QueueClaimNotFoundError(sessionId, claimId);
            claimed.forEach((item) => this.deleteItem(db, sessionId, item.itemId));
            return committed(claimed, [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...claimed.map((item) => removalFact(item, 'admission-rejected', nowMs, { admissionReason: reason })),
            ]);
        });
    }
    async cancelClaim(sessionId, claimId) {
        return this.removeClaimed(sessionId, claimId, 'cancelled');
    }
    async consumeClaim(sessionId, claimId, reason) {
        return this.removeClaimed(sessionId, claimId, reason);
    }
    async removeClaimed(sessionId, claimId, reason) {
        if (!claimId)
            throw new QueueClaimNotFoundError(sessionId, claimId);
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const claimed = this.claimRows(db, sessionId, claimId);
            if (claimed.length === 0)
                throw new QueueClaimNotFoundError(sessionId, claimId);
            claimed.forEach((item) => this.deleteItem(db, sessionId, item.itemId));
            return committed(claimed, [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...claimed.map((item) => removalFact(item, reason, nowMs)),
            ]);
        });
    }
    async recoverClaims(sessionId, acceptanceLookup, scope) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const claims = groupRecoverable(this.rowsByStatus(db, sessionId, 'claimed'), {
                nowMs,
                isOwnerAlive: this.isClaimOwnerAlive,
                claimLeaseMs: this.claimLeaseMs,
                scope,
            });
            const result = {
                acknowledged: [],
                released: [],
            };
            const facts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
            claims.forEach((items, claimId) => {
                const query = claimQuery(items, claimId);
                const pendingDelivery = items.some((item) => item.deliveryAttempts?.at(-1)?.claimId === claimId);
                if (!pendingDelivery && acceptanceLookup.isAcceptedInTransaction(db, query)) {
                    acceptanceLookup.markAcknowledgedInTransaction(db, query);
                    items.forEach((item) => this.deleteItem(db, sessionId, item.itemId));
                    result.acknowledged.push(...items);
                    facts.push(...items.map((item) => removalFact(item, 'accepted', nowMs)));
                }
                else {
                    result.released.push(...items.flatMap((item) => {
                        if (expired(item, nowMs)) {
                            this.deleteItem(db, sessionId, item.itemId);
                            facts.push(removalFact(item, 'expired', nowMs));
                            return [];
                        }
                        const releasedItem = this.release(db, item);
                        facts.push(requeueFact(releasedItem, nowMs));
                        return [releasedItem];
                    }));
                }
            });
            return committed(result, facts);
        });
    }
    async drainComposerInjectable(sessionId) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const selected = db
                .select()
                .from(queueItems)
                .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, 'queued'), eq(queueItems.source, 'api'), sql `trim(json_extract(${queueItems.dataJson}, '$.message.content')) <> ''`, sql `json_array_length(json_extract(${queueItems.dataJson}, '$.message.attachments')) = 0`))
                .orderBy(asc(queueItems.id))
                .all()
                .map(decodeQueueRow);
            selected.forEach((item) => this.deleteItem(db, sessionId, item.itemId));
            return committed(selected, [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...selected.map((item) => removalFact(item, 'composer-transferred', nowMs)),
            ]);
        });
    }
    async replaceSession(sessionId, items) {
        if (items.some((item) => item.sessionId !== sessionId || !isQueueItem(item))) {
            throw new TypeError('Queue replacement contains an invalid item');
        }
        this.options.db.transaction((db) => {
            this.replaceRows(db, sessionId, items);
            db.insert(queueRowMigrations)
                .values({ sessionId, queueRowsBackfilledAtMs: this.nowMs() })
                .onConflictDoUpdate({
                target: queueRowMigrations.sessionId,
                set: { queueRowsBackfilledAtMs: this.nowMs() },
            })
                .run();
            db.delete(legacyQueues).where(eq(legacyQueues.sessionId, sessionId)).run();
            this.reconcilePause(db, sessionId);
        }, { behavior: 'immediate' });
        return committed(undefined);
    }
    async deleteSession(sessionId) {
        return this.transaction(sessionId, (db) => {
            const nowMs = this.nowMs();
            const expiredItems = this.deleteExpired(db, sessionId, nowMs);
            const remaining = this.allRows(db, sessionId);
            db.delete(queueItems).where(eq(queueItems.sessionId, sessionId)).run();
            db.delete(queueRowMigrations).where(eq(queueRowMigrations.sessionId, sessionId)).run();
            db.delete(legacyQueues).where(eq(legacyQueues.sessionId, sessionId)).run();
            return committed(undefined, [
                ...expiredItems.map((item) => removalFact(item, 'expired', nowMs)),
                ...remaining.map((item) => removalFact(item, 'cancelled', nowMs)),
            ]);
        });
    }
    transaction(sessionId, operation) {
        return this.options.db.transaction((db) => {
            ensureQueueRowsReadyInTransaction(db, sessionId, this.nowMs());
            const wasPaused = Boolean(this.pause(db, sessionId));
            const result = operation(db);
            this.reconcilePause(db, sessionId);
            return withPauseRemovalFact(result, sessionId, wasPaused && !this.pause(db, sessionId));
        }, { behavior: 'immediate' });
    }
    mutationTransaction(sessionId, operation) {
        return this.options.db.transaction((db) => {
            this.assertMutationAdmitted(db, sessionId);
            ensureQueueRowsReadyInTransaction(db, sessionId, this.nowMs());
            const wasPaused = Boolean(this.pause(db, sessionId));
            const result = operation(db);
            this.reconcilePause(db, sessionId);
            return withPauseRemovalFact(result, sessionId, wasPaused && !this.pause(db, sessionId));
        }, { behavior: 'immediate' });
    }
    assertMutationAdmitted(db, sessionId) {
        const rejection = this.options.enqueueAdmission?.rejectionInTransaction(db, {
            sessionId,
            nowMs: this.nowMs(),
        });
        if (rejection)
            throw new QueueEnqueueAdmissionError(sessionId, rejection);
    }
    enqueueInTransaction(db, input) {
        const nowMs = this.nowMs();
        const expiredItems = this.deleteExpired(db, input.session.sessionId, nowMs);
        const expiredFacts = expiredItems.map((item) => removalFact(item, 'expired', nowMs));
        if (input.expiresAt !== undefined && input.expiresAt <= nowMs) {
            return committed(undefined, expiredFacts);
        }
        // A trusted identity-restoring requeue (input.itemId) must never bounce
        // off this gate: the claimed row is either its own consumed predecessor
        // (taken over below) or work that is about to leave the queue anyway,
        // and rejecting the requeue would silently drop a delivered user message.
        if (input.queuePlacement === 'front' &&
            !input.itemId &&
            this.hasClaimed(db, input.session.sessionId)) {
            return committed(undefined, expiredFacts);
        }
        const found = input.clientRequestId
            ? this.findByClientRequest(db, input.session.sessionId, input.clientRequestId)
            : undefined;
        return found
            ? this.replayEnqueue(db, input, found, expiredFacts)
            : this.insertEnqueue(db, input, nowMs, expiredFacts);
    }
    replayEnqueue(db, input, found, expiredFacts) {
        const existing = this.attachRequestedTurnId(db, found, input.requestedTurnId);
        if (input.queuePlacement === 'front')
            this.moveQueuedToFront(db, existing);
        return committed(this.enqueueResult(db, existing), expiredFacts);
    }
    insertEnqueue(db, input, nowMs, expiredFacts) {
        const batchClaims = this.settleBatchMemberClaims(db, input, nowMs);
        const restored = this.restorableIdentity(db, input);
        const item = makeQueued(input, restored?.itemId ?? this.makeId('queue'), nowMs);
        const replaced = input.dedupeKey
            ? this.findByDedupeKey(db, input.session.sessionId, input.dedupeKey)
            : undefined;
        if (replaced)
            this.replaceItem(db, replaced, item);
        else
            this.write(db, item);
        if (input.queuePlacement === 'front')
            this.moveQueuedToFront(db, item);
        return committed(this.enqueueResult(db, item), [
            ...expiredFacts,
            ...batchClaims,
            ...(restored?.displaced ? [removalFact(restored.displaced, 'cancelled', nowMs)] : []),
            ...(replaced ? [removalFact(replaced, 'cancelled', nowMs)] : []),
            enqueueFact(item),
        ]);
    }
    settleBatchMemberClaims(db, input, nowMs) {
        const facts = [];
        for (const member of input.immediateSendBatch?.members ?? []) {
            const itemId = member.queueClaim?.itemId ?? member.sourceMessageId;
            if (!itemId)
                continue;
            const existing = this.find(db, input.session.sessionId, itemId);
            if (member.queueClaim && existing?.claimId !== member.queueClaim.claimId)
                continue;
            if (existing?.status !== 'claimed')
                continue;
            if (existing.userMessageId && existing.userMessageId !== member.userMessageId) {
                throw new TypeError('Immediate-send member claim identity changed');
            }
            this.deleteItem(db, existing.sessionId, existing.itemId);
            facts.push(removalFact(existing, 'injected', nowMs));
        }
        return facts;
    }
    /** A requeue may restore its consumed item's identity, never seize live queued work. */
    restorableIdentity(db, input) {
        if (!input.itemId)
            return undefined;
        const existing = this.find(db, input.session.sessionId, input.itemId);
        if (!existing)
            return { itemId: input.itemId };
        if (existing.status !== 'claimed')
            return undefined;
        // A claimed row under this id is the very item whose steering was just
        // discarded back to the Queue: the send-now consume has not deleted it
        // yet. Take the identity over so the follow-up query keeps its reconcile
        // key; the racing consume observes a settled (vanished) claim instead of
        // double-removing the item.
        this.deleteItem(db, input.session.sessionId, existing.itemId);
        return { itemId: input.itemId, displaced: existing };
    }
    find(db, sessionId, itemId) {
        const row = db
            .select()
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.itemId, itemId)))
            .get();
        return row ? decodeQueueRow(row) : undefined;
    }
    write(db, item) {
        const row = storage(item);
        db.insert(queueItems)
            .values(row)
            .onConflictDoUpdate({
            target: [queueItems.sessionId, queueItems.itemId],
            set: {
                status: row.status,
                createdAtMs: row.createdAtMs,
                dataJson: row.dataJson,
                source: row.source,
                clientRequestId: row.clientRequestId,
                dedupeKey: row.dedupeKey,
                expiresAtMs: row.expiresAtMs,
                claimId: row.claimId,
                claimLeaseExpiresAtMs: row.claimLeaseExpiresAtMs,
                routingFingerprint: row.routingFingerprint,
            },
        })
            .run();
    }
    replaceItem(db, previous, item) {
        db.update(queueItems)
            .set(storage(item))
            .where(and(eq(queueItems.sessionId, previous.sessionId), eq(queueItems.itemId, previous.itemId)))
            .run();
    }
    replaceRows(db, sessionId, items) {
        db.delete(queueItems).where(eq(queueItems.sessionId, sessionId)).run();
        items.forEach((item) => db.insert(queueItems).values(storage(item)).run());
    }
    moveQueuedToFront(db, item) {
        const queued = this.rowsByStatus(db, item.sessionId, 'queued');
        const reordered = [item, ...queued.filter(({ itemId }) => itemId !== item.itemId)];
        db.delete(queueItems)
            .where(and(eq(queueItems.sessionId, item.sessionId), eq(queueItems.status, 'queued')))
            .run();
        reordered.forEach((queuedItem) => db.insert(queueItems).values(storage(queuedItem)).run());
    }
    deleteItem(db, sessionId, itemId) {
        db.delete(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.itemId, itemId)))
            .run();
    }
    clearQueuedApi(db, sessionId) {
        const queuedApiRows = and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, 'queued'), eq(queueItems.source, 'api'));
        const selected = db
            .select()
            .from(queueItems)
            .where(queuedApiRows)
            .orderBy(asc(queueItems.id))
            .all()
            .map(decodeQueueRow);
        db.delete(queueItems).where(queuedApiRows).run();
        return selected;
    }
    claim(db, item, claim) {
        const claimed = {
            ...item,
            status: 'claimed',
            claimId: claim.claimId,
            claimedAt: claim.claimedAt,
            claimOwnerId: this.claimOwnerId,
            claimLeaseExpiresAt: claim.leaseExpiresAt,
        };
        this.write(db, claimed);
        return claimed;
    }
    claimCandidate(db, input) {
        if (input.itemId)
            return onlyQueuedItem(this.find(db, input.sessionId, input.itemId));
        const queued = this.rowsByStatus(db, input.sessionId, 'queued');
        if (!input.excludeItemIds?.length)
            return queued[0];
        const excluded = new Set(input.excludeItemIds);
        return queued.find((item) => !excluded.has(item.itemId));
    }
    release(db, item) {
        const released = withoutClaim(item);
        this.write(db, released);
        return released;
    }
    claimRows(db, sessionId, claimId) {
        return db
            .select()
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, 'claimed'), eq(queueItems.claimId, claimId)))
            .orderBy(asc(queueItems.id))
            .all()
            .map(decodeQueueRow);
    }
    rowsByStatus(db, sessionId, status) {
        return db
            .select()
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, status)))
            .orderBy(asc(queueItems.id))
            .all()
            .map(decodeQueueRow);
    }
    allRows(db, sessionId) {
        return db
            .select()
            .from(queueItems)
            .where(eq(queueItems.sessionId, sessionId))
            .orderBy(asc(queueItems.id))
            .all()
            .map(decodeQueueRow);
    }
    deleteExpired(db, sessionId, nowMs) {
        const expiredItems = db
            .select()
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, 'queued'), isNotNull(queueItems.expiresAtMs), lte(queueItems.expiresAtMs, nowMs)))
            .orderBy(asc(queueItems.id))
            .all()
            .map(decodeQueueRow);
        db.delete(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, 'queued'), isNotNull(queueItems.expiresAtMs), lte(queueItems.expiresAtMs, nowMs)))
            .run();
        return expiredItems;
    }
    hasClaimed(db, sessionId) {
        return Boolean(db
            .select({ id: queueItems.id })
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, 'claimed')))
            .limit(1)
            .get());
    }
    pendingCount(db, sessionId) {
        return (db
            .select({ total: sql `count(*)`.mapWith(Number) })
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), inArray(queueItems.status, ['queued', 'claimed'])))
            .get()?.total ?? 0);
    }
    pause(db, sessionId) {
        const row = db.select().from(queuePauses).where(eq(queuePauses.sessionId, sessionId)).get();
        if (!row)
            return undefined;
        return {
            cause: row.cause,
            triggerTurnId: row.triggerTurnId,
            pausedAtMs: row.pausedAtMs,
        };
    }
    executionSnapshot(db, sessionId) {
        const pause = this.pause(db, sessionId);
        return {
            pendingCount: this.pendingCount(db, sessionId),
            ...(pause ? { pause } : {}),
        };
    }
    reconcilePause(db, sessionId) {
        if (this.pendingCount(db, sessionId) > 0)
            return;
        db.delete(queuePauses).where(eq(queuePauses.sessionId, sessionId)).run();
    }
    enqueueResult(db, item) {
        if (item.status !== 'queued')
            return { item, position: 1 };
        const row = db
            .select({ id: queueItems.id })
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, item.sessionId), eq(queueItems.itemId, item.itemId)))
            .get();
        if (!row)
            return { item, position: 1 };
        const position = db
            .select({ total: sql `count(*)`.mapWith(Number) })
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, item.sessionId), eq(queueItems.status, 'queued'), lte(queueItems.id, row.id)))
            .get()?.total ?? 1;
        return { item, position };
    }
    attachRequestedTurnId(db, item, requestedTurnId) {
        if (!requestedTurnId || item.requestedTurnId)
            return item;
        const updated = { ...item, requestedTurnId };
        this.write(db, updated);
        return updated;
    }
    findByClientRequest(db, sessionId, clientRequestId) {
        const row = db
            .select()
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.clientRequestId, clientRequestId)))
            .limit(1)
            .get();
        return row ? decodeQueueRow(row) : undefined;
    }
    findByDedupeKey(db, sessionId, dedupeKey) {
        const row = db
            .select()
            .from(queueItems)
            .where(and(eq(queueItems.sessionId, sessionId), eq(queueItems.status, 'queued'), eq(queueItems.dedupeKey, dedupeKey)))
            .orderBy(asc(queueItems.id))
            .limit(1)
            .get();
        return row ? decodeQueueRow(row) : undefined;
    }
}
function onlyQueuedItem(item) {
    return item?.status === 'queued' ? item : undefined;
}
function storage(item) {
    return {
        sessionId: item.sessionId,
        itemId: item.itemId,
        status: item.status,
        createdAtMs: item.createdAt,
        dataJson: encodeQueueItem(item),
        source: item.source,
        clientRequestId: item.clientRequestId ?? null,
        dedupeKey: item.dedupeKey ?? null,
        expiresAtMs: item.expiresAt ?? null,
        claimId: item.claimId ?? null,
        claimLeaseExpiresAtMs: item.claimLeaseExpiresAt ?? null,
        routingFingerprint: routingFingerprint(item),
    };
}
function committed(value, facts = []) {
    return { value, facts: [...facts] };
}
function withPauseRemovalFact(result, sessionId, removed) {
    if (!removed ||
        result.facts.some((fact) => fact.kind === 'execution-state-changed' && fact.sessionId === sessionId && !fact.paused)) {
        return result;
    }
    return committed(result.value, [...result.facts, executionStateFact(sessionId, false)]);
}
function executionStateFact(sessionId, paused) {
    return { kind: 'execution-state-changed', sessionId, paused };
}
function enqueueFact(item) {
    return {
        kind: 'enqueued',
        sessionId: item.sessionId,
        itemId: item.itemId,
        source: item.source,
        ...(item.clientRequestId ? { clientRequestId: item.clientRequestId } : {}),
        enqueuedAtMs: item.createdAt,
    };
}
function requeueFact(item, requeuedAtMs) {
    return {
        kind: 'requeued',
        sessionId: item.sessionId,
        itemId: item.itemId,
        source: item.source,
        ...(item.clientRequestId ? { clientRequestId: item.clientRequestId } : {}),
        requeuedAtMs,
    };
}
function removalFact(item, reason, removedAtMs, details = {}) {
    return {
        kind: 'removed',
        sessionId: item.sessionId,
        itemId: item.itemId,
        reason,
        removedAtMs,
        ...details,
    };
}
function modelUpdate(input) {
    if (input.model === null)
        return { model: undefined };
    return input.model ? { model: input.model } : {};
}
function dispatchItem(item, selection) {
    if (!item.claimId || !item.claimOwnerId || item.claimLeaseExpiresAt === undefined) {
        throw new TypeError('Queue claim is incomplete');
    }
    return {
        claimId: item.claimId,
        sessionId: item.sessionId,
        source: item.source,
        claimOwnerId: item.claimOwnerId,
        claimLeaseExpiresAt: item.claimLeaseExpiresAt,
        selection,
        item,
        message: item.message,
        ...(item.clientRequestId ? { clientRequestId: item.clientRequestId } : {}),
        provenance: queueRoutingProvenance(item),
    };
}
function claimSelection(input) {
    if (input.itemId)
        return 'exact';
    return input.continuePaused ? 'continued-fifo' : 'fifo';
}
function claimQuery(items, claimId, turnId) {
    const first = items[0];
    if (!first)
        throw new QueueClaimNotFoundError('', claimId);
    return {
        sessionId: first.sessionId,
        claimId,
        source: queueExecutionSource(first),
        queueItemIds: items.map(({ itemId }) => itemId),
        ...(turnId ? { turnId } : {}),
    };
}
function withoutClaim(item) {
    const { claimId, claimedAt, claimOwnerId, claimLeaseExpiresAt, ...rest } = item;
    void claimId;
    void claimedAt;
    void claimOwnerId;
    void claimLeaseExpiresAt;
    return { ...rest, status: 'queued' };
}
function groupRecoverable(items, liveness) {
    const grouped = new Map();
    items.forEach((item) => {
        if (item.status !== 'claimed' || !item.claimId)
            return;
        grouped.set(item.claimId, [...(grouped.get(item.claimId) ?? []), item]);
    });
    return new Map([...grouped].filter(([, claimed]) => !claimed.some((item) => activeClaim(item, liveness))));
}
function expired(item, nowMs) {
    return item.expiresAt !== undefined && item.expiresAt <= nowMs;
}
function positiveInteger(value, fallback) {
    return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function replaceItemMessage(item, message) {
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
//# sourceMappingURL=drizzle.js.map