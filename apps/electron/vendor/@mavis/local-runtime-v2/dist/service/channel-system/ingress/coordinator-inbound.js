/**
 * Coordinator (Bunny) IM admission. A Connection bound to Bunny routes into
 * Bunny's single main conversation, so its inbound surface is deliberately
 * narrower than an ordinary Agent's:
 *   - only the Bot owner's direct (p2p) messages are admitted; group traffic
 *     never reaches the main conversation (a mention gets a short notice,
 *     anything else is dropped silently);
 *   - `/new` / `/clear` never create a replacement conversation;
 *   - admitted text carries a one-line origin header so Bunny can tell the
 *     message came from an IM channel rather than the desktop composer.
 */
import { isBunnyAgentName } from '@mavis/shared/agent-avatar';
import { isP2pChat } from '../access-control/access.js';
import { channelPrefersZh } from './channel-inbound-helpers.js';
/** Internal reason surfaced on a rejected coordinator inbound. */
const COORDINATOR_ACCESS_DENIED_REASON = 'coordinator-owner-p2p-only';
export function isCoordinatorAgentName(agentName) {
    return isBunnyAgentName(agentName);
}
/**
 * Owner + p2p gate for a coordinator route. Returns the terminal inbound
 * result when the message must not enter the main conversation, undefined
 * when it may proceed. Missing registration proof fails closed.
 */
export async function denyCoordinatorInbound(input) {
    const { ctx, lane, checkCreator } = input;
    const zh = channelPrefersZh(ctx.platform);
    if (!isP2pChat(ctx.chatType)) {
        return {
            handled: true,
            lane,
            accessDeniedReason: COORDINATOR_ACCESS_DENIED_REASON,
            // Replying to every group message would spam the group; answer only
            // when the Bot was explicitly mentioned.
            ...(ctx.hasMention
                ? {
                    reply: zh
                        ? 'Bunny 暂不支持群聊，请私聊我。'
                        : 'Bunny does not support group chats yet. Please message me directly.',
                }
                : {}),
        };
    }
    // Registration proof only. Historical first-DM owner rows are never consulted.
    try {
        if ((await checkCreator?.(ctx)) === true)
            return undefined;
    }
    catch {
        // Identity storage/provider failures cannot authorize access.
    }
    let reply = zh
        ? 'Bunny 仅接受已验证的 Bot 创建者私聊。旧绑定或身份缺失时，请在桌面重新完成 Bot 创建授权。'
        : 'Bunny only accepts its verified Bot creator. Legacy or unverified bindings require Bot creation authorization on Desktop.';
    if (ctx.platform === 'wechat') {
        reply =
            '请用绑定 Bunny 时扫码的微信私聊我。如果是你本人，请在桌面的 Bunny 设置 → 远程中重新扫码连接微信。';
    }
    return { handled: true, lane, accessDeniedReason: COORDINATOR_ACCESS_DENIED_REASON, reply };
}
/** `/new` and `/clear` reply for a coordinator route: no new conversation. */
export function coordinatorNewCommandReply(platform) {
    return channelPrefersZh(platform)
        ? 'Bunny 只有一个主对话，无需新建；继续发消息即可。'
        : 'Bunny has a single main conversation, so there is nothing to start; just keep messaging.';
}
const PLATFORM_LABEL_ZH = {
    feishu: '飞书',
    telegram: 'Telegram',
    wechat: '微信',
};
const PLATFORM_LABEL_EN = {
    feishu: 'Feishu',
    telegram: 'Telegram',
    wechat: 'WeChat',
};
/**
 * One-line origin header prepended to an admitted coordinator message. It is
 * built only after {@link denyCoordinatorInbound} admitted the message, and
 * that gate (by open_id) admits only the verified Bot creator's direct
 * messages, so the sender is always the owner. The platform sender id stays
 * out of the conversation text; the Turn's channelContext still carries it.
 */
function coordinatorOriginHeader(ctx) {
    if (channelPrefersZh(ctx.platform)) {
        const chat = isP2pChat(ctx.chatType) ? '私聊' : '群聊';
        return `[来自${PLATFORM_LABEL_ZH[ctx.platform]} · ${chat} · 发送者：本人]`;
    }
    const chat = isP2pChat(ctx.chatType) ? 'direct message' : 'group chat';
    return `[From ${PLATFORM_LABEL_EN[ctx.platform]} · ${chat} · sender: owner]`;
}
export function withCoordinatorOrigin(ctx, text) {
    return `${coordinatorOriginHeader(ctx)}\n${text}`;
}
//# sourceMappingURL=coordinator-inbound.js.map