import { isAssignedByBunny, originChannelColumn, } from '../../session-system/index.js';
import { isVerdictGated } from '../verdict/verdict-gate.js';
/** Bunny checks its own rounds of its own tasks; the user's round is not Bunny's to check. */
export function checkedByBunny(pending) {
    return isAssignedByBunny(pending.assignment) && pending.item.initiator === 'assigner';
}
/**
 * The reports that share the first report's chat, in batch order; one Turn answers one
 * chat. Reports from other chats wait in the batch and go out once this Turn has ended.
 */
export function sameOrigin(items) {
    const first = items[0];
    if (!first)
        return [];
    const key = originKey(first);
    return items.filter((pending) => originKey(pending) === key);
}
/**
 * The `assignmentReport` origin of a report Turn. A report from an IM chat names the chat,
 * so the channel reply observer answers there, and is marked when a failure of this Turn
 * would be retried: the chat hears only the last one.
 */
export function assignmentReportOrigin(items, maxReviewRetries) {
    const channel = items[0]?.assignment.originChannel;
    const retried = (pending) => reviewRetriedOnFailure(pending, maxReviewRetries);
    return {
        assignmentReport: {
            items: items.map(({ item }) => item),
            ...(channel ? { channel: { ...channel } } : {}),
            ...(channel && items.some(retried) ? { retriedOnFailure: true } : {}),
        },
    };
}
/**
 * Whether a failed review of this report would deliver it again: the same test
 * `acknowledge` (a review is recorded) and `reviewRetry` (retries are left) apply.
 */
function reviewRetriedOnFailure(pending, maxReviewRetries) {
    if (!checkedByBunny(pending) || isVerdictGated(pending.assignment))
        return false;
    if (pending.item.state !== 'completed')
        return false;
    const retries = pending.assignment.reviewRetries;
    const spent = retries?.reportKey === pending.key ? retries.count : 0;
    return spent < maxReviewRetries;
}
/** Where a report answers: its task's IM chat, or '' for the desktop. */
function originKey(pending) {
    const channel = pending.assignment.originChannel;
    return channel
        ? JSON.stringify([channel.platform, channel.clientName, channel.chatId, channel.threadId ?? ''])
        : '';
}
/** An IM send moves replies to its chat; a desktop send keeps where the task answers. */
export function followUpOrigin(sent, current) {
    const channel = sent ?? current?.originChannel;
    return channel ? { originChannel: originChannelColumn(channel) } : {};
}
//# sourceMappingURL=origin-routing.js.map