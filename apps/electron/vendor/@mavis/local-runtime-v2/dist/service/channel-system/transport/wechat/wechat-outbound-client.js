import { prepareChannelOutboundMessage } from '../../delivery/outbound-message.js';
export class LocalWeChatChannelClient {
    outboundStore;
    adapter;
    id;
    platform = 'wechat';
    /**
     * ALL delivery goes through the exact bound iLink adapter. The adapter writes
     * the outbound audit store after the platform send result; there is no
     * unbound append-only fallback.
     */
    constructor(outboundStore, adapter) {
        this.outboundStore = outboundStore;
        this.adapter = adapter;
        this.id = adapter.clientName;
    }
    sendText(input) {
        return this.sendMessage(input);
    }
    async sendMessage(input) {
        const outbound = prepareChannelOutboundMessage(input);
        // Questionnaire branch — render via the adapter's WeChat questionnaire
        // helper (numbered-text fallback; WeChat has no native interactive
        // form). When the adapter is wired, prefer its renderQuestionnaire so
        // the pending submit-resolver bookkeeping (per-chat) stays correct.
        if (outbound.questionnaire) {
            const { toRenderableQuestionnaire } = await import('../../interaction/questionnaire-bridge.js');
            const renderable = toRenderableQuestionnaire(outbound.questionnaire);
            await this.adapter.renderQuestionnaire({ ctx: outbound.ctx, renderable });
            return this.requireRecordedOutbound({ ctx: outbound.ctx });
        }
        await this.adapter.sendMessage({
            ctx: outbound.ctx,
            text: outbound.text,
            ...(outbound.media ? { media: outbound.media } : {}),
            ...(outbound.sessionId ? { sessionId: outbound.sessionId } : {}),
            ...(outbound.queueItemId ? { queueItemId: outbound.queueItemId } : {}),
            ...(outbound.error ? { error: outbound.error } : {}),
        });
        return this.requireRecordedOutbound(outbound);
    }
    async requireRecordedOutbound(input) {
        const list = await this.outboundStore.list();
        const matched = [...list]
            .reverse()
            .find((message) => message.platform === 'wechat' &&
            message.clientName === this.id &&
            message.chatId === input.ctx.chatId &&
            (input.queueItemId ? message.queueItemId === input.queueItemId : true));
        if (matched)
            return matched;
        throw new Error('CHANNEL_OUTBOUND_RECORD_MISSING: wechat adapter completed without audit record');
    }
}
//# sourceMappingURL=wechat-outbound-client.js.map