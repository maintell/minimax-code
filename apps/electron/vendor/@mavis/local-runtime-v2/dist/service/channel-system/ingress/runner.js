/**
 * Channel runner: inbound dispatch pipeline and outbound delivery registry.
 *
 * Migration copy (MR1) of v1 `channels/runner.ts` with the legacy SSE
 * execution path dropped (proposal §4/§10: the old SSE collection is
 * deleted with v1, never migrated):
 * - `conversation` (RuntimeConversation channel view) is now REQUIRED —
 *   the v2 owner always collects replies from committed display messages;
 * - `dispatchQueued`, the SSE `LocalChannelResponseCollector`,
 *   `deliverReplyFromSse` and the `kickChannelDrain`/`runQueuedTurn`
 *   legacy fallbacks went with it;
 * - the ingress hub dependency is a narrow structural port
 *   ({@link ChannelRunnerInfraPort}) instead of the v1 infra class.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import {} from '@mavis/conversation-contract';
import { rebaseMediaPath } from './media/media-path-resolve.js';
import { prepareChannelOutboundMessage } from '../delivery/outbound-message.js';
import { collectChannelResponseFromMessages, } from '../delivery/response-collector.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * Queued-notice copy. Copied verbatim from v1 `channel-queue-drain.ts`
 * (which is NOT migrated — the drain belongs to the retired legacy execution
 * path); aligned with the historical IM gateway wording so the desktop
 * experience matches the legacy daemon.
 */
function formatQueuedNoticeText(ahead) {
    const count = Math.max(1, ahead);
    return `⏳ 已加入队列，前方还有 ${count} 条消息，请稍候...`;
}
/** Persisted outbound audit history used by real platform clients. */
export class LocalChannelOutboundStore {
    dataDir;
    nowMs;
    makeId;
    loaded = false;
    messages = [];
    constructor(dataDir, nowMs, makeId) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
        this.makeId = makeId;
    }
    async list(filter = {}) {
        await this.load();
        return this.messages
            .filter((message) => !filter.sessionId || message.sessionId === filter.sessionId)
            .filter((message) => !filter.chatId || message.chatId === filter.chatId)
            .map((message) => ({ ...message }));
    }
    async append(input) {
        await this.load();
        const message = {
            id: this.makeId('channel_outbound'),
            platform: input.ctx.platform,
            clientName: input.ctx.clientName,
            chatId: input.ctx.chatId,
            senderId: input.ctx.senderId,
            ...(input.ctx.threadId ? { threadId: input.ctx.threadId } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
            text: input.text,
            ...(input.media && input.media.length > 0 ? { media: input.media } : {}),
            status: input.status ?? 'sent',
            createdAt: this.nowMs(),
            ...(input.error ? { error: input.error } : {}),
        };
        this.messages.push(message);
        await this.save();
        return { ...message };
    }
    async clear() {
        await this.load();
        const count = this.messages.length;
        this.messages = [];
        await this.save();
        return count;
    }
    async load() {
        if (this.loaded)
            return;
        this.loaded = true;
        // v1 semantics: any read failure (first boot included) starts empty.
        let raw;
        try {
            raw = await readFile(this.filePath, 'utf8');
        }
        catch {
            return;
        }
        if (!raw)
            return;
        const parsed = yaml.load(raw);
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        this.messages = messages.flatMap((message) => normalizeOutboundMessage(message));
    }
    async save() {
        const payload = {
            schemaVersion: 1,
            messages: this.messages,
        };
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, yaml.dump(payload, { lineWidth: 120, noRefs: true }), 'utf8');
    }
    get filePath() {
        return join(this.dataDir(), 'channel-outbound-messages.yaml');
    }
}
/** Stable failure for a bound channel whose exact delivery edge is absent. */
export const CHANNEL_CLIENT_UNAVAILABLE = 'CHANNEL_CLIENT_UNAVAILABLE';
export class LocalChannelClientUnavailableError extends Error {
    status = 503;
    code = CHANNEL_CLIENT_UNAVAILABLE;
    constructor(ctx) {
        super(`${CHANNEL_CLIENT_UNAVAILABLE}: ${ctx.platform}:${ctx.clientName}`);
        this.name = 'LocalChannelClientUnavailableError';
    }
}
/**
 * Deliver an outbound message through a channel client, preferring the unified
 * `sendMessage` contract when the client implements it and falling back to the
 * legacy `sendText` path otherwise. Centralises the capability check so call
 * sites stay uniform and the text-only path is provably equivalent to the
 * pre-existing `sendText` behaviour.
 */
