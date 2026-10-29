import { and, asc, desc, eq, gt, gte, inArray, lt, lte, placeholder, sql } from 'drizzle-orm';
import { runWithWriteLock, WriteLockWaitAbortedError, } from '../../../../infra/db/write-transaction.js';
import { legacyMessages, messageRowMigrations, messageRows, sessionAssetIndexState, sessionAssets, } from '../../../../infra/db/schema/messages.js';
import { replaceMessageAssets } from '../asset-index.js';
import { decodeDisplayMessage, decodeMessageSource, normalizeDisplayMessage } from './codec.js';
import { MessageDataCorruptionError, MessageWriteWaitAbortedError, UserMessageCommitAdmissionError, UserMessageCommitConflictError, } from './contract.js';
import { ensureMessageRowsReadyInTransaction } from './readiness.js';
import { syncMessageSourceProjection } from './source-projection.js';
const INPUT_REJECTED_DISPLAY_KIND = 'input_rejected';
export function createMessageRepository(options) {
    return new DrizzleMessageRepository(options);
}
function prepareMessageRead(db) {
    return db
        .select()
        .from(messageRows)
        .where(and(eq(messageRows.sessionId, placeholder('sessionId')), eq(messageRows.messageId, placeholder('msgId'))))
        .prepare();
}
function prepareTurnRead(db) {
    return db
        .select()
        .from(messageRows)
        .where(and(eq(messageRows.sessionId, placeholder('sessionId')), eq(messageRows.turnId, placeholder('turnId'))))
        .orderBy(asc(messageRows.id))
        .prepare();
}
const messageReads = new WeakMap();
const turnReads = new WeakMap();
class DrizzleMessageRepository {
    options;
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async get(sessionId, msgId) {
        this.ensureReady(sessionId);
        const db = this.options.db;
        let query = messageReads.get(db);
        if (!query) {
            query = prepareMessageRead(db);
            messageReads.set(db, query);
        }
        const row = query.get({ sessionId, msgId });
        return row ? decodeDisplayMessage(row) : undefined;
    }
    async list(sessionId, options = {}) {
        this.ensureReady(sessionId);
        const anchorId = options.before ? this.messageRowId(sessionId, options.before) : undefined;
        const afterId = this.visibleBoundaryId(sessionId, options.afterMessageId);
        const limit = normalizeLimit(options.limit, 0);
        const query = this.options.db
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), anchorId === undefined ? undefined : lt(messageRows.id, anchorId), afterId === undefined ? undefined : gt(messageRows.id, afterId)))
            .orderBy(desc(messageRows.id));
        const rows = limit > 0 ? query.limit(limit + 1).all() : query.all();
        const hasMore = limit > 0 && rows.length > limit;
        const selected = (hasMore ? rows.slice(0, limit) : rows).reverse();
        return {
            messages: selected.map(decodeDisplayMessage),
            hasMore,
            ...(hasMore && selected[0] ? { nextCursor: selected[0].messageId } : {}),
        };
    }
    async listAfter(sessionId, afterMsgId, visibleAfterMessageId) {
        this.ensureReady(sessionId);
        const anchorId = afterMsgId ? this.messageRowId(sessionId, afterMsgId) : undefined;
        if (afterMsgId && anchorId === undefined)
            return { status: 'missing-anchor', messages: [] };
        const visibleAfterId = this.visibleBoundaryId(sessionId, visibleAfterMessageId);
        const rows = this.options.db
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), anchorId === undefined ? undefined : gt(messageRows.id, anchorId), visibleAfterId === undefined ? undefined : gt(messageRows.id, visibleAfterId)))
            .orderBy(asc(messageRows.id))
            .all();
        return { status: 'ok', messages: rows.map(decodeDisplayMessage) };
    }
    async listTurn(sessionId, turnId) {
        this.ensureReady(sessionId);
        const db = this.options.db;
        let query = turnReads.get(db);
        if (!query) {
            query = prepareTurnRead(db);
            turnReads.set(db, query);
        }
        return query.all({ sessionId, turnId }).map(decodeDisplayMessage);
    }
    async listRecent(sessionId, options) {
        if (!Number.isFinite(options.limit) || options.limit <= 0)
            return [];
        this.ensureReady(sessionId);
        const rows = this.options.db
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), options.role ? eq(messageRows.role, options.role) : undefined, options.excludePermissionResponses
            ? sql `instr(${messageRows.dataJson}, '<permission-response>') = 0`
            : undefined))
            .orderBy(desc(messageRows.id))
            .limit(normalizeLimit(options.limit, 0))
            .all()
            .reverse();
        return rows.map(decodeDisplayMessage);
    }
    async commitUserMessage(input) {
        const normalized = normalizeDisplayMessage(input.message, {
            turnId: input.turnId,
            source: input.source,
            sourceContext: input.sourceContext,
            generatedIdDiscriminator: `user:${input.turnId}`,
            nowMs: this.nowMs,
        });
        return this.options.db.transaction((tx) => {
            const rejection = this.options.userMessageAdmission?.rejectionInTransaction(tx, {
                sessionId: input.sessionId,
            });
            if (rejection)
                throw new UserMessageCommitAdmissionError(input.sessionId, rejection);
            this.ensureReadyInTransaction(tx, input.sessionId);
            const existing = tx
                .select()
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.messageId, normalized.msgId)))
                .get();
            if (existing) {
                const stored = normalizedFromRow(existing);
                if (!sameUserMessageCommit(stored, normalized)) {
                    const transferred = unconsumedSteeringTransfer(stored, normalized, input);
                    if (!transferred)
                        throw new UserMessageCommitConflictError(input.sessionId, normalized.msgId);
                    this.write(tx, input.sessionId, transferred, hasMessageProvenance(input));
                    return {
                        created: false,
                        firstUserMessageForSession: false,
                        message: decodeDisplayMessage({ ...existing, ...transferred }),
                    };
                }
                return {
                    created: false,
                    firstUserMessageForSession: false,
                    message: decodeDisplayMessage(existing),
                };
            }
            this.write(tx, input.sessionId, normalized, hasMessageProvenance(input));
            const inserted = tx
                .select()
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.messageId, normalized.msgId)))
                .get();
            if (!inserted)
                throw new Error('Stable user Message insert did not produce a row');
            const userMessageCount = tx
                .select({ count: sql `count(*)` })
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.role, 'user'), sql `coalesce(json_extract(${messageRows.dataJson}, '$.kind'), '') <> ${INPUT_REJECTED_DISPLAY_KIND}`))
                .get()?.count ?? 0;
            return {
                created: true,
                firstUserMessageForSession: userMessageCount === 1,
                message: decodeDisplayMessage(inserted),
            };
        }, { behavior: 'immediate' });
    }
    async commitQueueSubmissionRejection(input) {
        const entries = [input.user, input.error].map((entry, index) => ({
            message: normalizeDisplayMessage(entry.message, {
                ...(entry.source === undefined ? {} : { source: entry.source }),
                ...(entry.sourceContext === undefined ? {} : { sourceContext: entry.sourceContext }),
                generatedIdDiscriminator: `queue-rejection:${index}`,
                nowMs: this.nowMs,
            }),
            replaceProvenance: hasMessageProvenance(entry),
        }));
        return this.options.db.transaction((tx) => {
            const rejection = this.options.userMessageAdmission?.rejectionInTransaction(tx, {
                sessionId: input.sessionId,
            });
            if (rejection)
                throw new UserMessageCommitAdmissionError(input.sessionId, rejection);
            this.ensureReadyInTransaction(tx, input.sessionId);
            let created = false;
            const messages = entries.map(({ message, replaceProvenance }) => {
                let row = tx
                    .select()
                    .from(messageRows)
                    .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.messageId, message.msgId)))
                    .get();
                if (!row) {
                    this.write(tx, input.sessionId, message, replaceProvenance);
                    row = tx
                        .select()
                        .from(messageRows)
                        .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.messageId, message.msgId)))
                        .get();
                    if (!row)
                        throw new Error('Rejected input Message insert did not produce a row');
                    created = true;
                }
                return decodeDisplayMessage(row);
            });
            return { created, messages };
        }, { behavior: 'immediate' });
    }
    async upsert(input, options) {
        const [result] = await this.upsertMany([input], options);
        if (!result)
            throw new Error('Message upsert returned no row');
        return result;
    }
    async upsertMany(inputs, options) {
        try {
            return await runWithWriteLock(this.options.db, (db) => this.upsertManyInTransaction(db, inputs), options);
        }
        catch (error) {
            if (error instanceof WriteLockWaitAbortedError) {
                throw new MessageWriteWaitAbortedError(error.signal);
            }
            throw error;
        }
    }
    upsertManyInTransaction(db, inputs) {
        const sessionId = inputs[0]?.sessionId;
        if (!sessionId)
            return [];
        if (inputs.some((input) => input.sessionId !== sessionId)) {
            throw new TypeError('Atomic message upsert must target one Session');
        }
        const normalized = inputs.map((input, index) => ({
            message: normalizeDisplayMessage(input.message, {
                turnId: input.turnId,
                source: input.source,
                sourceContext: input.sourceContext,
                generatedIdDiscriminator: `upsert:${index}`,
                nowMs: this.nowMs,
            }),
            replaceProvenance: hasMessageProvenance(input),
        }));
        this.ensureReadyInTransaction(db, sessionId);
        normalized.forEach(({ message, replaceProvenance }) => this.write(db, sessionId, message, replaceProvenance));
        return normalized.map(({ message }) => message);
    }
    async replace(input) {
        const normalized = this.normalizeReplacementBatch(input.messages, 0);
        this.writeReplacementBatch(input.sessionId, normalized, true);
    }
    async replaceStream(input) {
        let replaceExisting = true;
        let messageIndex = 0;
        for await (const batch of input.batches) {
            if (batch.length === 0)
                continue;
            const normalized = this.normalizeReplacementBatch(batch, messageIndex);
            this.writeReplacementBatch(input.sessionId, normalized, replaceExisting);
            messageIndex += normalized.length;
            replaceExisting = false;
        }
        if (replaceExisting)
            this.writeReplacementBatch(input.sessionId, [], true);
    }
    async rewindInclusive(input) {
        return this.options.db.transaction((tx) => {
            this.ensureReadyInTransaction(tx, input.sessionId);
            if (!input.fromMessageId.startsWith('msg-user-v1-')) {
                throw new Error(`Rewind target must be a committed user message: ${input.fromMessageId}`);
            }
            const target = tx
                .select({ id: messageRows.id, messageId: messageRows.messageId, role: messageRows.role })
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.messageId, input.fromMessageId)))
                .get();
            if (!target || target.role !== 'user') {
                if (input.expectedDeletedMessageIds?.includes(input.fromMessageId)) {
                    const remaining = tx
                        .select({ messageId: messageRows.messageId })
                        .from(messageRows)
                        .where(and(eq(messageRows.sessionId, input.sessionId), inArray(messageRows.messageId, [...input.expectedDeletedMessageIds])))
                        .limit(1)
                        .get();
                    if (!remaining)
                        return { deletedMessageIds: input.expectedDeletedMessageIds };
                }
                throw new Error(`Rewind target user message not found: ${input.sessionId}/${input.fromMessageId}`);
            }
            const deletedRows = tx
                .select({ messageId: messageRows.messageId })
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), gte(messageRows.id, target.id)))
                .orderBy(asc(messageRows.id))
                .all();
            const deletedMessageIds = deletedRows.map(({ messageId }) => messageId);
            if (input.expectedDeletedMessageIds &&
                (deletedMessageIds.length !== input.expectedDeletedMessageIds.length ||
                    deletedMessageIds.some((messageId, index) => messageId !== input.expectedDeletedMessageIds?.[index]))) {
                throw new Error(`Display Rewind suffix changed: ${input.sessionId}/${input.fromMessageId}`);
            }
            tx.delete(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), gte(messageRows.id, target.id)))
                .run();
            tx.delete(sessionAssets)
                .where(and(eq(sessionAssets.sessionId, input.sessionId), inArray(sessionAssets.messageId, deletedMessageIds)))
                .run();
            this.markSessionAssetIndexCurrent(tx, input.sessionId);
            return { deletedMessageIds };
        }, { behavior: 'immediate' });
    }
    async rewind(input) {
        this.mutationTransaction(input.sessionId, (tx) => {
            const ids = new Set(input.messageIds ?? []);
            const anchorId = input.afterMessageId
                ? this.messageRowId(input.sessionId, input.afterMessageId, tx)
                : undefined;
            if (anchorId !== undefined) {
                tx.select({ messageId: messageRows.messageId })
                    .from(messageRows)
                    .where(and(eq(messageRows.sessionId, input.sessionId), gt(messageRows.id, anchorId)))
                    .all()
                    .forEach(({ messageId }) => ids.add(messageId));
            }
            if (ids.size === 0)
                return;
            tx.delete(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), inArray(messageRows.messageId, [...ids])))
                .run();
            tx.delete(sessionAssets)
                .where(and(eq(sessionAssets.sessionId, input.sessionId), inArray(sessionAssets.messageId, [...ids])))
                .run();
        });
    }
    async resolveTurnSource(sessionId, turnId) {
        this.ensureReady(sessionId);
        const row = this.options.db
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.turnId, turnId), eq(messageRows.role, 'user')))
            .orderBy(asc(messageRows.id))
            .limit(1)
            .get();
        return row ? decodeMessageSource(row) : undefined;
    }
    async latestDisplayRowId(sessionId) {
        this.ensureReady(sessionId);
        return (this.options.db
            .select({ id: messageRows.id })
            .from(messageRows)
            .where(eq(messageRows.sessionId, sessionId))
            .orderBy(desc(messageRows.id))
            .limit(1)
            .get()?.id ?? 0);
    }
    async copyPrefix(input) {
        this.copyPrefixInTransaction(this.options.db, input);
    }
    async copyPrefixAndAppendForkOrigin(input) {
        this.options.db.transaction((tx) => {
            this.copyPrefixInTransaction(tx, input);
            this.appendForkOriginInTransaction(tx, input);
        }, { behavior: 'immediate' });
    }
    copyPrefixInTransaction(db, input) {
        this.ensureReadyInTransaction(db, input.sourceSessionId);
        const anchor = db
            .select({ id: messageRows.id })
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, input.sourceSessionId), eq(messageRows.messageId, input.throughMessageId)))
            .get();
        if (!anchor)
            throw new Error(`Prefix anchor not found: ${input.sourceSessionId}/${input.throughMessageId}`);
        const rows = db
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, input.sourceSessionId), lte(messageRows.id, anchor.id)))
            .orderBy(asc(messageRows.id))
            .all()
            .filter((row) => !isForkOriginMessage(decodeDisplayMessage(row)));
        for (const row of rows) {
            const message = normalizedFromRow(row);
            db.insert(messageRows)
                .values({
                sessionId: input.targetSessionId,
                messageId: message.msgId,
                role: message.role,
                turnId: message.turnId,
                source: message.source,
                sourceContextJson: message.sourceContextJson,
                createdAtMs: message.createdAtMs,
                dataJson: message.dataJson,
            })
                .onConflictDoUpdate({
                target: [messageRows.sessionId, messageRows.messageId],
                set: {
                    role: message.role,
                    turnId: message.turnId,
                    source: message.source,
                    sourceContextJson: message.sourceContextJson,
                    createdAtMs: message.createdAtMs,
                    dataJson: message.dataJson,
                },
            })
                .run();
            if (this.options.sourceProjectionEnabled !== false) {
                syncMessageSourceProjection(db, input.targetSessionId, message, this.nowMs());
            }
        }
    }
    async appendForkOrigin(input) {
        this.options.db.transaction((tx) => {
            this.ensureReadyInTransaction(tx, input.targetSessionId);
            this.appendForkOriginInTransaction(tx, input);
        });
    }
    appendForkOriginInTransaction(db, input) {
        const message = {
            role: 'system',
            kind: 'fork-origin',
            forkOrigin: { sourceSessionId: input.sourceSessionId },
        };
        this.write(db, input.targetSessionId, normalizeDisplayMessage(message, {
            generatedIdDiscriminator: `fork-origin:${input.targetSessionId}`,
            nowMs: this.nowMs,
        }));
    }
    async delete(sessionId) {
        await this.replace({ sessionId, messages: [] });
    }
    async deleteSessionData(sessionId) {
        this.options.db.transaction((tx) => {
            tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
            tx.delete(sessionAssetIndexState)
                .where(eq(sessionAssetIndexState.sessionId, sessionId))
                .run();
            tx.delete(messageRows).where(eq(messageRows.sessionId, sessionId)).run();
            tx.delete(messageRowMigrations).where(eq(messageRowMigrations.sessionId, sessionId)).run();
            const legacy = tx
                .select({ piHistoryJson: legacyMessages.piHistoryJson })
                .from(legacyMessages)
                .where(eq(legacyMessages.sessionId, sessionId))
                .get();
            if (legacy?.piHistoryJson === '[]') {
                tx.delete(legacyMessages).where(eq(legacyMessages.sessionId, sessionId)).run();
            }
            else if (legacy) {
                tx.update(legacyMessages)
                    .set({ displayMessagesJson: '[]' })
                    .where(eq(legacyMessages.sessionId, sessionId))
                    .run();
            }
        });
    }
    ensureReady(sessionId) {
        const marker = this.options.db
            .select({ sessionId: messageRowMigrations.sessionId })
            .from(messageRowMigrations)
            .where(eq(messageRowMigrations.sessionId, sessionId))
            .get();
        if (marker)
            return;
        this.mutationTransaction(sessionId, () => undefined);
    }
    mutationTransaction(sessionId, mutation) {
        return this.options.db.transaction((tx) => {
            this.ensureReadyInTransaction(tx, sessionId);
            return mutation(tx);
        }, { behavior: 'immediate' });
    }
    ensureReadyInTransaction(db, sessionId) {
        ensureMessageRowsReadyInTransaction(db, sessionId, this.nowMs(), (message, index) => {
            const normalized = normalizeDisplayMessage(message, {
                generatedIdDiscriminator: `legacy:${index}`,
                nowMs: this.nowMs,
            });
            this.write(db, sessionId, normalized);
        });
    }
    write(db, sessionId, message, replaceProvenance = true) {
        const existing = replaceProvenance
            ? undefined
            : db
                .select({
                source: messageRows.source,
                sourceContextJson: messageRows.sourceContextJson,
            })
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.messageId, message.msgId)))
                .get();
        const source = existing?.source ?? message.source;
        const sourceContextJson = existing?.sourceContextJson ?? message.sourceContextJson;
        db.insert(messageRows)
            .values({
            sessionId,
            messageId: message.msgId,
            role: message.role,
            turnId: message.turnId,
            source,
            sourceContextJson,
            createdAtMs: message.createdAtMs,
            dataJson: message.dataJson,
        })
            .onConflictDoUpdate({
            target: [messageRows.sessionId, messageRows.messageId],
            set: {
                role: message.role,
                turnId: message.turnId,
                source,
                sourceContextJson,
                createdAtMs: message.createdAtMs,
                dataJson: message.dataJson,
            },
        })
            .run();
        if (this.options.sourceProjectionEnabled !== false) {
            syncMessageSourceProjection(db, sessionId, message, this.nowMs());
        }
        replaceMessageAssets(db, sessionId, message, this.nowMs());
    }
    normalizeReplacementBatch(messages, startIndex) {
        return messages.map((message, index) => normalizeDisplayMessage(message, {
            generatedIdDiscriminator: `replace:${String(startIndex + index)}`,
            nowMs: this.nowMs,
        }));
    }
    writeReplacementBatch(sessionId, messages, replaceExisting) {
        this.mutationTransaction(sessionId, (tx) => {
            if (replaceExisting) {
                tx.delete(messageRows).where(eq(messageRows.sessionId, sessionId)).run();
                tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
                tx.delete(sessionAssetIndexState)
                    .where(eq(sessionAssetIndexState.sessionId, sessionId))
                    .run();
            }
            messages.forEach((message) => this.write(tx, sessionId, message));
            this.markSessionAssetIndexCurrent(tx, sessionId);
        });
    }
    markSessionAssetIndexCurrent(db, sessionId) {
        const latestRowId = db
            .select({ id: messageRows.id })
            .from(messageRows)
            .where(eq(messageRows.sessionId, sessionId))
            .orderBy(desc(messageRows.id))
            .limit(1)
            .get()?.id ?? 0;
        const state = {
            sessionId,
            indexVersion: 1,
            indexedThroughMessageRowId: latestRowId,
            indexedAtMs: this.nowMs(),
            status: 'ready',
            errorJson: null,
        };
        db.insert(sessionAssetIndexState)
            .values(state)
            .onConflictDoUpdate({ target: sessionAssetIndexState.sessionId, set: state })
            .run();
    }
    visibleBoundaryId(sessionId, messageId) {
        if (!messageId)
            return undefined;
        const id = this.messageRowId(sessionId, messageId);
        if (id === undefined)
            throw new MessageDataCorruptionError(sessionId, messageId);
        return id;
    }
    messageRowId(sessionId, messageId, db = this.options.db) {
        return db
            .select({ id: messageRows.id })
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.messageId, messageId)))
            .get()?.id;
    }
}
function normalizedFromRow(row) {
    return {
        msgId: row.messageId,
        role: row.role,
        turnId: row.turnId,
        source: row.source,
        sourceContextJson: row.sourceContextJson,
        createdAtMs: row.createdAtMs,
        dataJson: row.dataJson,
    };
}
function unconsumedSteeringTransfer(stored, intended, input) {
    if (stored.role !== 'user')
        return undefined;
    const oldData = parseJsonRecord(stored.dataJson);
    if (!canTransferUnconsumedDisplay(stored, oldData, input))
        return undefined;
    const newData = parseJsonRecord(intended.dataJson);
    const samePayload = { ...newData };
    for (const field of ['kind', 'query_key', 'turnId']) {
        if (Object.hasOwn(oldData, field))
            samePayload[field] = oldData[field];
        else
            delete samePayload[field];
    }
    if (!sameUserMessageCommit(stored, {
        ...intended,
        turnId: stored.turnId,
        dataJson: JSON.stringify(samePayload),
    }))
        return undefined;
    return {
        ...intended,
        createdAtMs: stored.createdAtMs,
        dataJson: JSON.stringify({
            ...newData,
            timestamp: oldData.timestamp,
            ...(oldData.created_at !== undefined ? { created_at: oldData.created_at } : {}),
        }),
    };
}
function canTransferUnconsumedDisplay(stored, data, input) {
    const turnId = stored.turnId ?? '';
    return (input.unstartedFromTurnIds?.includes(turnId) === true ||
        (data.kind === 'steered_user' && input.unconsumedFromTurnIds?.includes(turnId) === true));
}
function sameUserMessageCommit(stored, intended) {
    return JSON.stringify(commitIdentity(stored)) === JSON.stringify(commitIdentity(intended));
}
function commitIdentity(message) {
    const data = parseJsonRecord(message.dataJson);
    delete data.timestamp;
    delete data.created_at;
    return canonicalJsonValue({
        role: message.role,
        turnId: message.turnId,
        source: message.source,
        sourceContext: message.sourceContextJson ? parseJsonRecord(message.sourceContextJson) : null,
        data,
    });
}
function parseJsonRecord(value) {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('Committed user Message JSON must be an object');
    }
    return { ...parsed };
}
function canonicalJsonValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalJsonValue);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
}
function hasMessageProvenance(input) {
    return (input.message.source !== undefined ||
        input.message.sourceContext !== undefined ||
        input.source !== undefined ||
        input.sourceContext !== undefined);
}
function isForkOriginMessage(message) {
    return message.kind === 'fork-origin' || message.displayKind === 'fork-origin';
}
function normalizeLimit(value, fallback) {
    return Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value) : fallback;
}
//# sourceMappingURL=drizzle.js.map