import { LocalChannelClientUnavailableError, } from '../../../ingress/runner.js';
import { prepareChannelOutboundMessage } from '../../../delivery/outbound-message.js';
import { isUsableFeishuBinding } from '../feishu-adapter-utils.js';
import { FeishuSender } from './feishu-sender.js';
import { deliverFeishuReply } from './feishu-reply-delivery.js';
export class LocalFeishuChannelClient {
    id;
    platform = 'feishu';
    sender;
    senderFor;
    outboundStore;
    store;
    defaultAgentName;
    senderOptions;
    /**
     * Shared store of per-inbound-message "🤔 思考中…" cards. A send only ever
     * rewrites the card of the message it answers.
     */
    pendingThinkingStore;
    /**
     * Shared store of pending inbound ack reactions (keyed by inbound
     * messageId). Written by the WS dispatcher; consumed here to settle the
     * reaction once the final reply / questionnaire has been delivered.
     */
    pendingReactionStore;
    onQuestionnaireRendered;
    constructor(options) {
        this.outboundStore = options.outboundStore;
        this.store = options.store;
        this.defaultAgentName = options.defaultAgentName;
        this.senderOptions = options.senderOptions ?? {};
        this.pendingThinkingStore = options.pendingThinkingStore;
        this.pendingReactionStore = options.pendingReactionStore;
        this.onQuestionnaireRendered = options.onQuestionnaireRendered;
        this.id = options.clientName?.trim() || options.defaultAgentName.trim() || 'feishu-local';
    }
    sendText(input) {
        return this.sendMessage(input);
    }
    async sendMessage(input) {
        const outbound = prepareChannelOutboundMessage(input);
        try {
            const record = await this.requireRealBinding(outbound.ctx);
            await this.deliver(outbound, record);
            return this.recordOutbound(outbound, 'sent');
        }
        catch (err) {
            // An audit failure is retained as an error, but the SDK/credential
            // failure remains observable to the runner. Never fabricate `sent` for
            // a missing exact edge or an unsuccessful platform call.
            await this.recordOutbound(outbound, 'error', 'CHANNEL_DELIVERY_FAILED');
            throw err;
        }
    }
    recordOutbound(input, status, error = input.error) {
        return this.outboundStore.append({
            ctx: input.ctx,
            text: input.text,
            status,
            ...(input.media && input.media.length > 0 ? { media: input.media } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
            ...(error ? { error } : {}),
        });
    }
    async requireRealBinding(ctx) {
        const record = await this.store.get(agentNameFromContext(ctx, this.defaultAgentName));
        if (!isUsableFeishuBinding(record)) {
            throw new LocalChannelClientUnavailableError(ctx);
        }
        return record;
    }
    /**
     * Hand the message to the shared delivery so this client and
     * `FeishuPlatformAdapter` quote, patch and settle identically.
     */
    async deliver(input, record) {
        const result = await deliverFeishuReply({
            sender: this.ensureSender(record),
            clientName: this.id,
            ...(this.pendingThinkingStore ? { pendingThinkingStore: this.pendingThinkingStore } : {}),
            ...(this.pendingReactionStore ? { pendingReactionStore: this.pendingReactionStore } : {}),
            onQuestionnaireRendered: ({ chatId, request, messageId }) => {
                this.onQuestionnaireRendered?.({ chatId, request, messageId, clientName: this.id });
            },
        }, {
            ctx: input.ctx,
            text: input.text,
            ...(input.media ? { media: input.media } : {}),
            ...(input.questionnaire ? { questionnaire: input.questionnaire } : {}),
            ...(input.noticeKind ? { noticeKind: input.noticeKind } : {}),
            ...(input.replyScope ? { replyScope: input.replyScope } : {}),
        });
        // A failed SDK call must reject the delivery so audit state cannot claim
        // a complete real-platform send.
        if (result.firstError)
            throw new Error(result.firstError);
    }
    ensureSender(record) {
        if (this.sender &&
            this.senderFor?.appId === record.appId &&
            this.senderFor.appSecret === record.appSecret) {
            return this.sender;
        }
        this.sender?.invalidateToken();
        this.sender = new FeishuSender(record.appId, record.appSecret, {
            ...this.senderOptions,
            clientName: this.id,
        });
        this.senderFor = { appId: record.appId, appSecret: record.appSecret };
        return this.sender;
    }
}
function agentNameFromContext(ctx, fallback) {
    const name = ctx.clientName.trim();
    if (!name || name.startsWith('platform:') || name === 'feishu-local')
        return fallback;
    return name;
}
//# sourceMappingURL=feishu-outbound-client.js.map