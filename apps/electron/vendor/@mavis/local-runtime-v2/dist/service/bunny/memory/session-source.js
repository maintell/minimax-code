import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import { sessions } from '../../../infra/db/schema/sessions.js';
import { messageRows } from '../../../infra/db/schema/messages.js';
import { readBunnyInitializedAt, readBunnyStoreCreatedAt, } from '../../../infra/db/bunny-store.js';
import { bunnyMemoryCursors } from '../../../infra/db/schema/bunny-store.js';
import { BUNNY_AGENT_NAME } from '../contracts.js';
import { assignedByBunnyCondition, readAssignerBySession, readBunnyAssignedSessionIds, } from '../../session-system/index.js';
import { redactMemorySecrets } from '../../memory-system/secret-redactor.js';
import { conversationToolEvent } from '../../coordinator-text/index.js';
import { sourcesIn } from './format.js';
function bunnyMemorySourceKind({ session: row, assigner }) {
    if (assigner === BUNNY_AGENT_NAME)
        return 'task';
    if (row.agentName === BUNNY_AGENT_NAME &&
        assigner === null &&
        !row.originCronId &&
        row.sessionKind === 'conversation' &&
        (row.sessionType === 'root' || Boolean(row.archived)))
        return 'main';
    return undefined;
}
export class BunnyMemorySessionSource {
    db;
    bunnyDb;
    nowMs;
    constructor(db, 
    /**
     * Bunny database: capture cursors, the initialization / store-created floors, and the
     * assignment tasks that make a Session a Bunny task.
     */
    bunnyDb, nowMs = Date.now) {
        this.db = db;
        this.bunnyDb = bunnyDb;
        this.nowMs = nowMs;
    }
    candidates() {
        const assigned = readBunnyAssignedSessionIds(this.bunnyDb);
        return this.sourceRows(or(eq(sessions.agentName, BUNNY_AGENT_NAME), assignedByBunnyCondition(assigned)))
            .filter((row) => this.afterInitialization(row.session) && bunnyMemorySourceKind(row))
            .map((row) => row.session);
    }
    /**
     * Session rows from the shared database, each with the assigner of its task. Tasks live in the
     * Bunny store, so the assigner is filled in from there instead of a join.
     */
    sourceRows(where) {
        const rows = this.db
            .select()
            .from(sessions)
            .where(where)
            .orderBy(asc(sessions.createdAtMs))
            .all();
        const assigners = rows.length
            ? readAssignerBySession(this.bunnyDb, rows.map((row) => row.sessionId))
            : new Map();
        return rows.map((session) => ({
            session,
            assigner: assigners.get(session.sessionId) ?? null,
        }));
    }
    sourceRow(sessionId) {
        return this.sourceRows(eq(sessions.sessionId, sessionId))[0];
    }
    /**
     * The row of a Session that can be a Bunny main conversation. Only Bunny's own
     * Sessions can, so every other Session is ruled out by the shared database
     * alone and the Bunny store is not read for it.
     */
    mainSourceRow(sessionId) {
        return this.sourceRows(and(eq(sessions.sessionId, sessionId), eq(sessions.agentName, BUNNY_AGENT_NAME)))[0];
    }
    afterInitialization(row) {
        return Boolean(row && row.purpose !== 'bunny-initialized' && (row.createdAtMs ?? 0) >= this.captureFloorMs());
    }
    /**
     * Sessions older than the Bunny database are never captured: a fresh database has
     * no cursors, so without this floor every old Session would be captured again.
     */
    captureFloorMs() {
        return Math.max(readBunnyInitializedAt(this.bunnyDb), readBunnyStoreCreatedAt(this.bunnyDb));
    }
    cursor(sessionId) {
        return (this.bunnyDb
            .select()
            .from(bunnyMemoryCursors)
            .where(eq(bunnyMemoryCursors.sessionId, sessionId))
            .get()?.throughRowId ?? 0);
    }
    advance(sessionId, throughRowId) {
        this.bunnyDb
            .insert(bunnyMemoryCursors)
            .values({ sessionId, throughRowId, updatedAtMs: this.nowMs() })
            .onConflictDoUpdate({
            target: bunnyMemoryCursors.sessionId,
            set: {
                throughRowId: sql `max(${bunnyMemoryCursors.throughRowId}, ${throughRowId})`,
                updatedAtMs: this.nowMs(),
            },
        })
            .run();
    }
    batch(sessionId, forgotten, cursor = this.cursor(sessionId), maxBytes = 160_000) {
        const source = this.sourceRow(sessionId);
        if (!source || !this.afterInitialization(source.session))
            return undefined;
        const kind = bunnyMemorySourceKind(source);
        if (!kind)
            return undefined;
        const rows = this.db
            .select()
            .from(messageRows)
            .where(eq(messageRows.sessionId, sessionId))
            .orderBy(asc(messageRows.id))
            .all();
        const filtered = kind === 'main' ? rows.filter(isMainMessage) : taskMessages(rows);
        const pending = filtered.filter((row) => row.id > cursor);
        const { selected, throughRowId: pendingThroughRowId } = selectPendingRows(pending, cursor, maxBytes);
        // Even ignored system/assignment messages are accounted for in the cursor.
        const throughRowId = !pending.length || pendingThroughRowId === pending.at(-1).id
            ? lastRowId(rows, cursor)
            : pendingThroughRowId;
        if (throughRowId <= cursor)
            return undefined;
        const context = filtered
            .filter((row) => row.id <= cursor && Buffer.byteLength(projectText(row)) <= maxBytes)
            .slice(-6);
        const forgottenSources = new Set(sourcesIn(forgotten));
        return {
            sessionId,
            throughRowId,
            messages: [...context, ...selected]
                .filter((row) => !forgottenSources.has(`${sessionId}/${row.messageId}`))
                .map((row) => project(row, cursor)),
        };
    }
    latestUser(sessionId) {
        const row = this.db
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.role, 'user'), eq(messageRows.source, 'api')))
            .orderBy(desc(messageRows.id))
            .limit(1)
            .get();
        return row ? project(row, 0) : undefined;
    }
    requireMain(sessionId) {
        const source = this.mainSourceRow(sessionId);
        const row = source?.session;
        if (!row ||
            row.archived ||
            row.sessionType !== 'root' ||
            bunnyMemorySourceKind(source) !== 'main')
            throw new Error('Only active Bunny main conversations can remember');
    }
    readMessage(sessionId, messageId) {
        if (!this.candidates().some((row) => row.sessionId === sessionId))
            throw new Error('Not a Bunny memory source');
        const rows = this.db
            .select()
            .from(messageRows)
            .where(eq(messageRows.sessionId, sessionId))
            .orderBy(asc(messageRows.id))
            .all();
        const index = rows.findIndex((row) => row.messageId === messageId);
        if (index < 0)
            throw new Error('Message not found');
        const allowed = bunnyMemorySourceKind(this.sourceRow(sessionId)) === 'task'
            ? taskMessages(rows)
            : rows.filter(isMainMessage);
        return rows
            .slice(Math.max(0, index - 1), index + 2)
            .filter((row) => allowed.includes(row))
            .map((row) => JSON.stringify(project(row, 0)))
            .join('\n');
    }
}
function selectPendingRows(pending, cursor, maxBytes) {
    const selected = [];
    let bytes = 0;
    let throughRowId = cursor;
    for (const row of pending) {
        const size = Buffer.byteLength(projectText(row));
        if (selected.length && bytes + size > maxBytes)
            break;
        throughRowId = row.id;
        // Accept an oversized first message alone; the next row starts another batch.
        selected.push(row);
        bytes += size;
    }
    return { selected, throughRowId };
}
function lastRowId(rows, fallback) {
    return rows.at(-1)?.id ?? fallback;
}
function isMainMessage(row) {
    if (row.role === 'user')
        return row.source === 'api' || row.source === 'questionnaire';
    return row.role === 'assistant' || row.role === 'tool' || row.role === 'toolResult';
}
function taskMessages(rows) {
    const allowed = new Set();
    rows.forEach((row, index) => {
        if (row.role !== 'user' || row.source !== 'api')
            return;
        allowed.add(row);
        const previous = rows
            .slice(0, index)
            .reverse()
            .find((value) => value.role === 'assistant');
        if (previous)
            allowed.add(previous);
    });
    return rows.filter((row) => allowed.has(row));
}
function project(row, cursor) {
    return {
        rowId: row.id,
        sessionId: row.sessionId,
        messageId: row.messageId,
        role: row.role ?? '',
        atMs: row.createdAtMs,
        text: redactMemorySecrets(projectText(row)).content,
        processed: row.id <= cursor,
    };
}
function projectText(row) {
    const data = JSON.parse(row.dataJson);
    const content = data.msg_content ?? data.msgContent ?? data.content ?? '';
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    // Questionnaires preserve questions and answers, not just the selected labels.
    if (row.role === 'tool' || row.role === 'toolResult')
        return text.replace(/\s+/gu, ' ').slice(0, 2000);
    if (data.msg_type === 3 || data.msgType === 3)
        return projectEvent(text);
    return text;
}
function projectEvent(text) {
    try {
        const event = JSON.parse(text);
        if (/questionnaire|ask_user/u.test(JSON.stringify(event)))
            return text;
        return conversationToolEvent(String(event.toolName ?? event.tool_name ?? event.eventType ?? '').slice(0, 100), text.replace(/\s+/gu, ' ').slice(0, 1600));
    }
    catch {
        return text.replace(/\s+/gu, ' ').slice(0, 2000);
    }
}
//# sourceMappingURL=session-source.js.map