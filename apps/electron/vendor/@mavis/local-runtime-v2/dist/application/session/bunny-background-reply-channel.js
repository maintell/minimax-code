import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { readOriginChannel, } from '../../service/session-system/index.js';
/**
 * The IM chat the background tasks Bunny's main conversation started were started from:
 * each task names the Turn that started it, and that Turn's source names the chat AND the
 * message that started it, so the wake's reply can quote it. Only when every task came
 * from the same chat, so a batch mixing chats or a desktop turn stays on the desktop. A
 * batch whose tasks were started by DIFFERENT messages of that chat still answers the
 * chat, but without a quote — one of them cannot stand in for all of them. Only address
 * fields are read; the WeChat context token is not.
 */
export function createBunnyBackgroundReplyChannel(ports) {
    return async (ownerSessionId, tasks) => {
        if (tasks.length === 0)
            return undefined;
        const owner = await ports.sessions.get(ownerSessionId);
        if (!owner || !isBunnyAgentName(owner.agentName))
            return undefined;
        const root = await ports.root.getRootSessionByAgent(owner.agentName);
        if (root.sessionId !== ownerSessionId)
            return undefined;
        return sharedTaskAddress(ports, ownerSessionId, tasks);
    };
}
/**
 * The chat every task's starting Turn came from, or undefined when any differs or has
 * none. The quote anchor survives only while every task names the SAME message.
 */
async function sharedTaskAddress(ports, ownerSessionId, tasks) {
    let found;
    let quoteable = true;
    for (const task of tasks) {
        const address = await taskAddress(ports, ownerSessionId, task);
        if (!address)
            return undefined;
        if (found && !sameAddress(found, address))
            return undefined;
        // Chat fields are equal from here on, so one differing pair is enough.
        if (found && found.sourceMessageId !== address.sourceMessageId)
            quoteable = false;
        found = address;
    }
    if (!found)
        return undefined;
    return quoteable ? found : withoutSourceMessageId(found);
}
/** The chat one task's starting Turn came from, or undefined when it names none. */
async function taskAddress(ports, ownerSessionId, task) {
    const parentTurnId = task.metadata?.['parentTurnId'];
    if (typeof parentTurnId !== 'string' || !parentTurnId)
        return undefined;
    return channelAddress(await ports.messages.resolveTurnSource(ownerSessionId, parentTurnId));
}
function channelAddress(source) {
    if (!source?.source?.startsWith('channel:') || !source.sourceContext)
        return undefined;
    const nested = source.sourceContext['channelContext'];
    return readOriginChannel(typeof nested === 'object' && nested !== null ? nested : source.sourceContext);
}
/**
 * Same CHAT, ignoring which message started the task. `sourceMessageId` is
 * deliberately not compared here: a batch started by different messages of one
 * chat still answers that chat, it just cannot quote one of them for all of
 * them (see {@link withoutSourceMessageId}).
 */
function sameAddress(left, right) {
    return (left.platform === right.platform &&
        left.clientName === right.clientName &&
        left.chatId === right.chatId &&
        left.chatType === right.chatType &&
        left.senderId === right.senderId &&
        left.threadId === right.threadId);
}
/** The same chat, minus the quote anchor: the reply goes out unquoted. */
function withoutSourceMessageId(address) {
    return {
        platform: address.platform,
        clientName: address.clientName,
        chatId: address.chatId,
        chatType: address.chatType,
        ...(address.senderId !== undefined ? { senderId: address.senderId } : {}),
        ...(address.threadId !== undefined ? { threadId: address.threadId } : {}),
    };
}
//# sourceMappingURL=bunny-background-reply-channel.js.map