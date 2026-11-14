import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { bunnyWorkingStateEntries as workingStateEntries, bunnyWorkingStateEvents as workingStateEvents, } from '../../infra/db/schema/bunny-store.js';
import { WORKING_STATE_STATUSES, } from './contracts.js';
import { applyWorkingStateDelta } from './compactor-delta.js';
import { closeNoteText, expiry, invalid, notActive, notFound, readWorkingStateEntries, readWorkingStateRevision, replacesText, requireKnownSpace, toWorkingStateEntry, workingStateCloseReason, workingStateKind, workingStateScope, workingStateText, } from './entries.js';
import { renderWorkingStateDelta, renderWorkingStateHeader } from './render.js';
/** Node timers overflow past this delay; a later expiry re-arms on the next pass. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * The single writer of Bunny's working-state ledger. Every change appends an event in the
 * same transaction; the events give the revision and the replay identity of compactor
 * writes. The ledger never writes MEMORY.md (13.7).
 */
export class WorkingStateService {
    options;
    db;
    nowMs;
    newId;
    cancelTimer;
    closed = false;
    constructor(options) {
        this.options = options;
        this.db = options.db;
        this.nowMs = options.nowMs ?? Date.now;
        this.newId = options.newId ?? (() => `ws-${randomUUID().replaceAll('-', '').slice(0, 10)}`);
    }
    revision() {
        return readWorkingStateRevision(this.db);
    }
    get(id) {
        return toWorkingStateEntry(this.row(this.db, id), this.nowMs());
    }
    /** Read-only: filters by kind, scope and status; it never writes, not even expiries. */
    list(filter = {}) {
        const conditions = [];
        if (filter.kind)
            conditions.push(eq(workingStateEntries.kind, workingStateKind(filter.kind)));
        if (filter.scope)
            conditions.push(eq(workingStateEntries.scope, filter.scope.trim()));
        if (filter.status && !WORKING_STATE_STATUSES.includes(filter.status))
            invalid(`status must be one of ${WORKING_STATE_STATUSES.join(', ')}`);
        const now = this.nowMs();
        return this.db
            .select()
            .from(workingStateEntries)
            .where(conditions.length ? and(...conditions) : undefined)
            .orderBy(asc(workingStateEntries.createdAtMs), asc(workingStateEntries.id))
            .all()
            .map((row) => toWorkingStateEntry(row, now))
            .filter((entry) => !filter.status || entry.status === filter.status);
    }
    add(input, actor) {
        const entry = this.transaction((tx) => {
            const kind = workingStateKind(input.kind);
            const now = this.nowMs();
            return this.insert(tx, {
                kind,
                scope: requireKnownSpace(tx, workingStateScope(kind, input.scope)),
                text: workingStateText(input.text),
                replaces: replacesText(kind, input.replaces),
                expiresAtMs: expiry(input.expiresAtMs, now),
                supersedes: null,
                source: input.source,
                author: actor,
                inferred: false,
                nowMs: now,
            });
        });
        this.armExpiry();
        return entry;
    }
    /** The old entry becomes superseded; a new entry of the same kind and scope replaces it. */
    update(input, actor) {
        const entry = this.transaction((tx) => {
            const current = this.activeRow(tx, input.id);
            const now = this.nowMs();
            const next = this.insert(tx, {
                kind: current.kind,
                scope: current.scope,
                text: workingStateText(input.text),
                replaces: input.replaces === undefined
                    ? current.replaces
                    : replacesText(current.kind, input.replaces),
                expiresAtMs: input.expiresAtMs === undefined ? current.expiresAtMs : expiry(input.expiresAtMs, now),
                supersedes: current.id,
                source: input.source ??
                    (current.sourceMessageId
                        ? {
                            ...(current.sourceSessionId ? { sessionId: current.sourceSessionId } : {}),
                            messageId: current.sourceMessageId,
                            atMs: current.sourceAtMs ?? current.createdAtMs,
                        }
                        : undefined),
                author: actor,
                inferred: false,
                nowMs: now,
            });
            this.transition(tx, current, { status: 'superseded' }, { action: 'supersede', actor, nowMs: now });
            return next;
        });
        this.armExpiry();
        return entry;
    }
    /** `note` says in words why: the user's answer, or why a rule no longer applies. */
    close(id, reason, actor, note) {
        const closeReason = workingStateCloseReason(reason, actor === 'user' ? ['withdrawn', 'done'] : ['done', 'answered', 'withdrawn']);
        const closeNote = closeNoteText(note);
        return this.transaction((tx) => {
            const current = this.activeRow(tx, id);
            const now = this.nowMs();
            return this.transition(tx, current, { status: 'done', closeReason, closeNote, closedAtMs: now }, { action: 'close', actor, nowMs: now });
        });
    }
    /** The user accepts an inferred entry as theirs: the "推断" mark goes, the content stays. */
    confirm(id) {
        return this.transaction((tx) => {
            const current = this.row(tx, id);
            if (!current.inferred)
                return toWorkingStateEntry(current, this.nowMs());
            const now = this.nowMs();
            const row = tx
                .update(workingStateEntries)
                .set({ inferred: false, updatedAtMs: Math.max(now, current.updatedAtMs) })
                .where(eq(workingStateEntries.id, id))
                .returning()
                .get();
            this.event(tx, id, { action: 'confirm', actor: 'user', nowMs: now });
            return toWorkingStateEntry(row, now);
        });
    }
    /**
     * Closes every active entry whose expiry has passed as done/expired (13.3), so the next
     * delta block reports it. Returns how many entries it closed.
     */
    sweepExpired() {
        const now = this.nowMs();
        const closed = this.transaction((tx) => {
            const due = tx
                .select()
                .from(workingStateEntries)
                .where(and(eq(workingStateEntries.status, 'active'), isNotNull(workingStateEntries.expiresAtMs), lte(workingStateEntries.expiresAtMs, now)))
                .all();
            for (const row of due)
                this.transition(tx, row, { status: 'done', closeReason: 'expired', closedAtMs: row.expiresAtMs ?? now }, { action: 'expire', actor: 'system', nowMs: now });
            return due.length;
        });
        this.armExpiry();
        return closed;
    }
    /** The ledger section of a handoff header, after closing what has expired. */
    renderHeader(budgetTokens) {
        this.sweepExpired();
        return renderWorkingStateHeader(readWorkingStateEntries(this.db, this.nowMs()), {
            nowMs: this.nowMs(),
            budgetTokens,
        });
    }
    /** The injected ledger in full, without a budget: the memory recorder's evidence (13.7). */
    renderEvidence() {
        return renderWorkingStateHeader(readWorkingStateEntries(this.db, this.nowMs()), {
            nowMs: this.nowMs(),
            budgetTokens: Number.POSITIVE_INFINITY,
        }).text;
    }
    /**
     * The delta block's ledger lines against the caller's delivery baseline (`undefined`
     * means no baseline: full state). The caller records `delivered` only after the block
     * is in history (9.4).
     */
    renderDelta(delivered) {
        this.sweepExpired();
        return renderWorkingStateDelta(readWorkingStateEntries(this.db, this.nowMs()), {
            nowMs: this.nowMs(),
            delivered,
        });
    }
    /** Validates and writes one compaction's ledger delta in one transaction (12.3, 11.7). */
    applyCompactorDelta(input) {
        const result = this.transaction((tx) => applyWorkingStateDelta(tx, input, {
            messages: this.options.messages,
            nowMs: this.nowMs(),
            newId: this.newId,
            revision: () => readWorkingStateRevision(tx),
            insert: (row) => this.insert(tx, row),
            close: (row, { reason, note }, now, operationId) => this.transition(tx, row, { status: 'done', closeReason: reason, closeNote: note, closedAtMs: now }, { action: 'close', actor: 'compactor', nowMs: now, operationId }),
            supersede: (row, now, operationId) => this.transition(tx, row, { status: 'superseded' }, { action: 'supersede', actor: 'compactor', nowMs: now, operationId }),
        }));
        this.armExpiry();
        return result;
    }
    /**
     * Compactor entries already written that no handoff header has carried yet (11.7): the
     * next compaction is told not to add them again, and the delta block reports them.
     */
    pendingHandoffEntries() {
        const now = this.nowMs();
        return this.db
            .select()
            .from(workingStateEntries)
            .where(and(eq(workingStateEntries.author, 'compactor'), isNull(workingStateEntries.handoffAtMs)))
            .orderBy(asc(workingStateEntries.createdAtMs), asc(workingStateEntries.id))
            .all()
            .map((row) => toWorkingStateEntry(row, now));
    }
    /** Records that a committed handoff header carried these entries. Not a ledger change. */
    markInHandoff(entryIds) {
        if (!entryIds.length)
            return;
        this.db
            .update(workingStateEntries)
            .set({ handoffAtMs: this.nowMs() })
            .where(and(inArray(workingStateEntries.id, [...entryIds]), isNull(workingStateEntries.handoffAtMs)))
            .run();
    }
    /** Starts the expiry timer for entries already in the ledger. */
    start() {
        this.sweepExpired();
    }
    stop() {
        this.closed = true;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
    }
    transaction(run) {
        return this.db.transaction((tx) => run(tx), { behavior: 'immediate' });
    }
    row(db, id) {
        if (typeof id !== 'string' || !id.trim())
            invalid('entry id is required');
        return (db.select().from(workingStateEntries).where(eq(workingStateEntries.id, id)).get() ??
            notFound());
    }
    activeRow(db, id) {
        const row = this.row(db, id);
        if (toWorkingStateEntry(row, this.nowMs()).status !== 'active')
            notActive(id);
        return row;
    }
    insert(tx, input) {
        const row = tx
            .insert(workingStateEntries)
            .values({
            id: this.newId(),
            kind: input.kind,
            scope: input.scope,
            text: input.text,
            replaces: input.replaces,
            expiresAtMs: input.expiresAtMs,
            supersedes: input.supersedes,
            status: 'active',
            sourceSessionId: input.source?.sessionId ?? null,
            sourceMessageId: input.source?.messageId ?? null,
            sourceAtMs: input.source?.atMs ?? null,
            author: input.author,
            inferred: input.inferred,
            updatedBy: input.author,
            createdAtMs: input.nowMs,
            updatedAtMs: input.nowMs,
        })
            .returning()
            .get();
        this.event(tx, row.id, {
            action: 'add',
            actor: input.author,
            nowMs: input.nowMs,
            operationId: input.operationId,
        });
        return toWorkingStateEntry(row, input.nowMs);
    }
    transition(tx, current, patch, change) {
        const row = tx
            .update(workingStateEntries)
            .set({
            ...patch,
            updatedBy: change.actor,
            updatedAtMs: Math.max(change.nowMs, current.updatedAtMs),
        })
            .where(eq(workingStateEntries.id, current.id))
            .returning()
            .get();
        this.event(tx, current.id, change);
        return toWorkingStateEntry(row, change.nowMs);
    }
    event(tx, entryId, change) {
        tx.insert(workingStateEvents)
            .values({
            entryId,
            action: change.action,
            actor: change.actor,
            operationId: change.operationId ?? null,
            createdAtMs: change.nowMs,
        })
            .run();
    }
    /** One timer for the nearest future expiry; the sweep re-arms it. */
    armExpiry() {
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        if (this.closed)
            return;
        const next = this.db
            .select({ at: workingStateEntries.expiresAtMs })
            .from(workingStateEntries)
            .where(and(eq(workingStateEntries.status, 'active'), isNotNull(workingStateEntries.expiresAtMs)))
            .orderBy(asc(workingStateEntries.expiresAtMs))
            .limit(1)
            .get()?.at;
        if (next === undefined || next === null)
            return;
        const delay = Math.min(MAX_TIMER_MS, Math.max(0, next - this.nowMs()));
        const setTimer = this.options.setTimer ??
            ((ms, run) => {
                const handle = setTimeout(run, ms);
                handle.unref?.();
                return () => clearTimeout(handle);
            });
        this.cancelTimer = setTimer(delay, () => {
            this.cancelTimer = undefined;
            if (this.closed)
                return;
            try {
                this.sweepExpired();
            }
            catch (error) {
                this.options.warn?.(error);
            }
        });
    }
}
//# sourceMappingURL=working-state.service.js.map