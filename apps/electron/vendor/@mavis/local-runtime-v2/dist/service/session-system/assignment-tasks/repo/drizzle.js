import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { and, asc, eq, gt, gte, inArray, isNotNull, like, or, sql } from 'drizzle-orm';
// Short local names for the task graph tables.
import { bunnyAssignmentTaskEvents as assignmentTaskEvents, bunnyAssignmentTasks as assignmentTasks, bunnySpaceSessions, } from '../../../../infra/db/schema/bunny-store.js';
import { messageRows } from '../../../../infra/db/schema/messages.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
import { tokenUsage } from '../../../../infra/db/schema/usage.js';
import { logger as defaultLogger } from '../../../../infra/logging/logger.js';
import { readAssignerBySession, readBunnyAssignedSessionIds } from './assigned-by-bunny.js';
import { PROJECTED_EVENT_TYPES, REVIEW_REDELIVERED, REVIEW_RETRIES_SET, TASK_DETAILS_SET, assignmentTaskId, decodeAssignmentTask, encodeAssignmentTask, projectTaskFacts, sameReviewRetries, sameTaskDetails, taskDetails, } from './codec.js';
import { REVIEW_FINISHED, TASK_ROUND_ENDED, diffTaskEvents, } from './events.js';
import { SKIP, assignmentTransitions as T } from './transitions.js';
const EVENT_CHUNK = 500;
/** Assigner Session ids per `IN` list, so a wide closure stays under the bound-parameter ceiling. */
const ASSIGNER_CHUNK = 500;
/** How often an index the store never gave may be read again. */
const INDEX_RETRY_INTERVAL_MS = 30_000;
export function createAssignmentTaskRepository(options) {
    return new DrizzleAssignmentTaskRepository(options);
}
class DrizzleAssignmentTaskRepository {
    options;
    nowMs;
    logger;
    /** Assigner Agent by task Session; every write below keeps it (see {@link AssignmentTaskIndex}). */
    assigners = new Map();
    /** Whether the index has been read from the store at least once. */
    loaded = false;
    /** When the store was last read for the index. */
    loadAttemptAtMs = 0;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
        this.logger = options.logger ?? defaultLogger;
        this.reloadAssigners();
    }
    assignerOf(sessionId) {
        return this.assigners.get(sessionId);
    }
    storedAssignerOf(sessionId) {
        const known = this.assigners.get(sessionId);
        if (known !== undefined || this.storeEmpty())
            return known;
        try {
            const stored = readAssignerBySession(this.options.db, [sessionId]).get(sessionId);
            if (stored !== undefined)
                this.assigners.set(sessionId, stored);
            return stored;
        }
        catch (error) {
            this.logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Assignment task could not be read from the store; the Session reads as having no task');
            return undefined;
        }
    }
    /**
     * A read that fails keeps the index it had: after a failed reload the
     * Sessions known to have a task keep it. Only a store never read leaves the
     * index empty, and every Session then reads as having no task.
     */
    reloadAssigners() {
        this.loadAttemptAtMs = this.nowMs();
        if (this.storeEmpty()) {
            this.assigners = new Map();
            this.loaded = true;
            return;
        }
        try {
            this.assigners = new Map(readAssignerBySession(this.options.db));
            this.loaded = true;
        }
        catch (error) {
            this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, this.loaded
                ? 'Assignment task index could not be reloaded; the last loaded index is kept'
                : 'Assignment task index could not be loaded; Sessions read as having no task');
        }
    }
    available() {
        return this.loaded;
    }
    retryLoad() {
        if (!this.loaded && this.nowMs() - this.loadAttemptAtMs >= INDEX_RETRY_INTERVAL_MS)
            this.reloadAssigners();
        return this.loaded;
    }
    hasAssignmentMessage(sessionId) {
        return this.options.sessions
            .select({ context: messageRows.sourceContextJson })
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.role, 'user'), like(messageRows.sourceContextJson, '%"assignment"%')))
            .all()
            .some(({ context }) => hasAssignmentOrigin(context));
    }
    async get(sessionId) {
        if (this.storeEmpty())
            return undefined;
        return readOne(this.options.db, sessionId);
    }
    async getMany(sessionIds) {
        if (this.storeEmpty())
            return new Map();
        const rows = chunks([...new Set(sessionIds)]).flatMap((chunk) => this.options.db
            .select()
            .from(assignmentTasks)
            .where(inArray(assignmentTasks.sessionId, chunk))
            .all());
        return new Map(decodeRows(this.options.db, rows).map((task) => [task.sessionId, task.assignment]));
    }
    /**
     * Tasks joined with their Sessions in application code: the tasks come from
     * the Bunny store, then their Sessions from the shared database. A task whose
     * Session is gone (or not a v3 Session) is dropped here.
     */
    async list(options = {}) {
        if (this.storeEmpty())
            return [];
        const rows = this.options.db
            .select()
            .from(assignmentTasks)
            .where(and(...listPredicates(options)))
            .all();
        const order = this.sessionOrder(rows.map((row) => row.sessionId), options.archived);
        const kept = rows
            .filter((row) => order.has(row.sessionId))
            // The order Session listing uses, so recovery and report batches keep their sequence.
            .sort((a, b) => compareSessions(order.get(a.sessionId), order.get(b.sessionId)));
        return decodeRows(this.options.db, kept);
    }
    async open(sessionId, assignment, note) {
        const opened = this.transition(sessionId, 'open', T.open(sessionId, assignment), { note });
        if (!opened)
            throw new Error(`Assignment target was deleted: ${sessionId}`);
        return opened;
    }
    async openInSpace(sessionId, assignment, spaceId, note) {
        const opened = this.transition(sessionId, 'open', T.open(sessionId, assignment), {
            note,
            link: { spaceId },
        });
        if (!opened)
            throw new Error(`Assignment target was deleted: ${sessionId}`);
        return opened;
    }
    async reassign(sessionId, assignment, note) {
        return this.transition(sessionId, 'reassign', T.reassign(assignment), { note });
    }
    async restore(sessionId, applied, previous) {
        return this.applied(sessionId, 'restore', T.restore(applied, previous));
    }
    async close(sessionId, completion) {
        return this.transition(sessionId, 'close', T.close(completion));
    }
    async reopen(sessionId, startedAt, turnId) {
        return this.applied(sessionId, 'reopen', T.reopen(startedAt), turnId ? { turnId } : {});
    }
    async clearPendingStart(sessionId, note) {
        return this.transition(sessionId, 'clearPendingStart', T.clearPendingStart(), { note });
    }
    async recordReport(sessionId, expected, input) {
        const { round, ...report } = input;
        return this.applied(sessionId, 'recordReport', T.recordReport(expected, report), round ? { round } : {});
    }
    async resumeReview(sessionId, turnId) {
        return this.applied(sessionId, 'resumeReview', T.resumeReview(turnId));
    }
    async startVerdictReview(sessionId, reviewTask) {
        return this.applied(sessionId, 'startVerdictReview', T.startVerdictReview(reviewTask));
    }
    async recordVerdict(sessionId, verdict) {
        return this.applied(sessionId, 'recordVerdict', T.recordVerdict(verdict));
    }
    async claimVerdict(sessionId, claim) {
        return this.applied(sessionId, 'claimVerdict', T.claimVerdict(claim));
    }
    async finishReview(sessionId, input) {
        const { result, ...review } = input;
        return this.transition(sessionId, 'finishReview', T.finishReview(review), {
            note: result ? { reviewResult: result } : {},
        });
    }
    async appendEvent(sessionId, event) {
        const row = selectTask(this.options.db, sessionId);
        if (!row)
            return false;
        const append = (db) => {
            const createdAtMs = this.nowMs();
            const inserted = db
                .insert(assignmentTaskEvents)
                .values({
                taskId: row.taskId,
                type: event.type,
                payload: event.payload,
                dedupeKey: event.dedupeKey,
                createdAtMs,
            })
                .onConflictDoNothing()
                .returning({ seq: assignmentTaskEvents.seq })
                .get();
            if (!inserted)
                return false;
            const { taskId, sessionId: task, assignerSessionId, assignerAgentName } = row;
            return [
                {
                    seq: inserted.seq,
                    taskId,
                    sessionId: task,
                    assignerSessionId,
                    assignerAgentName,
                    type: event.type,
                    payload: event.payload,
                    createdAtMs,
                },
            ];
        };
        if (!this.options.historyWritten)
            return append(this.options.db) !== false;
        return this.options.db.transaction((tx) => {
            const written = append(tx);
            if (written)
                this.historyWritten(tx, written);
            return written !== false;
        }, { behavior: 'immediate' });
    }
    /** The history observer, inside the writing transaction; it never fails the write. */
    historyWritten(tx, events) {
        if (!events.length || !this.options.historyWritten)
            return;
        try {
            this.options.historyWritten(tx, events);
        }
        catch (error) {
            this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Assignment task history observer failed; the transition is kept');
        }
    }
    async listEvents(query) {
        if (this.storeEmpty())
            return [];
        const rows = this.options.db
            .select({
            seq: assignmentTaskEvents.seq,
            sessionId: assignmentTasks.sessionId,
            type: assignmentTaskEvents.type,
            payload: assignmentTaskEvents.payload,
            createdAtMs: assignmentTaskEvents.createdAtMs,
        })
            .from(assignmentTaskEvents)
            .innerJoin(assignmentTasks, eq(assignmentTasks.taskId, assignmentTaskEvents.taskId))
            .where(and(query.sessionId === undefined
            ? undefined
            : eq(assignmentTasks.sessionId, query.sessionId), query.types ? inArray(assignmentTaskEvents.type, [...query.types]) : undefined, query.afterSeq === undefined ? undefined : gt(assignmentTaskEvents.seq, query.afterSeq)))
            .orderBy(asc(assignmentTaskEvents.seq));
        return query.limit === undefined ? rows.all() : rows.limit(query.limit).all();
    }
    /**
     * @see AssignmentTaskRepository.reviewedTaskIds
     *
     * The review Turn is matched and the Sessions de-duplicated in SQL, against the partial
     * expression index `idx_assignment_task_events_review_turn`. Only the ids come back: no
     * payload is decoded and no row of another Turn is materialised.
     */
    async reviewedTaskIds(reviewTurnId) {
        if (this.storeEmpty())
            return [];
        return this.options.db
            .select({ sessionId: assignmentTasks.sessionId })
            .from(assignmentTaskEvents)
            .innerJoin(assignmentTasks, eq(assignmentTaskEvents.taskId, assignmentTasks.taskId))
            .where(and(eq(assignmentTaskEvents.type, REVIEW_FINISHED), sql `json_extract(${assignmentTaskEvents.payload}, '$.reviewTurnId') = ${reviewTurnId}`))
            .groupBy(assignmentTasks.sessionId)
            .all()
            .map((row) => row.sessionId);
    }
    bunnyCreatedSessionIds() {
        if (this.storeEmpty())
            return [];
        // A follow-up rewrites the assignment's via to 'send'. Its opening event retains the creator.
        return this.options.db
            .select({ id: assignmentTasks.sessionId })
            .from(assignmentTasks)
            .innerJoin(assignmentTaskEvents, eq(assignmentTaskEvents.taskId, assignmentTasks.taskId))
            .where(and(eq(assignmentTaskEvents.type, 'task.opened'), sql `json_extract(${assignmentTaskEvents.payload}, '$.via') = 'create'`, sql `json_extract(${assignmentTaskEvents.payload}, '$.assigner') = ${BUNNY_AGENT_NAME}`))
            .all()
            .map((row) => row.id);
    }
    async bunnyAssignedSessionIds() {
        if (this.storeEmpty())
            return [];
        return readBunnyAssignedSessionIds(this.options.db);
    }
    async assignerBySession(sessionIds) {
        if (this.storeEmpty())
            return new Map();
        return readAssignerBySession(this.options.db, sessionIds);
    }
    async deleteForSession(sessionId) {
        if (this.storeEmpty())
            return 0;
        const deleted = this.options.db
            .delete(assignmentTasks)
            .where(eq(assignmentTasks.sessionId, sessionId))
            .run().changes;
        this.assigners.delete(sessionId);
        return deleted;
    }
    async listSessionIds() {
        if (this.storeEmpty())
            return [];
        return this.options.db
            .select({ sessionId: assignmentTasks.sessionId })
            .from(assignmentTasks)
            .all()
            .map((row) => row.sessionId);
    }
    async deleteForSessions(sessionIds) {
        if (this.storeEmpty())
            return 0;
        let deleted = 0;
        for (const chunk of chunks([...new Set(sessionIds)])) {
            deleted += this.options.db
                .delete(assignmentTasks)
                .where(inArray(assignmentTasks.sessionId, chunk))
                .run().changes;
            for (const sessionId of chunk)
                this.assigners.delete(sessionId);
        }
        return deleted;
    }
    /** The store holds nothing yet, so it has no task row to read or delete. */
    storeEmpty() {
        return this.options.storeHasData?.() === false;
    }
    /** Whether the transition ran (it may have removed the task). */
    applied(sessionId, kind, apply, note) {
        return this.run(sessionId, kind, apply, { note }).ran;
    }
    /**
     * Runs one named transition. Returns the new projection, or undefined when
     * the Session is gone, the task was removed, or the transition skipped.
     */
    transition(sessionId, kind, apply, extra) {
        return this.run(sessionId, kind, apply, extra).next;
    }
    /**
     * The three steps of a transition. Neither database's transaction is opened
     * inside the other's: ① the Session must exist in the shared database; ② the
     * task (and, for `openInSpace`, its space link) is written in one immediate
     * Bunny store transaction; ③ the Session's `updatedAtMs` is refreshed. When
     * ③ finds no Session it was deleted after ①, so the task just written is
     * removed again. A failing ③ only warns: the task is the fact this call
     * records, and `updatedAtMs` only orders listings.
     */
    run(sessionId, kind, apply, { note = {}, link } = {}) {
        const skipped = { ran: false, next: undefined };
        if (!this.sessionExists(sessionId))
            return skipped;
        const nowMs = this.nowMs();
        const written = this.options.db.transaction((tx) => {
            const row = selectTask(tx, sessionId);
            const current = row ? decodeAssignmentTask(row, readFacts(tx, row.taskId)) : undefined;
            const next = apply(current);
            if (next === SKIP)
                return undefined;
            if (next) {
                const history = writeTask(tx, {
                    sessionId,
                    row,
                    current,
                    next,
                    nowMs,
                    kind,
                    note,
                    userMessages: (openedAtMs) => userMessageCount(this.options.sessions, { sessionId, openedAtMs }),
                    totalTokens: (openedAtMs) => taskTokenTotal(this.options.sessions, { sessionId, openedAtMs }),
                });
                if (link)
                    linkSpace(tx, sessionId, link.spaceId, nowMs);
                this.historyWritten(tx, history);
            }
            else if (row)
                tx.delete(assignmentTasks).where(eq(assignmentTasks.taskId, row.taskId)).run();
            else
                return undefined;
            return { next };
        }, { behavior: 'immediate' });
        if (!written)
            return skipped;
        if (written.next)
            this.assigners.set(sessionId, written.next.assignerAgentName);
        else
            this.assigners.delete(sessionId);
        if (this.touchSession(sessionId, nowMs) === 0) {
            if (written.next)
                this.compensate(sessionId, link !== undefined);
            return skipped;
        }
        return { ran: true, next: written.next };
    }
    sessionExists(sessionId) {
        return Boolean(this.options.sessions
            .select({ sessionId: sessions.sessionId })
            .from(sessions)
            .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
            .get());
    }
    /** Rows refreshed; undefined when the refresh failed and the result is unknown. */
    touchSession(sessionId, nowMs) {
        try {
            return this.options.sessions
                .update(sessions)
                .set({ updatedAtMs: nowMs })
                .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
                .run().changes;
        }
        catch (error) {
            this.logger.warn({ sessionId, error: error instanceof Error ? error.message : String(error) }, 'Assignment task written but the Session updatedAtMs refresh failed');
            return undefined;
        }
    }
    /** The Session was deleted mid-transition: drop the orphan task (idempotent). */
    compensate(sessionId, linked) {
        this.options.db.transaction((tx) => {
            tx.delete(assignmentTasks).where(eq(assignmentTasks.sessionId, sessionId)).run();
            if (linked)
                tx.delete(bunnySpaceSessions).where(eq(bunnySpaceSessions.sessionId, sessionId)).run();
        }, { behavior: 'immediate' });
        this.assigners.delete(sessionId);
    }
    /** Shared-database order facts of the Sessions that still exist, by id. */
    sessionOrder(sessionIds, archived) {
        const order = new Map();
        for (const chunk of chunks([...new Set(sessionIds)]))
            for (const row of this.options.sessions
                .select({
                sessionId: sessions.sessionId,
                updatedAtMs: sessions.updatedAtMs,
                createdAtMs: sessions.createdAtMs,
            })
                .from(sessions)
                .where(and(inArray(sessions.sessionId, chunk), eq(sessions.columnarVersion, 3), archived === undefined ? undefined : eq(sessions.archived, archived ? 1 : 0)))
                .all())
                order.set(row.sessionId, row);
        return order;
    }
}
/** `updated_at_ms DESC, created_at_ms DESC, session_id ASC`, with SQLite's NULL-last DESC. */
function compareSessions(a, b) {
    return (b.updatedAtMs - a.updatedAtMs ||
        (b.createdAtMs ?? -Infinity) - (a.createdAtMs ?? -Infinity) ||
        compareIds(a.sessionId, b.sessionId));
}
function compareIds(a, b) {
    if (a === b)
        return 0;
    return a < b ? -1 : 1;
}
function chunks(values) {
    const result = [];
    for (let index = 0; index < values.length; index += EVENT_CHUNK)
        result.push(values.slice(index, index + EVENT_CHUNK));
    return result;
}
function linkSpace(tx, sessionId, spaceId, nowMs) {
    tx.insert(bunnySpaceSessions)
        .values({ sessionId, spaceId, createdAtMs: nowMs })
        .onConflictDoUpdate({ target: bunnySpaceSessions.sessionId, set: { spaceId } })
        .run();
}
/** Writes the task row and its history; returns the history events it wrote. */
function writeTask(db, write) {
    const { sessionId, row, current, next, nowMs } = write;
    const columns = encodeAssignmentTask(next);
    const taskId = row?.taskId ?? assignmentTaskId(sessionId);
    if (row)
        db.update(assignmentTasks)
            .set({
            ...columns,
            revision: row.revision + 1,
            updatedAtMs: Math.max(nowMs, row.createdAtMs),
        })
            .where(eq(assignmentTasks.taskId, taskId))
            .run();
    else
        db.insert(assignmentTasks)
            .values({
            ...columns,
            taskId,
            sessionId,
            revision: 0,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
        })
            .run();
    const written = [];
    const insert = (event) => {
        const { seq } = db
            .insert(assignmentTaskEvents)
            .values({ taskId, createdAtMs: nowMs, ...event })
            .returning({ seq: assignmentTaskEvents.seq })
            .get();
        written.push({
            seq,
            taskId,
            sessionId,
            type: event.type,
            payload: event.payload,
            createdAtMs: nowMs,
            assignerSessionId: next.assignerSessionId,
            assignerAgentName: next.assignerAgentName,
        });
    };
    if (!sameReviewRetries(current?.reviewRetries, next.reviewRetries))
        insert(retryEvent(next.reviewRetries));
    const details = taskDetails(next);
    if (!sameTaskDetails(taskDetails(current), details))
        insert({ type: TASK_DETAILS_SET, payload: { details } });
    const events = diffTaskEvents({
        kind: write.kind,
        current,
        next,
        note: write.note,
        nowMs,
        closeStats: () => {
            const openedAtMs = row?.createdAtMs ?? nowMs;
            return closeStats(db, {
                taskId,
                openedAtMs,
                userMessages: write.userMessages(openedAtMs),
                totalTokens: write.totalTokens(openedAtMs),
            });
        },
    });
    for (const event of events)
        insert(event);
    return written;
}
/**
 * Rounds and user rounds are counted from the task's own round history in the
 * Bunny store; the user message count comes from the shared database.
 */