/** @public exercised directly by the colocated unit suite (v1 twin). */
export function deliverOutbound(client, input) {
    const outbound = prepareChannelOutboundMessage(input);
    if (client.sendMessage)
        return client.sendMessage(outbound);
    return client.sendText({
        ctx: outbound.ctx,
        text: outbound.text,
        ...(outbound.media && outbound.media.length > 0 ? { media: outbound.media } : {}),
        ...(outbound.sessionId ? { sessionId: outbound.sessionId } : {}),
        ...(outbound.queueItemId ? { queueItemId: outbound.queueItemId } : {}),
        ...(outbound.error ? { error: outbound.error } : {}),
    });
}
export class LocalMultiChannelClientRegistry {
    clients = new Map();
    /**
     * Register a real SDK-bound client under its exact platform client id (for
     * example `telegram:mavis`). The registry intentionally has no platform or
     * default fallback: an absent exact edge is a delivery failure, never a fake
     * local success.
     */
    registerExact(client) {
        this.clients.set(client.id, client);
    }
    unregister(clientId) {
        this.clients.delete(clientId);
    }
    get(ctx) {
        const client = this.clients.get(ctx.clientName);
        if (client)
            return client;
        throw new LocalChannelClientUnavailableError(ctx);
    }
    status() {
        return {
            clients: [...this.clients.values()].map((client) => ({
                id: client.id,
                platform: client.platform,
            })),
        };
    }
}
export class LocalChannelRunner {
    options;
    outboundStore;
    clients;
    /**
     * Defence-in-depth binding gate, injected AFTER construction by the wire
     * layer (`host-channels.ts`) once the per-platform binding stores exist.
     * Mutable so the host can patch it in without forcing the runner options to
     * depend on the store types (mirrors `infra.accessControlDenyReply`). When
     * set, `dispatchInbound` drops any inbound whose binding is gone. Falls back
     * to the constructor option so tests can still wire it via options if they
     * prefer.
     */
    hasActiveChannelBinding;
    constructor(options) {
        this.options = options;
        this.outboundStore = new LocalChannelOutboundStore(options.dataDir, options.nowMs, options.makeId);
        this.clients = new LocalMultiChannelClientRegistry();
        this.hasActiveChannelBinding = options.hasActiveChannelBinding;
    }
    status() {
        return {
            enabled: true,
            localRuntime: true,
            responseCollector: 'committed-messages',
            ...this.clients.status(),
        };
    }
    /**
     * Gate an inbound before a transport performs platform-visible side effects.
     * Denied preflights are metered here; allowed ones are metered by the normal
     * dispatch wrapper after the token is consumed by infra.
     */
    async preflightInbound(input) {
        if (this.hasActiveChannelBinding && !(await this.hasActiveChannelBinding(input.ctx))) {
            const result = {
                inbound: {
                    handled: true,
                    lane: input.ctx.lane ?? 'interactive',
                    accessDeniedReason: 'channel-unbound',
                },
            };
            this.options.metrics?.incr('channel_inbound_total', {
                channel: input.ctx.platform,
                status: inboundMetricStatus(result),
            });
            return { allowed: false, inbound: result.inbound };
        }
        try {
            const result = await this.options.infra.preflightInbound(input);
            if (!result.allowed) {
                this.options.metrics?.incr('channel_inbound_total', {
                    channel: input.ctx.platform,
                    status: inboundMetricStatus({ inbound: result.inbound }),
                });
            }
            return result;
        }
        catch (err) {
            this.options.metrics?.incr('channel_inbound_total', {
                channel: input.ctx.platform,
                status: 'error',
            });
            throw err;
        }
    }
    async dispatchInbound(input) {
        // Metering wrapper: one `channel_inbound_total{channel,status}` count per
        // inbound outcome plus a `channel_dispatch_duration_ms` sample, around the
        // otherwise-unchanged dispatch flow in `dispatchInboundInner`.
        const metrics = this.options.metrics;
        const startMs = this.options.nowMs();
        try {
            const result = await this.dispatchInboundInner(input);
            metrics?.incr('channel_inbound_total', {
                channel: input.ctx.platform,
                status: inboundMetricStatus(result),
            });
            return result;
        }
        catch (err) {
            metrics?.incr('channel_inbound_total', { channel: input.ctx.platform, status: 'error' });
            throw err;
        }
        finally {
            metrics?.latency('channel_dispatch_duration_ms', this.options.nowMs() - startMs, {
                channel: input.ctx.platform,
            });
        }
    }
    async dispatchInboundInner(input) {
        // Defence-in-depth: drop inbound whose (agentName × platform) binding is
        // gone before ANY processing (questionnaire interception, dedup, dispatch,
        // outbound). This is the central backstop for unbind "必断连" — even if a
        // transport failed to tear itself down, a message that slips through here
        // is discarded with no session work and no reply. `handled: true` so the
        // HTTP layer answers 200; `accessDeniedReason` tags it for ops.
        if (this.hasActiveChannelBinding && !(await this.hasActiveChannelBinding(input.ctx))) {
            const inbound = {
                handled: true,
                lane: input.ctx.lane ?? 'interactive',
                accessDeniedReason: 'channel-unbound',
            };
            return { inbound };
        }
        // Permission reply interception — MUST run BEFORE the questionnaire
        // interception (see tryInterceptPermissionReply for the full rationale).
        const permission = await this.tryInterceptPermissionReply(input);
        if (permission)
            return permission;
        const questionnaire = await this.tryInterceptQuestionnaireReply(input);
        if (questionnaire)
            return questionnaire;
        const inbound = await this.options.infra.handleInbound({
            ctx: input.ctx,
            text: input.text,
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(input.quotedMessage ? { quotedMessage: input.quotedMessage } : {}),
            ...(input.eventId ? { eventId: input.eventId } : {}),
            ...(input.preflight ? { preflight: input.preflight } : {}),
            // Interim-progress seam for slash commands (today: `/compact`'s two-stage
            // "started" line). Backed by the same `deliverOutbound` + client registry
            // the terminal reply uses, so a mid-flight line lands on the same channel.
            onProgress: async (text) => {
                await this.sendOutbound(input.ctx, { ctx: input.ctx, text });
            },
        });
        return this.settleInboundOutcome(input.ctx, inbound);
    }
    /** Post-bridge outcome handling: dedup pass-through, direct reply, queue notice. */
    async settleInboundOutcome(ctx, inbound) {
        // P1.4 wires `deduplicated: true` through the infra layer; this pass-through
        // makes the flag visible to HTTP handlers once the infra emits it.
        if (inbound.deduplicated) {
            return { inbound, deduplicated: true };
        }
        if (inbound.reply && !inbound.queueItemId) {
            await this.deliverDirectReply(ctx, inbound);
            return { inbound };
        }
        if (!inbound.sessionId || !inbound.queueItemId)
            return { inbound };
        // Conversation-first: Session V2 owns queued-turn execution. The runner
        // only surfaces the "queued, N ahead" notice; the final reply arrives via
        // deliverReplyFromMessages once the committed turn lands.
        if ((inbound.queueAhead ?? 0) > 0) {
            await this.deliverQueuedNotice(ctx, inbound.queueAhead ?? 0);
        }
        return { inbound };
    }
    /** Send a bridge-produced immediate reply; IM receipts log their delivery fate. */
    async deliverDirectReply(ctx, inbound) {
        try {
            const outbound = await this.sendOutbound(ctx, {
                ctx,
                text: inbound.reply,
                ...(inbound.sessionId ? { sessionId: inbound.sessionId } : {}),
            });
            if (inbound.imReceipt) {
                logImReceiptDelivery(ctx.platform, inbound.imReceipt, outbound.status === 'sent' ? 'sent' : 'returned_error');
            }
        }
        catch (error) {
            if (inbound.imReceipt) {
                logImReceiptDelivery(ctx.platform, inbound.imReceipt, 'threw');
            }
            throw error;
        }
    }
    /**
     * Permission reply interception — runs BEFORE the questionnaire
     * interception. Both ride platform callback events (Telegram
     * callback_query), but the permission bridge matches strictly on its
     * own pending map + `p:<requestId>:<decision>` codec, so a click
     * claimed here can never be a questionnaire answer. A hit settles the
     * pending permission request through the handler and short-circuits —
     * the callback is never dispatched as a plain user message. Fail-quiet:
     * a resolver error falls through to the normal inbound flow; a handler
     * error (e.g. the desktop UI already settled the request) is logged
     * and the inbound is still treated as consumed.
     */
    async tryInterceptPermissionReply(input) {
        if (!this.options.tryPermissionReply || !this.options.permissionReplyHandler)
            return undefined;
        let permissionMatch = null;
        try {
            permissionMatch = await this.options.tryPermissionReply(input.ctx, input.raw);
        }
        catch (err) {
            logger.error({ err, platform: input.ctx.platform, clientName: input.ctx.clientName }, 'Channel permission reply resolver failed');
            // Fall through to the normal inbound path on resolver errors.
        }
        if (!permissionMatch)
            return undefined;
        // The click IS the user's permission decision — count the replied
        // phase regardless of how the handler settles (fail-quiet below).
        this.options.metrics?.incr('channel_permission_ask_total', {
            channel: input.ctx.platform,
            phase: 'replied',
        });
        const inbound = {
            handled: true,
            lane: input.ctx.lane ?? 'interactive',
        };
        try {
            await this.options.permissionReplyHandler({
                ctx: input.ctx,
                requestId: permissionMatch.requestId,
                behavior: permissionMatch.behavior,
            });
        }
        catch (err) {
            logger.error({ err, requestId: permissionMatch.requestId }, 'Channel permission reply handler failed');
        }
        return { inbound, permissionReply: true };
    }
    /**
     * Questionnaire reply interception. Adapters track their own pending
     * questionnaire state (see `ChannelQuestionnairePending` in the
     * platform adapter) so the runner does not need to know which
     * encoding (numbered text, inline keyboard, card form) the platform
     * used. An `undefined` return falls through to the normal inbound flow.
     */
    async tryInterceptQuestionnaireReply(input) {
        if (!this.options.questionnaireReplyHandler)
            return undefined;
        const adapter = this.options.infra.adapterRegistry.get(input.ctx.platform, input.ctx.clientName);
        if (!adapter?.tryHandleQuestionnaireReply)
            return undefined;
        try {
            const handlerInput = {
                ctx: input.ctx,
                text: input.text,
                ...(input.raw !== undefined ? { raw: input.raw } : {}),
            };
            const questionnaireResult = await adapter.tryHandleQuestionnaireReply(handlerInput);
            if (!questionnaireResult)
                return undefined;
            const inbound = {
                handled: true,
                lane: input.ctx.lane ?? 'interactive',
            };
            if (!('reply' in questionnaireResult)) {
                return { inbound, questionnaireReply: true };
            }
            // Only a forwarded reply payload counts as the user answering —
            // consumed-no-reply events (acks) are not replies.
            this.options.metrics?.incr('channel_ask_user_total', {
                channel: input.ctx.platform,
                phase: 'replied',
            });
            const outcome = await this.settleQuestionnaireForward(input.ctx, questionnaireResult);
            await this.settleQuestionnaireOnAdapter(adapter, questionnaireResult, outcome);
            return { inbound, questionnaireReply: true };
        }
        catch (err) {
            logger.error({ err, platform: input.ctx.platform, clientName: input.ctx.clientName }, 'Channel questionnaire reply adapter failed');
            // Fall through to the normal inbound path on adapter errors —
            // dropping the message would lose the user's reply silently.
            return undefined;
        }
    }
    /** Forward the decoded reply to the host handler; classify failures retryable. */
    async settleQuestionnaireForward(ctx, questionnaireResult) {
        try {
            const resolved = await this.options.questionnaireReplyHandler(questionnaireResult);
            return resolved ?? { status: 'accepted' };
        }
        catch (err) {
            // The host classifies LocalQuestionnaireError before it reaches
            // this boundary. A bridge/unknown throw is still retryable, but
            // the inbound remains handled and never falls into a normal turn.
            logger.error({
                err,
                requestId: questionnaireResult.reply.requestId,
                platform: ctx.platform,
                clientName: ctx.clientName,
            }, 'Channel questionnaire reply handler failed');
            return { status: 'retryable' };
        }
    }
    /** Settlement can change channel state as well as terminal UI. The inbound is
     * already consumed; never re-dispatch it as an Agent turn if this fails. */
    async settleQuestionnaireOnAdapter(adapter, questionnaireResult, outcome) {
        if (!adapter.settleQuestionnaireReply)
            return;
        try {
            await adapter.settleQuestionnaireReply({
                ctx: questionnaireResult.ctx,
                requestId: questionnaireResult.reply.requestId,
                outcome,
            });
        }
        catch (err) {
            logger.error({
                err,
                platform: questionnaireResult.ctx.platform,
                clientName: questionnaireResult.ctx.clientName,
                requestId: questionnaireResult.reply.requestId,
                outcome,
            }, 'Channel questionnaire reply settle failed');
        }
    }
    /** Best-effort product hook used by both legacy and v2 Turn execution. */
    async notifyTurnStart(ctx) {
        const adapter = this.options.infra.adapterRegistry?.get(ctx.platform, ctx.clientName);
        logger.info({
            platform: ctx.platform,
            clientName: ctx.clientName,
            adapterConfigured: Boolean(adapter),
            hasNotifyTurnStart: Boolean(adapter?.notifyTurnStart),
        }, 'Channel Turn typing resolved adapter');
        if (!adapter?.notifyTurnStart)
            return;
        try {
            await adapter.notifyTurnStart(ctx);
        }
        catch {
            // Typing must never surface to the Turn.
        }
    }
    /** Best-effort counterpart to {@link notifyTurnStart}. */
    async notifyTurnEnd(ctx) {
        const adapter = this.options.infra.adapterRegistry?.get(ctx.platform, ctx.clientName);
        if (!adapter?.notifyTurnEnd)
            return;
        try {
            await adapter.notifyTurnEnd(ctx);
        }
        catch {
            // Typing must never surface to terminal reply delivery.
        }
    }
    sendCollected(send) {
        const { ctx, sessionId, queueItemId, collected } = send;
        const text = collected.error ? '' : collected.text.trim();
        const hasMedia = !collected.error && !!collected.media && collected.media.length > 0;
        if (!text && !hasMedia && !collected.error)
            return Promise.resolve(undefined);
        // Rebase relative media paths to <workspace>/<path> so IM senders
        // don't ENOENT on bare basenames.
        const media = hasMedia
            ? collected.media.map((m) => rebaseMediaPath(m, send.workspaceDir))
            : undefined;
        return this.sendOutbound(ctx, {
            ctx,
            text,
            ...(media ? { media } : {}),
            sessionId,
            queueItemId,
            ...(collected.error ? { error: collected.error } : {}),
        });
    }
    /** Delivers a continuation from the v2 committed-message projection. */
    async deliverReplyFromMessages(deliver) {
        const filter = await this.resolveMessageFilter(deliver.ctx);
        const collected = collectChannelResponseFromMessages(deliver.messages, filter, deliver.error);
        return this.sendCollected({
            ctx: deliver.ctx,
            sessionId: deliver.sessionId,
            queueItemId: '',
            collected,
            ...(deliver.workspaceDir ? { workspaceDir: deliver.workspaceDir } : {}),
        });
    }
    /**
     * Send a single "queued, N ahead" notice to the originating IM chat.
     * Called from the channel queue drain kick path when the enqueued item
     * is going to wait (session busy or items ahead in the channel queue).
     *
     * Best-effort: a delivery failure must never block the dispatch flow —
     * the kick path runs alongside idle-drain and cannot be allowed to fail
     * the entire enqueue. We swallow errors here.
     */
    async deliverQueuedNotice(ctx, ahead) {
        if (ahead <= 0)
            return;
        const text = formatQueuedNoticeText(ahead);
        try {
            await this.sendOutbound(ctx, {
                ctx,
                text,
            });
        }
        catch (err) {
            logger.warn({ err, platform: ctx.platform, chatId: ctx.chatId }, 'Channel queued notice delivery failed');
        }
    }
    /**
     * Metered wrapper over {@link deliverOutbound}: resolves the client from the
     * registry and counts every outbound attempt as
     * `channel_outbound_total{channel,status}`. A throw counts as `error` and is
     * rethrown — callers keep their existing error semantics.
     */
    async sendOutbound(ctx, input) {
        try {
            const message = await deliverOutbound(this.clients.get(ctx), input);
            this.options.metrics?.incr('channel_outbound_total', {
                channel: ctx.platform,
                // Normalize: test doubles may return partial messages without status.
                status: message.status === 'error' ? 'error' : 'sent',
            });
            return message;
        }
        catch (err) {
            this.options.metrics?.incr('channel_outbound_total', {
                channel: ctx.platform,
                status: 'error',
            });
            throw err;
        }
    }
    /**
     * Resolve the per-client message filter for a dispatch. Dual-convention
     * fallback: try `ctx.clientName` first, then the daemon `*ClientId` key.
     * Any error → default filter so a lookup miss never throws out of dispatch.
     */
    async resolveMessageFilter(ctx) {
        try {
            const primary = await this.options.infra.bindingStore.getMessageFilter(ctx.clientName);
            if (!isDefaultMessageFilter(primary))
                return primary;
            const altKey = daemonClientIdForCtx(ctx);
            if (altKey && altKey !== ctx.clientName) {
                const alt = await this.options.infra.bindingStore.getMessageFilter(altKey);
                if (!isDefaultMessageFilter(alt))
                    return alt;
            }
            return primary;
        }
        catch {
            return { mode: 'result', includeToolSummary: false };
        }
    }
}
function isDefaultMessageFilter(f) {
    return f.mode === 'result' && f.includeToolSummary !== true;
}
function logImReceiptDelivery(platform, receipt, outcome) {
    const fields = {
        requestKey: receipt.requestKey,
        platform,
        source: `channel:${platform}`,
        connectionId: receipt.imRoute.connectionId,
        bindingId: receipt.imRoute.bindingId,
        ...(receipt.imRoute.imConversationId
            ? { imConversationId: receipt.imRoute.imConversationId }
            : {}),
        ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
        stage: 'receipt_delivery',
        receiptStage: receipt.stage,
        code: receipt.code,
        outcome,
    };
    if (outcome === 'sent') {
        logger.info(fields, 'IM receipt delivery completed');
    }
    else {
        logger.warn(fields, 'IM receipt delivery did not complete');
    }
}
/**
 * Map an inbound dispatch result to the bounded `channel_inbound_total` status
 * enum: `permission_reply` | `questionnaire_reply` | `deduplicated` |
 * `unbound` | `denied` | `ok` (plus `error` emitted by the wrapper on throw).
 * Free-form denial reason strings never become label values.
 */
