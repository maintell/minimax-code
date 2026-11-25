import { hasTaskReport, readTaskReport, REPORT_DIGEST_UNKNOWN_TASK, reportDigestLine, TASK_REPORT_DONE_STATUS, taskReportBodies, } from '../../../../coordinator-text/index.js';
import { isStateDeltaMessage } from '@mavis/harness';
import { readGenuineUserQueryText } from '@mavis/harness/compaction';
/** Bunny's reply tool; its content is what Bunny said to the user (3.11). */
const SEND_TO_USER_TOOL_NAME = 'send_to_user';
/** Same test as the shared questionnaire helper: the text is an answer, not typing. */
const QUESTIONNAIRE_RESPONSE = /<questionnaire-response\b/u;
const WAKE_LINE = /^<wake\b[^>]*\/>\s*$/u;
/** Host reminder blocks the Host puts in front of a user's text. */
const LEADING_HOST_REMINDERS = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/u;
const ATTACHMENT_TAG = /<attachment name="([^"]*)" mime="[^"]*" path="([^"]*)"[^>]*kind="(image|video|text|file)"[^>]*>/gu;
/** Facts derivable from the records alone; the Host overrides display IDs and assets. */
export const defaultSegmentRecordFacts = {
    displayMessageId: (record) => record.messageId,
    isDeltaBlock: isStateDeltaMessage,
    classifyUser: classifyUserRecord,
    assetsOf: (record) => parseAttachmentAssets(userText(record.message)),
    reduceReport: (record, conclusions) => reduceTaskReport(userText(record.message), conclusions),
};
export function withSegmentRecordFacts(overrides) {
    return { ...defaultSegmentRecordFacts, ...overrides };
}
/** Plain text of a user, custom or summary record; blocks other than text are ignored. */
export function userText(message) {
    if (message.role === 'compactionSummary') {
        const summary = Reflect.get(message, 'summary');
        return typeof summary === 'string' ? summary : '';
    }
    const content = Reflect.get(message, 'content');
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .flatMap((block) => block && typeof block === 'object' && Reflect.get(block, 'type') === 'text'
        ? [String(Reflect.get(block, 'text') ?? '')]
        : [])
        .join('\n');
}
/**
 * A user's text without the host reminder blocks in front of it, the same
 * rule the scenario checks compare user text by; a same-named tag inside the
 * user's own text stays.
 */
function withoutLeadingHostReminders(text) {
    return text.replace(LEADING_HOST_REMINDERS, '');
}
/**
 * The user's own words of a message, the same for every user-words path of the
 * rebuild (12.4): the text the Host recorded as the user's (`canonicalTextRange`
 * or `genuineUserQueryText`), else the whole text, less wake lines and the host
 * reminders in front. The recorded range also leaves out host text that is not
 * a reminder block, such as the per-turn tool-calling note. An empty record
 * (a questionnaire answer has no typed query) falls back to the whole text.
 */
export function userWordsText(message) {
    const recorded = readGenuineUserQueryText(message);
    const lines = (recorded?.trim() ? recorded : userText(message))
        .split('\n')
        .filter((line) => !WAKE_LINE.test(line.trim()));
    return withoutLeadingHostReminders(lines.join('\n')).trim();
}
function classifyUserRecord(record) {
    const message = record.message;
    if (message.role !== 'user' || isHostUserRecord(message))
        return 'system';
    const text = userText(message);
    if (hasTaskReport(text))
        return 'report';
    if (QUESTIONNAIRE_RESPONSE.test(text))
        return 'questionnaire';
    if (hasEmptyGenuineQuery(message))
        return 'system';
    return userWordsText(message) ? 'typed' : 'system';
}
/** Compaction summaries and background-task deliveries are written by the Host. */
function isHostUserRecord(message) {
    if (Reflect.get(message, 'archonCompaction'))
        return true;
    const hostMetadata = Reflect.get(message, 'hostMetadata');
    return (!!hostMetadata &&
        typeof hostMetadata === 'object' &&
        Object.hasOwn(hostMetadata, 'backgroundTaskOrigin'));
}
function hasEmptyGenuineQuery(message) {
    if (!Object.hasOwn(message, 'genuineUserQueryText'))
        return false;
    const genuine = Reflect.get(message, 'genuineUserQueryText');
    return typeof genuine !== 'string' || !genuine.trim();
}
function parseAttachmentAssets(text) {
    return [...text.matchAll(ATTACHMENT_TAG)].map((match) => ({
        assetId: match[2] ?? '',
        name: match[1] ?? '',
        kind: (match[3] ?? 'file'),
    }));
}
/**
 * Whether each attachment of a user record was also sent inline as a media
 * block, in the order `assetsOf` lists them; the media blocks follow that order.
 */
export function inlineAttachmentFlags(message) {
    return [...userText(message).matchAll(ATTACHMENT_TAG)].map((match) => /\binline="true"/u.test(match[0]));
}
const SUMMARY_TOOL_NAME = 'assignment_summary';
/**
 * Every `<task-report>` of a delivery, one line each: the task ID and its card
 * conclusion (12.8). A delivery batches several reports into one message. A
 * task without a card conclusion yet keeps only its status; the final reply
 * is never kept.
 */
