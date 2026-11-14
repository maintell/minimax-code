import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { renderTaskSnapshot, } from '../../service/assignment/index.js';
import {} from '../../service/bunny/index.js';
import { indexedAttachmentAssetId, spaceContextExcerpt, } from '../../service/session-system/index.js';
import { defaultSegmentRecordFacts, isStateDeltaMessage, resolveMessageAuthorship, } from '../../service/turn-system/index.js';
import { isInjectedWorkingStateEntry, } from '../../service/working-state/index.js';
/**
 * The Bunny features segment compaction reads and writes (spec 9, 11.7, 12.9,
 * 15.2): the working-state ledger, the delta-block test, the
 * materialized task state, the spaces' context.md, the conversation search index and
 * the display message IDs records are cited by.
 */
export function createBunnyCompactionFeatures(input) {
    return {
        ledger: workingStateLedger(input.workingState, input.nowMs),
        deltaBlocks: { isDeltaBlock: isStateDeltaMessage },
        status: taskStateSnapshot(input),
        spaces: spaceHighlights(input),
        searchIndex: conversationSearchIndex(input.conversationSearch),
        recordFacts: displayRecordFacts(input.messages),
    };
}
/**
 * The header's task snapshot from the materialized view; its read time is the cutoff (9.5, 12.9).
 * @internal Exported only for focused tests.
 */
export function taskStateSnapshot(input) {
    return {
        readSnapshot: async () => {
            const [view, spaces] = await Promise.all([input.stateView.read(), input.worklines.list()]);
            const names = new Map(spaces.map((space) => [space.id, space.name]));
            // A view never loaded has no read time of its own.
            return {
                lines: renderTaskSnapshot(view, names),
                cutoffAtMs: view.asOfMs > 0 ? view.asOfMs : input.nowMs(),
            };
        },
    };
}
/**
 * Covered records are cited by the IDs of the messages the user sees (12.3), so
 * the ledger accepts a source that is one of Bunny's replies, `send_to_user`
 * content included. A user record's canonical ID is its display ID already; an
 * assistant record maps through the canonical ID its display row carries. A
 * record without a display row keeps its own ID.
 *
 * A user record counts as the user's words by its producer, the source and
 * origin its display row keeps (12.4), judged the way the wake reasons are.
 * Its attachments go by the asset IDs its display row carries, the handle
 * search, `conversation_read` and Bunny's read share (12.6, 15.5).
 * @internal Exported only for focused tests.
 */
export function displayRecordFacts(messages) {
    return {
        resolve: async (sessionId, records) => {
            const turns = new Set(records
                .filter((record) => record.message.role === 'assistant' || record.message.role === 'user')
                .map((record) => record.turnId));
            const rows = await Promise.all([...turns].map((turnId) => messages.listTurn(sessionId, turnId)));
            const displayIds = new Map();
            const userRows = new Map();
            for (const row of rows.flat()) {
                if (row.role === 'assistant' && row.canonical_message_id && row.msg_id)
                    displayIds.set(row.canonical_message_id, row.msg_id);
                if (row.role === 'user' && row.msg_id)
                    userRows.set(row.msg_id, row);
            }
            return {
                displayMessageId: (record) => displayIds.get(record.messageId) ?? record.messageId,
                classifyUser: (record) => classifyByProducer(userRows.get(record.messageId), defaultSegmentRecordFacts.classifyUser(record)),
                assetsOf: (record) => {
                    const row = userRows.get(record.messageId);
                    return defaultSegmentRecordFacts.assetsOf(record).map((asset) => {
                        const assetId = row && indexedAttachmentAssetId(row, asset.assetId);
                        return assetId ? { ...asset, assetId } : asset;
                    });
                },
            };
        },
    };
}
/**
 * Typed messages and questionnaire answers are the user's words; cron, system
 * messages, note hand-offs, assignment hand-overs and reports are not. The
 * content only says whether a typed message has words left and whether a
 * system message is a report to reduce. A record without a display row keeps
 * its content classification.
 */
function classifyByProducer(row, content) {
    if (!row?.source)
        return content;
    const authorship = resolveMessageAuthorship({
        source: row.source,
        origin: row.sourceContext?.['origin'],
    });
    if (authorship === 'questionnaire_answer')
        return 'questionnaire';
    if (authorship === 'system')
        return content === 'report' ? 'report' : 'system';
    return content === 'system' ? 'system' : 'typed';
}
/**
 * The working-state ledger; its own header rendering and handoff marks (13.4, 11.7).
 * @internal Exported only for focused tests.
 */
export function workingStateLedger(service, nowMs) {
    const injected = (entries) => entries.filter((entry) => isInjectedWorkingStateEntry(entry, nowMs())).map(ledgerView);
    return {
        readRevision: async () => String(service.revision()),
        listEntries: async () => injected(service.list()),
        listWrittenNotInHeader: async () => injected(service.pendingHandoffEntries()),
        applyCompactorDelta: async (input) => applyLedgerDelta(service, input),
        markInHeader: async (_sessionId, entryIds) => service.markInHandoff(entryIds),
        renderHeader: async (_sessionId, budgetTokens) => {
            const section = service.renderHeader(budgetTokens);
            return { text: section.text, entryIds: section.entryIds, truncated: section.truncated };
        },
    };
}
function ledgerView(entry) {
    return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        text: entry.text,
        status: entry.status,
        createdAtMs: entry.createdAtMs,
        ...(entry.closedAtMs === undefined ? {} : { closedAtMs: entry.closedAtMs }),
    };
}
/**
 * One ledger transaction per compaction. The ledger forms operation IDs from the
 * batch ID and the operation's position, so every operation keeps its position:
 * one that cannot apply is passed on in a form the ledger drops with a reason.
 */