function inboundMetricStatus(result) {
    if (result.permissionReply)
        return 'permission_reply';
    if (result.questionnaireReply)
        return 'questionnaire_reply';
    if (result.deduplicated)
        return 'deduplicated';
    if (result.inbound.accessDeniedReason === 'channel-unbound')
        return 'unbound';
    if (result.inbound.accessDeniedReason)
        return 'denied';
    return 'ok';
}
/**
 * Rebuild the daemon `*ClientId(agentName)` storage key for `ctx` — the key the
 * UI / REST WRITES the message filter under (from
 * `feishu/telegram/wechat.statusClients()` → `record.clientId`), which differs
 * from the dispatch `ctx.clientName` (`${agent}:${platform}`). The per-platform
 * `*ClientId` helpers live in the channel modules, but those import from THIS
 * file — importing them back would create a cycle — so the trivial convention
 * is duplicated here (same rationale as `owner-store.imGatewayInboundClientName`).
 */
function daemonClientIdForCtx(ctx) {
    const platform = ctx.platform;
    const suffix = `:${platform}`;
    const agentRaw = ctx.clientName.endsWith(suffix)
        ? ctx.clientName.slice(0, -suffix.length)
        : ctx.clientName;
    const agent = agentRaw.trim() || 'mavis';
    switch (platform) {
        case 'feishu':
            return agent; // feishuClientId(agent) === agent
        case 'telegram':
            return `telegram:${agent}`; // telegramClientId
        case 'wechat':
            return `wechat:${agent}`; // wechatClientId
        default:
            return undefined;
    }
}
function normalizeOutboundMessage(value) {
    if (!value || typeof value !== 'object')
        return [];
    const raw = value;
    if (!hasRequiredOutboundColumns(raw))
        return [];
    return [
        {
            id: raw.id,
            platform: raw.platform,
            clientName: raw.clientName,
            chatId: raw.chatId,
            senderId: raw.senderId,
            ...(typeof raw.threadId === 'string' ? { threadId: raw.threadId } : {}),
            ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
            ...(typeof raw.queueItemId === 'string' ? { queueItemId: raw.queueItemId } : {}),
            text: raw.text,
            status: raw.status === 'error' ? 'error' : 'sent',
            createdAt: raw.createdAt,
            ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
        },
    ];
}
/** A row missing any required audit column is dropped (v1 semantics). */
function hasRequiredOutboundColumns(raw) {
    return (typeof raw.id === 'string' &&
        typeof raw.platform === 'string' &&
        typeof raw.clientName === 'string' &&
        typeof raw.chatId === 'string' &&
        typeof raw.senderId === 'string' &&
        typeof raw.text === 'string' &&
        typeof raw.createdAt === 'number');
}
//# sourceMappingURL=runner.js.map