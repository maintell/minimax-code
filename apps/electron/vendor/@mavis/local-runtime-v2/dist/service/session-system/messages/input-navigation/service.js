import { Buffer } from 'node:buffer';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { messageRows, sessionAssets } from '../../../../infra/db/schema/messages.js';
import { SessionInputSummaryServiceError } from './errors.js';
import { isNavigableUserInput, projectNavigationText, takeUnicodeCodePoints } from './text.js';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;
const CONTENT_HEAD_CODE_POINTS = 200;
/** Native v2 input-navigation policy over v2 display rows and asset projections. */
export class SessionInputSummaryService {
    options;
    constructor(options) {
        this.options = options;
    }
    async list(input) {
        const pagination = normalizePagination(input);
        const beforeRowId = pagination.before
            ? decodeCursor(input.sessionId, pagination.before)
            : undefined;
        await this.options.readiness.ensureDisplayReady(input.sessionId);
        if (!(await this.options.sessions.get(input.sessionId))) {
            throw new SessionInputSummaryServiceError('session-not-found', `Session not found: ${input.sessionId}`);
        }
        const [, diffs] = await Promise.all([
            this.options.readiness.ensureAssetsReady(input.sessionId),
            this.options.diffs.listSessionDiffs(input.sessionId),
        ]);
        return this.options.db.transaction((tx) => {
            const snapshot = readSnapshot(tx, input.sessionId);
            const summaries = buildSummaries(snapshot.messages, snapshot.assets, diffs);
            const page = toPage(input.sessionId, summaries, pagination.limit, beforeRowId);
            return withContentHeads(tx, input.sessionId, page);
        });
    }
}
function readSnapshot(db, sessionId) {
    return {
        messages: db
            .select({
            id: messageRows.id,
            messageId: messageRows.messageId,
            role: messageRows.role,
            source: messageRows.source,
            createdAtMs: messageRows.createdAtMs,
            // Interval boundaries need user text, but never tool payloads or assistant bodies.
            dataJson: sql `CASE WHEN json_valid(${messageRows.dataJson}) THEN
          CASE WHEN json_type(${messageRows.dataJson}) = 'object' THEN json_object(
            'role', json_extract(${messageRows.dataJson}, '$.role'),
            'source', json_extract(${messageRows.dataJson}, '$.source'),
            'kind', json_extract(${messageRows.dataJson}, '$.kind'),
            'displayKind', json_extract(${messageRows.dataJson}, '$.displayKind'),
            'msg_content', CASE WHEN coalesce(nullif(${messageRows.role}, ''),
              json_extract(${messageRows.dataJson}, '$.role')) = 'user'
              THEN json_extract(${messageRows.dataJson}, '$.msg_content') END,
            'msgContent', CASE WHEN coalesce(nullif(${messageRows.role}, ''),
              json_extract(${messageRows.dataJson}, '$.role')) = 'user'
              THEN json_extract(${messageRows.dataJson}, '$.msgContent') END
          ) END END`,
        })
            .from(messageRows)
            .where(eq(messageRows.sessionId, sessionId))
            .orderBy(asc(messageRows.id))
            .all(),
        assets: db
            .select({
            messageRowId: messageRows.id,
            messageId: sessionAssets.messageId,
            messageCreatedAtMs: sessionAssets.messageCreatedAtMs,
            assetIndex: sessionAssets.assetIndex,
            assetKey: sessionAssets.assetKey,
            sourceTag: sessionAssets.sourceTag,
            path: sessionAssets.path,
            name: sessionAssets.name,
            assetType: sessionAssets.assetType,
            dataJson: sessionAssets.dataJson,
        })
            .from(sessionAssets)
            .innerJoin(messageRows, and(eq(messageRows.sessionId, sessionAssets.sessionId), eq(messageRows.messageId, sessionAssets.messageId)))
            .where(eq(sessionAssets.sessionId, sessionId))
            .orderBy(asc(messageRows.id), asc(sessionAssets.assetIndex), asc(sessionAssets.id))
            .all(),
    };
}
function withContentHeads(db, sessionId, page) {
    const messageIds = page.summaries.flatMap((summary) => [
        summary.userInput.msgId,
        ...(summary.assistantResponse ? [summary.assistantResponse.msgId] : []),
    ]);
    if (messageIds.length === 0)
        return page;
    const rows = db
        .select({
        messageId: messageRows.messageId,
        contentJson: sql `json_extract(${messageRows.dataJson}, '$.msg_content', '$.msgContent')`,
    })
        .from(messageRows)
        .where(and(eq(messageRows.sessionId, sessionId), inArray(messageRows.messageId, messageIds)))
        .all();
    const contentHeads = new Map(rows.map((row) => {
        const [snakeContent, camelContent] = JSON.parse(row.contentJson);
        const content = snakeContent ?? camelContent;
        const contentHead = takeUnicodeCodePoints(projectNavigationText({ msg_content: typeof content === 'string' ? content : '' }), CONTENT_HEAD_CODE_POINTS);
        return [row.messageId, contentHead];
    }));
    const withHead = (head) => {
        const contentHead = contentHeads.get(head.msgId);
        return { ...head, ...(contentHead ? { contentHead } : {}) };
    };
    return {
        ...page,
        summaries: page.summaries.map((summary) => ({
            ...summary,
            userInput: withHead(summary.userInput),
            ...(summary.assistantResponse
                ? { assistantResponse: withHead(summary.assistantResponse) }
                : {}),
        })),
    };
}
function buildSummaries(rows, assets, diffs) {
    const assetsByRowId = groupByMessageRow(assets);
    const filesByRowId = groupDiffFiles(rows, diffs);
    const state = rows.reduce((currentState, row) => reduceMessageRow(currentState, row, assetsByRowId, filesByRowId), {
        completed: [],
    });
    const all = state.current ? [...state.completed, state.current] : state.completed;
    return all.map(finishSummary);
}
function reduceMessageRow(state, row, assetsByRowId, filesByRowId) {
    const message = parseMessage(row);
    if (!message)
        return state;
    const next = isNavigableUserInput(message)
        ? {
            completed: state.current ? [...state.completed, state.current] : state.completed,
            current: newMutableSummary(messageHead(row)),
        }
        : state;
    if (!next.current)
        return next;
    if (message.role === 'assistant') {
        updateAssistantBoundary(next.current, row, message);
    }
    assetsByRowId
        .get(row.id)
        ?.forEach((asset) => next.current?.artifactsByKey.set(asset.assetKey, asset));
    filesByRowId.get(row.id)?.forEach((file) => next.current?.fileChangePaths.add(file));
    return next;
}
function updateAssistantBoundary(summary, row, message) {
    if (message.kind != null || message.displayKind != null)
        return;
    summary.assistantResponse = messageHead(row);
}
function newMutableSummary(userInput) {
    return {
        userInput,
        artifactsByKey: new Map(),
        fileChangePaths: new Set(),
    };
}
function groupByMessageRow(assets) {
    return assets.reduce((grouped, asset) => {
        const existing = grouped.get(asset.messageRowId);
        if (existing)
            existing.push(asset);
        else
            grouped.set(asset.messageRowId, [asset]);
        return grouped;
    }, new Map());
}
function groupDiffFiles(rows, diffs) {
    const rowIdByMessageId = new Map(rows.map((row) => [row.messageId, row.id]));
    return diffs.reduce((grouped, diff) => {
        const rowId = diff.assistantMessageId
            ? rowIdByMessageId.get(diff.assistantMessageId)
            : undefined;
        if (rowId === undefined)
            return grouped;
        const paths = diff.filePaths.map((file) => file.trim()).filter(Boolean);
        const existing = grouped.get(rowId);
        if (existing)
            existing.push(...paths);
        else if (paths.length > 0)
            grouped.set(rowId, paths);
        return grouped;
    }, new Map());
}
function parseMessage(row) {
    try {
        const parsed = row.dataJson === null ? undefined : JSON.parse(row.dataJson);
        if (!isRecord(parsed))
            return undefined;
        const legacySource = typeof parsed.source === 'string' ? parsed.source : undefined;
        const message = { ...parsed, msg_id: row.messageId };
        delete message.source;
        delete message.sourceContext;
        if (row.role)
            message.role = row.role;
        const source = row.source ?? legacySource;
        if (source)
            message.source = source;
        return message;
    }
    catch {
        return undefined;
    }
}
function messageHead(row) {
    return {
        messageRowId: row.id,
        msgId: row.messageId,
        timestamp: row.createdAtMs,
    };
}
function finishSummary(summary) {
    return {
        userInput: summary.userInput,
        ...(summary.assistantResponse ? { assistantResponse: summary.assistantResponse } : {}),
        artifacts: [...summary.artifactsByKey.values()].sort((left, right) => left.messageRowId - right.messageRowId || left.assetIndex - right.assetIndex),
        fileChangeCount: summary.fileChangePaths.size,
    };
}
function toPage(sessionId, summaries, limit, beforeRowId) {
    const end = exclusiveEndIndex(summaries, beforeRowId);
    const start = Math.max(0, end - limit);
    const selected = summaries.slice(start, end);
    const hasMore = start > 0;
    return {
        summaries: selected.map(toPublicSummary),
        total: summaries.length,
        hasMore,
        ...(hasMore && selected[0]
            ? { nextCursor: encodeCursor(sessionId, selected[0].userInput.messageRowId) }
            : {}),
    };
}
function exclusiveEndIndex(summaries, beforeRowId) {
    if (beforeRowId === undefined)
        return summaries.length;
    const found = summaries.findIndex((summary) => summary.userInput.messageRowId >= beforeRowId);
    return found < 0 ? summaries.length : found;
}
function toPublicSummary(summary) {
    return {
        userInput: withoutRowId(summary.userInput),
        ...(summary.assistantResponse
            ? { assistantResponse: withoutRowId(summary.assistantResponse) }
            : {}),
        artifacts: summary.artifacts.map(withoutAssetRowId),
        fileChangeCount: summary.fileChangeCount,
    };
}
function withoutAssetRowId(asset) {
    return {
        messageId: asset.messageId,
        messageCreatedAtMs: asset.messageCreatedAtMs,
        assetIndex: asset.assetIndex,
        assetKey: asset.assetKey,
        sourceTag: asset.sourceTag,
        path: asset.path,
        name: asset.name,
        assetType: asset.assetType,
        dataJson: asset.dataJson,
    };
}
function withoutRowId(head) {
    return {
        msgId: head.msgId,
        timestamp: head.timestamp,
        ...(head.contentHead ? { contentHead: head.contentHead } : {}),
    };
}
function normalizePagination(input) {
    const requested = input.limit ?? DEFAULT_LIMIT;
    const limit = Math.floor(requested);
    if (!Number.isFinite(requested) || limit <= 0) {
        throw new SessionInputSummaryServiceError('invalid-request', 'limit must be greater than 0');
    }
    if (input.before !== undefined && input.before.length === 0) {
        throw new SessionInputSummaryServiceError('invalid-request', 'before cursor must not be empty');
    }
    return {
        limit: Math.min(limit, MAX_LIMIT),
        ...(input.before !== undefined ? { before: input.before } : {}),
    };
}
function encodeCursor(sessionId, beforeRowId) {
    return Buffer.from(JSON.stringify({ version: 1, sessionId, beforeRowId }), 'utf8').toString('base64url');
}
function decodeCursor(sessionId, cursor) {
    try {
        const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!isValidCursor(payload, sessionId))
            throw new Error('invalid cursor');
        return payload.beforeRowId;
    }
    catch {
        throw new SessionInputSummaryServiceError('invalid-request', 'invalid before cursor');
    }
}
function isValidCursor(value, sessionId) {
    return (isRecord(value) &&
        value.version === 1 &&
        value.sessionId === sessionId &&
        typeof value.beforeRowId === 'number' &&
        Number.isSafeInteger(value.beforeRowId) &&
        value.beforeRowId > 0);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=service.js.map