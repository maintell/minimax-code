import { collectMessageAssetItems, stripDeliverAssetsWrappers } from '@mavis/shared/asset-markup';
import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
import { readTaskReport, taskReportBodies } from '../../../coordinator-text/index.js';
/** Sources whose user rows are typed by the user (or answer a questionnaire). */
const USER_SOURCES = new Set(['api', 'im', 'questionnaire', 'code_review', 'channel']);
/** Origins of user-role rows that the runtime, not the user, delivered. */
const SYSTEM_ORIGIN_KEYS = ['bunnyGreeting'];
const USER_KINDS = new Set(['steered_user', 'undelivered_user']);
/** The runtime's questionnaire answer: a machine block, then the readable Q/A it is followed by. */
const QUESTIONNAIRE_BLOCK = /^\s*<questionnaire-response>[\s\S]*?<\/questionnaire-response>\s*/u;
/** Same marker the message store and input navigation use to leave permission replies out. */
const PERMISSION_RESPONSE = /<permission-response\b/u;
/** Standalone asset tags in Bunny's text; listed as attachments, not shown as words. */
const MEDIA_TAG = /<media\s[^>]*?\/>/gu;
const SUMMARY_TOOL = 'assignment_summary';
const TASK_TOOLS = new Set([
    'assignment_create',
    'assignment_send',
    'assignment_cancel',
    'assignment_stop',
]);
const TOOL_FINISHED = 2;
/**
 * The searchable parts of one display message (spec 15.2): Bunny's visible text, which
 * already carries delivered `send_to_user` content, the user's own messages and
 * questionnaire answers, each report's goal, each card conclusion, and one line per
 * attachment. Tool results, cards and runtime-delivered rows are not searchable.
 */
export function extractSearchDocuments(message) {
    if (message.role === 'user')
        return userDocuments(message);
    if (message.role === 'assistant' && message.kind == null)
        return assistantDocuments(message);
    return [];
}
/**
 * The user's words as stored. Nothing is removed by tag shape: only the questionnaire
 * block the runtime itself writes in front of a questionnaire answer, recognised by the
 * row's source or origin (set by the runtime, never by the user), is dropped.
 */
function userText(message, content) {
    return isQuestionnaireAnswer(message) ? content.replace(QUESTIONNAIRE_BLOCK, '') : content;
}
function isQuestionnaireAnswer(message) {
    return (message.source === 'questionnaire' ||
        isOrdinaryQuestionnaireResponseOrigin(message.sourceContext?.origin));
}
/** Bunny's words as shown: asset markup becomes attachment documents instead. */
function assistantText(content) {
    return stripDeliverAssetsWrappers(content).replace(MEDIA_TAG, '');
}
function userDocuments(message) {
    if (message.kind != null && !USER_KINDS.has(message.kind))
        return [];
    const origin = record(message.sourceContext?.origin);
    if (message.source === 'communication' && origin?.assignmentReport)
        return reportDocuments(message, record(origin.assignmentReport));
    if (!isUserSource(message.source))
        return [];
    if (origin && SYSTEM_ORIGIN_KEYS.some((key) => Object.hasOwn(origin, key)))
        return [];
    const content = messageContent(message);
    if (PERMISSION_RESPONSE.test(content))
        return [];
    return [...textDocument('user', userText(message, content)), ...userAttachments(message)];
}
function isUserSource(source) {
    return source === undefined || USER_SOURCES.has(source) || source.startsWith('channel:');
}
function assistantDocuments(message) {
    const calls = toolCalls(message);
    const taskId = calls.flatMap(taskIdsOfCall)[0];
    const content = messageContent(message);
    const text = textDocument('assistant', assistantText(content)).map((draft) => taskId ? { ...draft, taskId } : draft);
    return [...text, ...calls.flatMap(cardConclusions), ...assistantAttachments(content)];
}
function textDocument(role, body) {
    return body.trim() ? [{ part: 'text', role, body }] : [];
}
/** A report keeps its title and goal only; the task's final reply is not indexed. */
function reportDocuments(message, report) {
    const items = Array.isArray(report?.items) ? report.items.map(record) : [];
    const blocks = taskReportBodies(messageContent(message));
    return items.flatMap((item, index) => {
        const taskId = stringField(item, 'sessionId');
        if (!taskId)
            return [];
        const title = stringField(item, 'title') ?? '';
        const goal = readTaskReport(blocks[index] ?? '').goal;
        const body = [title && `任务：${title}`, goal && `目标：${goal}`].filter(Boolean).join('\n');
        if (!body)
            return [];
        const spaceId = stringField(item, 'worklineId');
        return [
            { part: `task:${taskId}`, role: 'report', body, taskId, ...(spaceId ? { spaceId } : {}) },
        ];
    });
}
function toolCalls(message) {
    const calls = message.tool_calls ?? message.toolCalls;
    if (!Array.isArray(calls))
        return [];
    return calls.map(record).flatMap((call) => {
        const name = stringField(call, 'tool_name');
        if (!name || stringField(call, 'parent_tool_call_id'))
            return [];
        return [
            {
                name,
                status: call?.tool_call_status,
                args: parseJson(call?.tool_call_args),
                result: parseJson(call?.tool_call_result_data),
            },
        ];
    });
}
function taskIdsOfCall(call) {
    if (call.name === SUMMARY_TOOL)
        return summaryItems(call).map((item) => item.taskId);
    if (!TASK_TOOLS.has(call.name))
        return [];
    const id = stringField(record(call.args), 'session_id') ?? findString(call.result, 'sessionId');
    return id ? [id] : [];
}
/** The conclusion Bunny wrote on a task card with a successful `assignment_summary`. */
function cardConclusions(call) {
    if (call.name !== SUMMARY_TOOL || call.status !== TOOL_FINISHED)
        return [];
    return summaryItems(call).map(({ taskId, title, summary }) => ({
        part: `task:${taskId}`,
        role: 'assistant',
        body: title ? `${title}：${summary}` : summary,
        taskId,
    }));
}
function summaryItems(call) {
    if (hasFailure(call.result))
        return [];
    const receipt = findArray(call.result, 'items').flatMap((item) => summaryItem(record(item), 'sessionId'));
    if (receipt.length > 0)
        return receipt;
    const items = record(call.args)?.items;
    return Array.isArray(items)
        ? items.flatMap((item) => summaryItem(record(item), 'session_id'))
        : [];
}
function summaryItem(item, idKey) {
    const taskId = stringField(item, idKey);
    const summary = stringField(item, 'summary')?.trim();
    if (!taskId || !summary)
        return [];
    const title = stringField(item, 'title');
    return [{ taskId, summary, ...(title ? { title } : {}) }];
}
function userAttachments(message) {
    return userAttachmentRefs(message).map(({ assetId, fileName }) => attachmentDocument('user', assetId, fileName));
}
/** Each attachment of a user message with the asset ID its index line carries. */
function userAttachmentRefs(message) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return attachments.flatMap((value) => {
        const attachment = record(value);
        const meta = record(attachment?.meta);
        const local = record(attachment?.local);
        const path = stringField(local, 'filePath') ?? stringField(attachment, 'file_path');
        const assetId = attachmentAssetId(attachment, path);
        const fileName = stringField(meta, 'fileName') ?? stringField(attachment, 'file_name') ?? baseName(path);
        return assetId && fileName ? [{ assetId, fileName, ...(path ? { path } : {}) }] : [];
    });
}
function attachmentAssetId(attachment, path) {
    const local = record(attachment?.local);
    const cloud = record(attachment?.cloud);
    return (stringField(local, 'assetId') ??
        stringField(attachment, 'asset_id') ??
        stringField(cloud, 'driveNodeId') ??
        stringField(cloud, 'uploadId') ??
        path);
}
/**
 * The asset ID the index gives the attachment of a user message named by `ref`,
 * its asset ID or its file path (the model sees attachments by path, spec 12.6).
 */