function closeStats(db, task) {
    const { taskId, openedAtMs, userMessages, totalTokens } = task;
    const rounds = db
        .select({ payload: assignmentTaskEvents.payload })
        .from(assignmentTaskEvents)
        .where(and(eq(assignmentTaskEvents.taskId, taskId), eq(assignmentTaskEvents.type, TASK_ROUND_ENDED)))
        .all();
    return {
        rounds: rounds.length,
        userTurns: rounds.filter(({ payload }) => payload.initiator === 'user').length,
        userMessages,
        openedAtMs,
        totalTokens,
    };
}
/**
 * Input + output tokens recorded for the task session since it opened, every round and
 * whoever started it; one indexed aggregate read, made only when the task closes.
 */
function taskTokenTotal(db, task) {
    const row = db
        .select({
        total: sql `coalesce(sum(${tokenUsage.inputTokens} + ${tokenUsage.outputTokens}), 0)`,
    })
        .from(tokenUsage)
        .where(and(eq(tokenUsage.sessionId, task.sessionId), gte(tokenUsage.timestamp, task.openedAtMs)))
        .get();
    return Number(row?.total ?? 0);
}
/**
 * Messages the person typed into the task session since it opened, including
 * ones merged into a running turn. Messages carrying an assignment origin
 * (the assigner's create/send) and permission replies are not the person's.
 */
