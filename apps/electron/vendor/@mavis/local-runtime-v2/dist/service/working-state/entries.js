import { and, asc, eq, max } from 'drizzle-orm';
import { bunnySpaces, bunnyWorkingStateEntries as workingStateEntries, bunnyWorkingStateEvents as workingStateEvents, } from '../../infra/db/schema/bunny-store.js';
import { WORKING_STATE_KINDS, WorkingStateError, } from './contracts.js';
import { renderGlobalConstraintExcerpt } from './render.js';
const MAX_TEXT = 4000;
export function invalid(message) {
    throw new WorkingStateError(400, 'INVALID_ARGUMENTS', message);
}
export function notFound() {
    throw new WorkingStateError(404, 'NOT_FOUND', 'Working-state entry not found');
}
export function notActive(id) {
    throw new WorkingStateError(409, 'ENTRY_NOT_ACTIVE', `Entry ${id} is no longer active; list the ledger and act on the current entry.`);
}
export function workingStateKind(value) {
    if (!WORKING_STATE_KINDS.includes(value))
        invalid(`kind must be one of ${WORKING_STATE_KINDS.join(', ')}`);
    return value;
}
/** `space:<id>` is only for a `context_gap`; everything else is global (13.2). */
export function workingStateScope(kind, value) {
    const scope = value?.trim() || 'global';
    if (scope === 'global')
        return scope;
    if (kind !== 'context_gap' || !/^space:\S+$/u.test(scope))
        invalid('scope is global; space:<id> is only for context_gap');
    return scope;
}
/**
 * A new entry's `space:<id>` must name a space that exists (13.2). A gap on a space that
 * does not exist cannot be closed the documented way — writing the decision into that
 * space's context.md — so it would stay in the ledger for good.
 */
export function requireKnownSpace(db, scope) {
    if (scope === 'global')
        return scope;
    const spaceId = scope.slice('space:'.length);
    const found = db
        .select({ id: bunnySpaces.id })
        .from(bunnySpaces)
        .where(eq(bunnySpaces.id, spaceId))
        .get();
    if (!found)
        invalid(`scope names no existing space: ${spaceId}`);
    return scope;
}
export function workingStateText(value, field = 'text') {
    if (typeof value !== 'string' || !value.trim())
        invalid(`${field} must not be empty`);
    if (value.length > MAX_TEXT)
        invalid(`${field} must not exceed ${MAX_TEXT} characters`);
    return value.trim();
}
export function workingStateCloseReason(value, allowed = ['done', 'answered', 'withdrawn']) {
    if (!allowed.includes(value))
        invalid(`close reason must be one of ${allowed.join(', ')}`);
    return value;
}
/** An optional closing note: absent or blank means none. */
export function closeNoteText(value) {
    if (value === undefined || !value.trim())
        return null;
    return workingStateText(value, 'note');
}
export function replacesText(kind, value) {
    if (value === undefined || value === null || value === '')
        return null;
    if (kind !== 'correction')
        invalid('replaces is only for correction');
    return workingStateText(value, 'replaces');
}
export function expiry(value, nowMs) {
    if (value === undefined || value === null)
        return null;
    if (!Number.isSafeInteger(value) || value <= nowMs)
        invalid('expiresAtMs must be a future Unix ms time');
    return value;
}
/** Present only when set: nullable columns become optional fields. */
function optional(key, value) {
    return (value === null || value === undefined || value === '' ? {} : { [key]: value });
}
function rowSource(row) {
    if (!row.sourceMessageId)
        return undefined;
    return {
        ...optional('sessionId', row.sourceSessionId),
        messageId: row.sourceMessageId,
        atMs: row.sourceAtMs ?? row.createdAtMs,
    };
}
/** The closing fields of a row; an active row past its expiry reads as expired. */
function rowClosure(row, nowMs) {
    const expiredAt = row.status === 'active' && row.expiresAtMs !== null && row.expiresAtMs <= nowMs
        ? row.expiresAtMs
        : undefined;
    if (expiredAt === undefined)
        return {
            status: row.status,
            ...optional('closeReason', row.closeReason),
            ...optional('closeNote', row.closeNote),
            updatedBy: row.updatedBy,
            updatedAtMs: row.updatedAtMs,
            ...optional('closedAtMs', row.closedAtMs),
        };
    return {
        status: 'done',
        closeReason: 'expired',
        updatedBy: 'system',
        updatedAtMs: Math.max(row.updatedAtMs, expiredAt),
        closedAtMs: expiredAt,
    };
}
/**
 * The stored row as callers see it. An active entry past its expiry reads as expired even
 * before the sweep writes it, so a read never shows a stale constraint and never writes.
 */
export function toWorkingStateEntry(row, nowMs) {
    const source = rowSource(row);
    return {
        id: row.id,
        kind: row.kind,
        scope: row.scope,
        text: row.text,
        ...optional('replaces', row.replaces),
        ...optional('expiresAtMs', row.expiresAtMs),
        ...optional('supersedes', row.supersedes),
        ...(source ? { source } : {}),
        author: row.author,
        inferred: row.inferred,
        ...optional('handoffAtMs', row.handoffAtMs),
        createdAtMs: row.createdAtMs,
        ...rowClosure(row, nowMs),
    };
}
/** The ledger revision: the sequence of its latest change (11.7). */
export function readWorkingStateRevision(db) {
    return (db
        .select({ seq: max(workingStateEvents.seq) })
        .from(workingStateEvents)
        .get()?.seq ?? 0);
}
/** Read-only ledger rows for owners that only render (execution reminder, feedback). */
export function readWorkingStateEntries(db, nowMs) {
    return db
        .select()
        .from(workingStateEntries)
        .orderBy(asc(workingStateEntries.createdAtMs), asc(workingStateEntries.id))
        .all()
        .map((row) => toWorkingStateEntry(row, nowMs));
}
/** The global-constraint lines a Bunny task's execution reminder carries (13.8). */
export function readGlobalConstraintExcerpt(db, nowMs) {
    return renderGlobalConstraintExcerpt(db
        .select()
        .from(workingStateEntries)
        .where(and(eq(workingStateEntries.status, 'active'), eq(workingStateEntries.scope, 'global'), eq(workingStateEntries.kind, 'constraint')))
        .all()
        .map((row) => toWorkingStateEntry(row, nowMs)));
}
/** Empties the ledger and its change events; Bunny initialization runs it (2.3). */
export function clearWorkingStateLedger(tx) {
    tx.delete(workingStateEvents).run();
    tx.delete(workingStateEntries).run();
}
/** Every ledger row and event, for a backup or a diagnostic bundle. */
export function exportWorkingStateLedger(db) {
    return {
        revision: readWorkingStateRevision(db),
        entries: db.select().from(workingStateEntries).all(),
        events: db.select().from(workingStateEvents).all(),
    };
}
//# sourceMappingURL=entries.js.map