function reduceTaskReport(text, conclusions = new Map()) {
    const lines = taskReportBodies(text).map((body) => {
        const report = readTaskReport(body);
        const task = report.sessionId ?? REPORT_DIGEST_UNKNOWN_TASK;
        return reportDigestLine({
            task,
            title: report.title,
            conclusion: conclusions.get(task),
            status: report.status ?? TASK_REPORT_DONE_STATUS,
        });
    });
    return lines.length > 0 ? lines.join('\n') : undefined;
}
/**
 * Card conclusions by task ID from Bunny's `assignment_summary` calls in the
 * records; a failed call does not count and a later conclusion replaces an
 * earlier one.
 */
export function cardConclusions(records) {
    const failed = new Set(records.flatMap(({ message }) => message.role === 'toolResult' && message.isError ? [message.toolCallId] : []));
    const conclusions = new Map();
    for (const { message } of records) {
        if (message.role !== 'assistant')
            continue;
        for (const block of message.content) {
            if (block.type !== 'toolCall' || block.name !== SUMMARY_TOOL_NAME || failed.has(block.id))
                continue;
            for (const [task, summary] of summaryItems(block.arguments))
                conclusions.set(task, summary);
        }
    }
    return conclusions;
}
function summaryItems(args) {
    const items = args && typeof args === 'object' ? Reflect.get(args, 'items') : undefined;
    if (!Array.isArray(items))
        return [];
    return items.flatMap((item) => {
        if (!item || typeof item !== 'object')
            return [];
        const task = Reflect.get(item, 'session_id');
        const summary = Reflect.get(item, 'summary');
        return typeof task === 'string' && typeof summary === 'string' && summary.trim()
            ? [[task, summary.trim()]]
            : [];
    });
}
/** Each visible piece of an assistant record: plain text and `send_to_user` content. */
export function coordinatorVisibleTexts(message) {
    if (message.role !== 'assistant')
        return [];
    const content = Reflect.get(message, 'content');
    if (!Array.isArray(content))
        return [];
    return content.flatMap((block) => {
        if (!block || typeof block !== 'object')
            return [];
        const type = Reflect.get(block, 'type');
        if (type === 'text') {
            const text = String(Reflect.get(block, 'text') ?? '').trim();
            return text ? [text] : [];
        }
        if (type === 'toolCall' && Reflect.get(block, 'name') === SEND_TO_USER_TOOL_NAME) {
            const text = readSendToUserContent(Reflect.get(block, 'arguments'));
            return text ? [text] : [];
        }
        return [];
    });
}
function readSendToUserContent(args) {
    if (!args || typeof args !== 'object')
        return undefined;
    const content = Reflect.get(args, 'content');
    return typeof content === 'string' && content.trim() ? content.trim() : undefined;
}
/** IDs of the `send_to_user` calls whose receipts are not tool results (12.7). */
function sendToUserCallIds(records) {
    const ids = new Set();
    for (const { message } of records) {
        if (message.role !== 'assistant' || !Array.isArray(message.content))
            continue;
        for (const block of message.content) {
            if (block.type === 'toolCall' && block.name === SEND_TO_USER_TOOL_NAME)
                ids.add(block.id);
        }
    }
    return ids;
}
/**
 * Numbers every visible message of the covered range (12.3): the user's own
 * messages, reports reduced to their conclusion, and what Bunny said to the
 * user, `send_to_user` content included. Hidden and system records get no number.
 */
export function buildMessageIndex(records, facts) {
    const entries = [];
    const conclusions = cardConclusions(records);
    records.forEach((record, recordIndex) => {
        const { message } = record;
        const timestamp = readTimestamp(message);
        const push = (role, text) => entries.push({
            number: entries.length + 1,
            recordIndex,
            displayMessageId: facts.displayMessageId(record),
            role,
            text,
            ...(timestamp === undefined ? {} : { timestamp }),
        });
        if (message.role === 'user') {
            const kind = facts.classifyUser(record);
            if (kind === 'typed' || kind === 'questionnaire')
                push('user', userWordsText(message));
            else if (kind === 'report')
                push('report', facts.reduceReport(record, conclusions) ?? userText(message));
            return;
        }
        if (message.role === 'assistant') {
            for (const text of coordinatorVisibleTexts(message))
                push('coordinator', text);
        }
    });
    return entries;
}
/**
 * Isolated compaction input: the covered records as the model reads them,
 * with hidden host records dropped, `send_to_user` calls turned into Bunny's
 * words and their receipts removed (12.7), and thinking dropped because the
 * isolated request shares no prefix with the main request.
 */
export function buildIsolatedTranscript(records, facts) {
    const receipts = sendToUserCallIds(records);
    return records.flatMap(({ message }) => {
        if (message.role === 'custom') {
            return facts.isDeltaBlock(message) || Reflect.get(message, 'display') === false
                ? []
                : [message];
        }
        if (message.role === 'toolResult')
            return receipts.has(message.toolCallId) ? [] : [message];
        if (message.role !== 'assistant' || !Array.isArray(message.content))
            return [message];
        const content = message.content.flatMap((block) => {
            if (block.type === 'thinking')
                return [];
            if (block.type === 'toolCall' && block.name === SEND_TO_USER_TOOL_NAME) {
                const text = readSendToUserContent(block.arguments);
                return text ? [{ type: 'text', text }] : [];
            }
            return [block];
        });
        return content.length > 0 ? [{ ...message, content }] : [];
    });
}
export function readTimestamp(message) {
    const value = Reflect.get(message, 'timestamp');
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
//# sourceMappingURL=transcript.js.map