function userMessageCount(db, task) {
    return db
        .select({ context: messageRows.sourceContextJson })
        .from(messageRows)
        .where(and(eq(messageRows.sessionId, task.sessionId), eq(messageRows.role, 'user'), gte(messageRows.createdAtMs, task.openedAtMs), or(inArray(messageRows.source, [...USER_TYPED_SOURCES]), like(messageRows.source, 'channel:%')), sql `instr(${messageRows.dataJson}, '<permission-response>') = 0`))
        .all()
        .filter(({ context }) => !hasAssignmentOrigin(context)).length;
}
/** Sources of input typed by the person; agent, cron and system sources are not. */
const USER_TYPED_SOURCES = new Set([
    'api',
    'conversation-mutation',
    'miniapp',
    'code_review',
    'channel',
]);
function hasAssignmentOrigin(contextJson) {
    if (!contextJson)
        return false;
    try {
        const context = JSON.parse(contextJson);
        return Boolean(context?.origin?.assignment);
    }
    catch {
        return false;
    }
}
function retryEvent(retries) {
    return retries
        ? {
            type: REVIEW_REDELIVERED,
            payload: { reportKey: retries.reportKey, attempt: retries.count },
        }
        : { type: REVIEW_RETRIES_SET, payload: { reviewRetries: null } };
}
function readOne(db, sessionId) {
    const row = selectTask(db, sessionId);
    return row ? decodeAssignmentTask(row, readFacts(db, row.taskId)) : undefined;
}
function selectTask(db, sessionId) {
    return db.select().from(assignmentTasks).where(eq(assignmentTasks.sessionId, sessionId)).get();
}
function readFacts(db, taskId) {
    return projectTaskFacts(projectedEvents(db, [taskId]));
}
function projectedEvents(db, taskIds) {
    const events = [];
    for (let index = 0; index < taskIds.length; index += EVENT_CHUNK)
        events.push(...db
            .select({
            taskId: assignmentTaskEvents.taskId,
            type: assignmentTaskEvents.type,
            payload: assignmentTaskEvents.payload,
            seq: assignmentTaskEvents.seq,
        })
            .from(assignmentTaskEvents)
            .where(and(inArray(assignmentTaskEvents.taskId, taskIds.slice(index, index + EVENT_CHUNK)), inArray(assignmentTaskEvents.type, [...PROJECTED_EVENT_TYPES])))
            .orderBy(asc(assignmentTaskEvents.seq))
            .all());
    return events;
}
function decodeRows(db, rows) {
    if (!rows.length)
        return [];
    const byTask = new Map();
    for (const event of projectedEvents(db, rows.map((row) => row.taskId))) {
        const list = byTask.get(event.taskId) ?? [];
        list.push(event);
        byTask.set(event.taskId, list);
    }
    return rows.map((row) => ({
        sessionId: row.sessionId,
        assignment: decodeAssignmentTask(row, projectTaskFacts(byTask.get(row.taskId) ?? [])),
    }));
}
/** Task-side filters, applied in the Bunny store. */
function listPredicates(options) {
    // `archived` is a Session fact, filtered in `sessionOrder`.
    return [
        options.assignerAgentName === undefined
            ? undefined
            : eq(assignmentTasks.assignerAgentName, options.assignerAgentName),
        options.assignerSessionId === undefined
            ? undefined
            : assignerSessionPredicate(options.assignerSessionId),
        options.reviewSessionId === undefined
            ? undefined
            : eq(assignmentTasks.reviewSessionId, options.reviewSessionId),
        options.pendingStart ? isNotNull(assignmentTasks.pendingStartQueuedAtMs) : undefined,
        options.request
            ? and(eq(assignmentTasks.requestAssignerSessionId, options.request.assignerSessionId), eq(assignmentTasks.requestId, options.request.requestId))
            : undefined,
    ];
}
/**
 * The assigner Session filter, chunked the way every other id-set read here is:
 * one `IN` list per {@link ASSIGNER_CHUNK} ids keeps the statement under the
 * SQLite bound-parameter ceiling however wide a coordinator's closure grew.
 * No id at all matches nothing, never everything.
 */
function assignerSessionPredicate(value) {
    const ids = typeof value === 'string' ? [value] : [...new Set(value)];
    if (ids.length === 0)
        return sql `0`;
    const parts = [];
    for (let index = 0; index < ids.length; index += ASSIGNER_CHUNK) {
        parts.push(inArray(assignmentTasks.assignerSessionId, ids.slice(index, index + ASSIGNER_CHUNK)));
    }
    const [first, ...rest] = parts;
    if (!first)
        return sql `0`;
    return rest.length === 0 ? first : (or(first, ...rest) ?? first);
}
//# sourceMappingURL=drizzle.js.map