export function indexedAttachmentAssetId(message, ref) {
    return userAttachmentRefs(message).find((item) => item.assetId === ref || item.path === ref)
        ?.assetId;
}
function assistantAttachments(content) {
    return collectMessageAssetItems(content).flatMap((asset) => {
        const assetId = asset.path.trim() || asset.driveNodeId?.trim() || asset.artifactId?.trim();
        const fileName = asset.name?.trim() || baseName(asset.path);
        return assetId && fileName ? [attachmentDocument('assistant', assetId, fileName)] : [];
    });
}
function attachmentDocument(role, assetId, fileName) {
    return { part: `asset:${assetId}`, role, body: fileName, assetId, fileName };
}
function baseName(path) {
    return path?.split(/[\\/]/u).filter(Boolean).at(-1);
}
function messageContent(message) {
    const value = message.msg_content ?? message.msgContent;
    return typeof value === 'string' ? value : '';
}
function hasFailure(value) {
    const result = record(value);
    return result?.ok === false || result?.isError === true;
}
/** First array under `key` anywhere in a parsed tool result (receipts nest JSON in text). */
function findArray(value, key, depth = 0) {
    if (depth > 4)
        return [];
    if (typeof value === 'string')
        return findArray(parseJson(value), key, depth + 1);
    if (Array.isArray(value))
        return value.flatMap((entry) => findArray(entry, key, depth + 1));
    const object = record(value);
    if (!object)
        return [];
    if (Array.isArray(object[key]))
        return object[key];
    return Object.values(object).flatMap((entry) => findArray(entry, key, depth + 1));
}
function findString(value, key, depth = 0) {
    if (depth > 4)
        return undefined;
    if (typeof value === 'string')
        return findString(parseJson(value), key, depth + 1);
    const object = record(value);
    if (!object)
        return undefined;
    const direct = stringField(object, key);
    if (direct)
        return direct;
    for (const entry of Object.values(object)) {
        const found = findString(entry, key, depth + 1);
        if (found)
            return found;
    }
    return undefined;
}
function parseJson(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function stringField(value, key) {
    const field = value?.[key];
    return typeof field === 'string' && field.length > 0 ? field : undefined;
}
//# sourceMappingURL=documents.js.map