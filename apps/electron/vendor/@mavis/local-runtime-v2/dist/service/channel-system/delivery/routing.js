export function resolveChannelRoute(input) {
    const source = input?.source;
    if (!source || (!source.startsWith('channel:') && source !== 'questionnaire')) {
        return undefined;
    }
    const sourceContext = nestedChannelContext(input.sourceContext);
    if (!sourceContext)
        return undefined;
    const platform = readString(sourceContext, 'platform');
    const chatType = readString(sourceContext, 'chatType');
    const chatId = readString(sourceContext, 'chatId');
    const senderId = readString(sourceContext, 'senderId');
    const clientName = readString(sourceContext, 'clientName');
    if (!platform || !chatType || !chatId || !senderId || !clientName)
        return undefined;
    return {
        platform,
        chatType,
        chatId,
        senderId,
        clientName,
        ...optionalString(sourceContext, 'threadId'),
        ...optionalString(sourceContext, 'sourceMessageId'),
        ...optionalString(sourceContext, 'contextToken'),
        ...optionalString(sourceContext, 'channel'),
        ...optionalString(sourceContext, 'channel_id'),
    };
}
/**
 * The IM chat a Bunny report-back or verdict-wake Turn answers in. Those Turns
 * are ordinary communication Turns (no message channelContext, so typing,
 * permission cards and follow-up joins stay on the desktop); only the final
 * reply observer reads this, from the origin the assignment runtime wrote:
 * `assignmentReport.channel` or `verdictWake.channel`. The address carries no
 * WeChat context token; the transport uses the one it cached for the chat.
 */
export function resolveAssignmentReplyRoute(input) {
    return readReplyAddress(assignmentAddress(input));
}
/**
 * The IM chat a Bunny wake Turn answers in: a run of a schedule Bunny created
 * from that chat (`cron`, `sourceContext.replyChannel`), or the delivery of
 * background tasks it started from that chat (`background-task`,
 * `sourceContext.origin.replyChannel`). Like an assignment reply, only the
 * final reply observer reads this, so the rest of the Turn stays on the desktop.
 */
export function resolveWakeReplyRoute(input) {
    // Only a background-task wake carries the message that started the work, so
    // its reply can quote it. A schedule run has no such message and keeps its
    // plain send.
    return readReplyAddress(wakeAddress(input), {
        withSourceMessageId: isBackgroundTaskWake(input),
    });
}
/**
 * The fields a reply address a Bunny Turn carries is missing, when it carries
 * one that cannot be sent to; undefined when it carries none or a complete one.
 * A stored address may lack the sender (the store keeps it optional), but the
 * delivery gate needs it to check the chat's creator, so such a reply stays on
 * the desktop and the caller logs why.
 */
export function incompleteReplyAddress(input) {
    const channel = readRecord(assignmentAddress(input)) ?? readRecord(wakeAddress(input));
    if (!channel)
        return undefined;
    const missing = REPLY_ADDRESS_FIELDS.filter((key) => !readString(channel, key));
    return missing.length ? missing : undefined;
}
function assignmentAddress(input) {
    if (input?.source !== 'communication')
        return undefined;
    const origin = readRecord(input.sourceContext?.origin);
    return (readRecord(readRecord(origin?.assignmentReport)?.channel) ??
        readRecord(readRecord(origin?.verdictWake)?.channel));
}
function wakeAddress(input) {
    if (input?.source === 'cron')
        return input.sourceContext?.replyChannel;
    if (input?.source !== 'background-task')
        return undefined;
    const origin = readRecord(input.sourceContext?.origin);
    return origin?.kind === 'background-task-terminal' ? origin.replyChannel : undefined;
}
/**
 * A delivery of background tasks Bunny started from an IM chat.
 *
 * The single predicate behind BOTH halves of that reply's shape: whether it
 * quotes the message that started the work ({@link resolveWakeReplyRoute}) and
 * whether it runs as `replyScope: 'background'` (the final reply observer).
 * Exported so the two can never drift apart.
 */
export function isBackgroundTaskWake(input) {
    return input?.source === 'background-task' && wakeAddress(input) !== undefined;
}
/**
 * Every field a reply needs. The sender is required too: the delivery gate
 * (`canDeliverToChannel`) checks a coordinator chat's creator by it.
 */
const REPLY_ADDRESS_FIELDS = ['platform', 'chatType', 'chatId', 'senderId', 'clientName'];
/**
 * Only address fields; a partial address reads as none.
 *
 * `sourceMessageId` is opt-in: a reply quotes the message it answers only when
 * the caller says that message is the one being answered. Assignment reports
 * and schedule runs leave it out and keep their unquoted send.
 */
function readReplyAddress(value, options = {}) {
    const channel = readRecord(value);
    if (!channel)
        return undefined;
    const platform = readString(channel, 'platform');
    const chatType = readString(channel, 'chatType');
    const chatId = readString(channel, 'chatId');
    const senderId = readString(channel, 'senderId');
    const clientName = readString(channel, 'clientName');
    if (!platform || !chatType || !chatId || !senderId || !clientName)
        return undefined;
    return {
        platform,
        chatType,
        chatId,
        senderId,
        clientName,
        ...optionalString(channel, 'threadId'),
        ...(options.withSourceMessageId ? optionalString(channel, 'sourceMessageId') : {}),
    };
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function nestedChannelContext(sourceContext) {
    if (!sourceContext)
        return undefined;
    const nested = sourceContext.channelContext;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested
        : sourceContext;
}
function optionalString(value, key) {
    const field = readString(value, key);
    return field ? { [key]: field } : {};
}
function readString(value, key) {
    const field = value[key];
    return typeof field === 'string' && field.trim() ? field : undefined;
}
//# sourceMappingURL=routing.js.map