function applyLedgerDelta(service, input) {
    const result = service.applyCompactorDelta({
        batchId: input.batchId,
        sessionId: input.sessionId,
        coveredMessageIds: input.coveredMessageIds,
        baseRevision: Number(input.expectedRevision),
        operations: input.operations.map((operation) => toWorkingStateOperation(service, operation)),
    });
    const dropped = new Map(result.drops.map((drop) => [drop.index, drop.reason]));
    return {
        applied: input.operations
            .filter((_operation, index) => !dropped.has(index))
            .map((operation) => operation.operationId),
        skipped: input.operations.flatMap((operation, index) => {
            const reason = dropped.get(index);
            return reason ? [{ operationId: operation.operationId, reason }] : [];
        }),
        revisionChanged: result.revisionChanged,
    };
}
/**
 * An `update` replaces an active entry with a new one of the same kind, scope,
 * rejected way and expiry; the compactor only rewords it (13.2, 13.3).
 */
function toWorkingStateOperation(service, operation) {
    const sourceMessageId = operation.sourceMessageId ?? '';
    if (operation.op === 'add') {
        return {
            op: 'add',
            kind: operation.kind,
            scope: operation.scope,
            text: operation.text,
            ...(operation.replaces === undefined ? {} : { replaces: operation.replaces }),
            sourceMessageId,
        };
    }
    if (operation.op === 'close') {
        return {
            op: 'close',
            entryId: operation.entryId,
            reason: operation.reason,
            ...(operation.note === undefined ? {} : { note: operation.note }),
            sourceMessageId,
        };
    }
    const target = activeEntry(service, operation.entryId);
    if (!target) {
        // The ledger drops a close of an entry that is not active as `target-not-active`.
        return { op: 'close', entryId: operation.entryId, reason: 'done', sourceMessageId };
    }
    return {
        op: 'add',
        kind: target.kind,
        scope: target.scope,
        text: operation.text,
        ...(target.replaces === undefined ? {} : { replaces: target.replaces }),
        ...(target.expiresAtMs === undefined ? {} : { expiresAtMs: target.expiresAtMs }),
        supersedes: target.id,
        sourceMessageId,
    };
}
function activeEntry(service, id) {
    try {
        const entry = service.get(id);
        return entry.status === 'active' ? entry : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Spaces with open tasks carry their goal and the context.md summary (12.9).
 * @internal Exported only for focused tests.
 */
export function spaceHighlights(input) {
    return {
        listSpaces: async () => {
            const [spaces, tasks] = await Promise.all([
                input.worklines.list(),
                input.assignments.list(BUNNY_AGENT_NAME, 10_000),
            ]);
            return spaces.map((space) => {
                const open = tasks.filter((task) => task.worklineId === space.id && !task.assignment?.completion);
                const identity = {
                    ...spaceIdentity(space),
                    lastActiveAtMs: Math.max(space.updatedAt, ...open.map(taskActivityAtMs)),
                    ...(space.system ? { system: true } : {}),
                    goal: space.goal ?? '',
                };
                if (open.length === 0 || space.system)
                    return {
                        ...identity,
                        hasOpenTasks: open.length > 0,
                        revision: '',
                        excerpt: () => '',
                    };
                const context = readSummary(input.worklines, space.id);
                return {
                    ...identity,
                    hasOpenTasks: true,
                    revision: context.revision,
                    excerpt: (limit) => (context.summary ? spaceContextExcerpt(context.summary, limit) : ''),
                };
            });
        },
    };
}
/** A space whose context.md cannot be read is listed without its summary. */
function readSummary(worklines, spaceId) {
    try {
        const { summary, revision } = worklines.readContext(spaceId);
        return { summary, revision };
    }
    catch {
        return { summary: '', revision: '' };
    }
}
function spaceIdentity(space) {
    return { spaceId: space.id, name: space.name };
}
function taskActivityAtMs(task) {
    return task.session.updatedAtMs ?? 0;
}
/** Messages whose attachments were just described are indexed again (12.6, 15.2). */
function conversationSearchIndex(search) {
    return {
        writeMediaDescriptions: async (sessionId, items) => {
            search.indexMessages(sessionId, items.map((item) => item.messageId));
        },
    };
}
/** The header that opens the current segment, for issue feedback (13.9). */
export async function readHandoffHeader(history, sessionId) {
    const segment = await history.readSegment(sessionId);
    if (!segment.segmentId)
        return undefined;
    const header = segment.records[0]?.message;
    return header?.role === 'compactionSummary' && typeof header.summary === 'string'
        ? header.summary
        : undefined;
}
//# sourceMappingURL=bunny-compaction-features.js.map