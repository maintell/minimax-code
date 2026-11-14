import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { usesSegmentContextProfile } from '@mavis/shared/agent-coordination';
import { isUserMessageId } from '../../../session-system/index.js';
import { resolveMessageAuthorship } from '../../execution/message-query-authorship.js';
/** The diagnostics records of the context resets, next to the Session's history (context reset spec 7.4). */
const RECORDS_FILE = 'bunny-context-reset.jsonl';
/** Display kind of the separator a reset leaves in the conversation (6.1). */
const CONTEXT_RESET_DISPLAY_KIND = 'context_reset';
/** The separator's text where a client shows no text of its own (6.1). */
const CONTEXT_RESET_SEPARATOR_TEXT = '上下文已重新开始 · 记忆、空间和任务保留';
/** Display rows read at a time while looking back for the coordinator's last visible words (4.2). */
const UNREPLIED_PAGE_ROWS = 500;
/** Display rows of user input that never reached the conversation. */
const UNDELIVERED_KINDS = new Set(['input_rejected', 'undelivered_user']);
/**
 * The Sessions a context reset applies to (context reset spec 1.1): Bunny's
 * main conversation, a root conversation of an Agent on the segment profile
 * that is not archived. Side chats keep the default.
 */
export function contextResetSessions(sessions) {
    return {
        eligible: async (sessionId) => {
            if (sessions.sideChats.relation(sessionId) !== undefined)
                return false;
            const session = await sessions.sessions.repository.get(sessionId);
            if (!session || session.archived || session.sessionType !== 'root')
                return false;
            const coordination = sessions.coordinatorOwnership.roster.coordinationOf(session.agentName);
            return usesSegmentContextProfile(coordination);
        },
    };
}
/** What a context reset writes in production: history, separator, records (context reset spec 4 to 7). */
export function productionContextResetPort(sessions, 
/** The delivery baseline and frozen prefix of Bunny's state, bound after the Turn System. */
segmentReset) {
    // Read at call time: the repositories may be bound after the Turn System.
    const messages = () => sessions.repositories.messages;
    return {
        resetHistory: async (sessionId, input) => {
            const reset = await sessions.canonicalHistory.resetActive(sessionId, input);
            return { backupFile: reset.backupFile, messagesBefore: reset.messagesBefore };
        },
        restoreHistory: (sessionId, backupFile) => sessions.canonicalHistory.restoreResetBackup(sessionId, backupFile),
        unrepliedMessages: async (sessionId) => unrepliedMessages(await rowsSinceLastReply(messages(), sessionId)),
        writeSeparator: async (sessionId, input) => {
            await messages().upsert({
                sessionId,
                turnId: input.turnId,
                source: 'system',
                message: {
                    msg_id: `context-reset-${input.turnId}`,
                    role: 'system',
                    kind: CONTEXT_RESET_DISPLAY_KIND,
                    msg_content: CONTEXT_RESET_SEPARATOR_TEXT,
                    timestamp: input.timestampMs,
                },
            });
        },
        appendRecord: async (sessionId, record) => {
            const snapshots = await sessions.artifacts.inspectSnapshotsDirectory(sessionId);
            if (snapshots === undefined)
                throw new Error('The Session has no history directory.');
            const root = dirname(snapshots);
            await mkdir(root, { recursive: true });
            await appendFile(join(root, RECORDS_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
        },
        segmentReset: (sessionId) => segmentReset()?.(sessionId),
    };
}
/**
 * The display rows back to the page that holds the coordinator's last visible
 * words, or all of them: every message after those words gets listed (4.2).
 */
async function rowsSinceLastReply(messages, sessionId) {
    const pages = [];
    let before;
    for (;;) {
        const page = await messages.list(sessionId, {
            limit: UNREPLIED_PAGE_ROWS,
            ...(before ? { before } : {}),
        });
        pages.unshift(page.messages);
        if (!page.hasMore || !page.nextCursor || page.messages.some(isVisibleReply))
            break;
        before = page.nextCursor;
    }
    return pages.flat();
}
/**
 * The user's own messages after the coordinator's last visible words, as the
 * emergency rebuild finds them (context reset spec 4.2): typed messages,
 * interjections and questionnaire answers; task reports, timers and system
 * messages do not count.
 * @internal Exported only for focused tests.
 */
export function unrepliedMessages(rows) {
    const lastReply = rows.map(isVisibleReply).lastIndexOf(true);
    const unreplied = [];
    for (const row of rows.slice(lastReply + 1)) {
        const messageId = row.msg_id;
        if (!messageId || !isUserMessageId(messageId) || !isUsersOwnWords(row))
            continue;
        unreplied.push({
            messageId,
            text: stringField(row, 'msg_content') ?? stringField(row, 'editContent') ?? '',
        });
    }
    return unreplied;
}
/** A delivered user row the person wrote: typed, an interjection or a questionnaire answer. */
function isUsersOwnWords(row) {
    if (row.role !== 'user' || UNDELIVERED_KINDS.has(row.kind ?? ''))
        return false;
    const origin = row.sourceContext?.origin;
    return resolveMessageAuthorship({ source: row.source ?? '', origin }) !== 'system';
}
/** A display row with the coordinator's visible words: not tool calls only, an error row or a fact. */
function isVisibleReply(row) {
    return (row.role === 'assistant' &&
        row.kind === undefined &&
        row.finish_reason !== 'error' &&
        (stringField(row, 'msg_content')?.trim() ?? '') !== '');
}
function stringField(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
//# sourceMappingURL=context-reset.js.map