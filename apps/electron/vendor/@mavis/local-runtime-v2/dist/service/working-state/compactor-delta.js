import { and, eq, inArray } from 'drizzle-orm';
import { messageRows } from '../../infra/db/schema/messages.js';
import { bunnyWorkingStateEntries as workingStateEntries, bunnyWorkingStateEvents as workingStateEvents, } from '../../infra/db/schema/bunny-store.js';
import { WorkingStateError, } from './contracts.js';
import { closeNoteText, requireKnownSpace, toWorkingStateEntry, workingStateCloseReason, workingStateKind, workingStateScope, workingStateText, } from './entries.js';
class Drop extends Error {
    reason;
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
function validated(read) {
    try {
        return read();
    }
    catch (error) {
        if (error instanceof WorkingStateError)
            throw new Drop('invalid');
        throw error;
    }
}
/** Checks and writes the operations of one delta inside one transaction. */
class DeltaApplier {
    tx;
    input;
    writers;
    covered;
    sourceTimes;
    constructor(tx, input, writers) {
        this.tx = tx;
        this.input = input;
        this.writers = writers;
        this.covered = new Set(input.coveredMessageIds);
        // Messages live in the shared database; the ledger transaction is on the Bunny store.
        this.sourceTimes = new Map(this.covered.size
            ? writers.messages
                .select({ messageId: messageRows.messageId, atMs: messageRows.createdAtMs })
                .from(messageRows)
                .where(and(eq(messageRows.sessionId, input.sessionId), inArray(messageRows.messageId, [...this.covered])))
                .all()
                .map((row) => [row.messageId, row.atMs])
            : []);
    }
    replayed(operationId) {
        return Boolean(this.tx
            .select({ seq: workingStateEvents.seq })
            .from(workingStateEvents)
            .where(eq(workingStateEvents.operationId, operationId))
            .get());
    }
    apply(operation, operationId) {
        if (operation.op === 'close')
            return this.close(operation, operationId);
        return this.add(operation, operationId);
    }
    source(messageId) {
        const atMs = this.sourceTimes.get(messageId);
        if (typeof messageId !== 'string' || !this.covered.has(messageId) || atMs === undefined)
            throw new Drop('source-out-of-range');
        return { sessionId: this.input.sessionId, messageId, atMs };
    }
    active(id) {
        const row = id
            ? this.tx.select().from(workingStateEntries).where(eq(workingStateEntries.id, id)).get()
            : undefined;
        if (!row || toWorkingStateEntry(row, this.writers.nowMs).status !== 'active')
            throw new Drop('target-not-active');
        return row;
    }
    close(operation, operationId) {
        const reason = validated(() => workingStateCloseReason(operation.reason, ['done', 'answered']));
        const note = validated(() => closeNoteText(operation.note));
        this.source(operation.sourceMessageId);
        this.writers.close(this.active(operation.entryId), { reason, note }, this.writers.nowMs, operationId);
        return { entryId: operation.entryId };
    }
    fields(operation) {
        const { nowMs } = this.writers;
        return validated(() => {
            const kind = workingStateKind(operation.kind);
            const expiresAtMs = operation.expiresAtMs;
            return {
                kind,
                scope: workingStateScope(kind, operation.scope),
                text: workingStateText(operation.text),
                replaces: operation.replaces && kind === 'correction'
                    ? workingStateText(operation.replaces, 'replaces')
                    : null,
                // A past or malformed expiry is dropped; the entry itself still stands.
                expiresAtMs: expiresAtMs !== undefined && Number.isSafeInteger(expiresAtMs) && expiresAtMs > nowMs
                    ? expiresAtMs
                    : null,
            };
        });
    }
    add(operation, operationId) {
        const fields = this.fields(operation);
        validated(() => requireKnownSpace(this.tx, fields.scope));
        const origin = this.source(operation.sourceMessageId);
        const duplicate = this.tx
            .select({ id: workingStateEntries.id })
            .from(workingStateEntries)
            .where(and(eq(workingStateEntries.kind, fields.kind), eq(workingStateEntries.sourceMessageId, origin.messageId)))
            .get();
        if (duplicate)
            throw new Drop('duplicate');
        const replaced = operation.supersedes ? this.active(operation.supersedes) : undefined;
        const entry = this.writers.insert({
            ...fields,
            supersedes: replaced?.id ?? null,
            source: origin,
            author: 'compactor',
            inferred: true,
            nowMs: this.writers.nowMs,
            operationId,
        });
        if (replaced)
            this.writers.supersede(replaced, this.writers.nowMs, `${operationId}:supersede`);
        return { entryId: entry.id };
    }
}
/**
 * Applies a compactor's ledger delta inside the caller's transaction (12.3, 11.7). Every
 * operation is checked against the ledger as it is now, so a revision that changed since
 * the compaction started only shows up in the counts:
 * - its source message exists and lies in the covered range;
 * - an add with the same (kind, source message) as any entry, closed ones included, is
 *   skipped and never reopens it;
 * - a close or a replacement must target an active entry.
 * An operation whose ID (batch ID + index) already has an event was applied by an earlier
 * call: it is counted as replayed and not written again.
 */
export function applyWorkingStateDelta(tx, input, writers) {
    if (typeof input.batchId !== 'string' || !input.batchId.trim())
        throw new WorkingStateError(400, 'INVALID_ARGUMENTS', 'batchId is required');
    const revisionChanged = writers.revision() !== input.baseRevision;
    const applier = new DeltaApplier(tx, input, writers);
    let replayed = 0;
    const drops = [];
    const entryIds = [];
    input.operations.forEach((operation, index) => {
        const operationId = `${input.batchId}:${index}`;
        if (applier.replayed(operationId)) {
            replayed += 1;
            return;
        }
        try {
            entryIds.push(applier.apply(operation, operationId).entryId);
        }
        catch (error) {
            if (!(error instanceof Drop))
                throw error;
            drops.push({ index, reason: error.reason });
        }
    });
    return {
        revision: writers.revision(),
        revisionChanged,
        written: entryIds.length,
        replayed,
        dropped: drops.length,
        droppedAfterRevisionChange: revisionChanged ? drops.length : 0,
        drops,
        entryIds,
    };
}
//# sourceMappingURL=compactor-delta.js.map