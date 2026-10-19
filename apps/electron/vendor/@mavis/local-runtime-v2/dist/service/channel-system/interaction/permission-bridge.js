import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** Flatten a {@link ChannelPermissionRequestSnapshot} into the renderable form. */
export function toRenderablePermission(request) {
    return {
        requestId: request.requestId,
        toolName: request.toolName,
        ...(request.toolDescription ? { toolDescription: request.toolDescription } : {}),
        ...(request.toolInput ? { toolInput: request.toolInput } : {}),
        reason: request.reason,
        ruleContents: request.ruleContents,
    };
}
/**
 * Default core bridge. Holds an in-process pending map keyed by
 * `(platform, clientName, chatId)`; implements both the outbound
 * `onPermissionAsk` hook and the inbound `tryPermissionReply` resolver.
 */
export class LocalChannelPermissionBridge {
    options;
    pending = new Map();
    constructor(options) {
        this.options = options;
    }
    async onPermissionAsk(event) {
        try {
            // Strict origin routing: a permission card only ever goes back to the
            // exact IM conversation whose message started the current turn.
            // Desktop/UI-initiated turns have no origin → the ask stays on the
            // desktop `permission.ask` Global Event and no IM binding is rendered
            // (previously every binding that matched the session received the card,
            // so a WeChat-initiated ask also popped up in Feishu).
            const origin = event.origin ?? this.options.resolveOrigin?.(event.sessionId);
            if (!origin) {
                this.info('permission card not sent', {
                    requestId: event.requestId,
                    sessionId: event.sessionId,
                    reason: 'no_origin',
                });
                return;
            }
            // raised = the ask targeted an IM channel; delivered = card rendered.
            this.options.metrics?.incr('channel_permission_ask_total', {
                channel: origin.platform,
                phase: 'raised',
            });
            const targets = await this.resolveTargets(event, origin);
            const renderable = toRenderablePermission(event.request);
            for (const target of targets) {
                await this.renderPermissionForTarget({ event, target, renderable });
            }
        }
        catch (err) {
            this.warn('permission onAsk failed', {
                requestId: event.requestId,
                sessionId: event.sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
            // Never throw: a render failure must not crash the permission ask path
            // (binding-store lookup failures land here; per-target render failures
            // are isolated in renderPermissionForTarget).
        }
    }
    /**
     * Resolve where the card may go: the origin conversation, and only while it
     * is still bound to the asking session.
     *
     * Both binding tables are consulted because each holds conversations the
     * other lacks: a session created by a V2 IM Binding never writes a legacy
     * `bindings` row, while chats bound through the legacy model still exist.
     *
     * The binding check is kept (instead of trusting the origin alone) because
     * after an unbind, or after `/new` moved the chat to a new session, the old
     * session's ask must not appear in that chat where a `/allow` would approve
     * it. When the check cannot pass, no card is sent, the same outcome as
     * before V2 targets were looked up.
     */
    async resolveTargets(event, origin) {
        const sessionBindings = await this.options.bindingStore.list({ sessionId: event.sessionId });
        const legacyTargets = sessionBindings
            .filter((binding) => binding.platform === origin.platform &&
            binding.clientName === origin.clientName &&
            binding.chatId === origin.chatId)
            .map((binding) => legacyBindingTarget(binding, origin));
        if (legacyTargets.length > 0)
            return legacyTargets;
        const v2 = await this.lookupV2Target(event, origin);
        if (v2.kind === 'bound')
            return [v2.target];
        if (v2.kind === 'not_bound') {
            this.info('permission card not sent', {
                requestId: event.requestId,
                sessionId: event.sessionId,
                platform: origin.platform,
                clientName: origin.clientName,
                reason: 'origin_not_bound',
                // Legacy rows bound to this session; none of them is the origin chat.
                legacyBindingCount: sessionBindings.length,
                v2Enabled: this.options.imRoutes !== undefined,
                v2RouteSessionId: v2.routeSessionId,
            });
        }
        return [];
    }
    /**
     * V2 check: the origin bot's physical Binding must currently point at the
     * asking session. `peekRoute` matches on platform + clientName (one Binding
     * per bot) and reports the session the chat's next message would reach.
     */
    async lookupV2Target(event, origin) {
        const imRoutes = this.options.imRoutes;
        const platform = toChannelPlatform(origin.platform);
        if (!imRoutes || !platform)
            return { kind: 'not_bound', routeSessionId: null };
        const ctx = originToContext(origin, platform);
        let routeSessionId;
        try {
            routeSessionId = (await imRoutes.peekRoute(ctx))?.sessionId;
        }
        catch (err) {
            // An unreadable V2 store proves nothing about the binding: no card.
            this.warn('permission card not sent', {
                requestId: event.requestId,
                sessionId: event.sessionId,
                platform: origin.platform,
                clientName: origin.clientName,
                reason: 'v2_route_lookup_failed',
                error: err instanceof Error ? err.message : String(err),
            });
            return { kind: 'failed' };
        }
        // An empty cursor ('' until the chat's first message creates a session)
        // binds the chat to no session yet.
        if (!routeSessionId)
            return { kind: 'not_bound', routeSessionId: null };
        if (routeSessionId !== event.sessionId)
            return { kind: 'not_bound', routeSessionId };
        return { kind: 'bound', target: { ctx, source: 'v2_physical_binding' } };
    }
    /**
     * Render one target's permission card. Per-target isolation: one target's
     * render failure (e.g. a stale placeholder binding whose chatId the
     * platform rejects) must not starve the remaining targets of their
     * permission cards. A failed render records NO pending — an undelivered
     * card must never consume a future reply.
     */
    async renderPermissionForTarget(input) {
        const { event, target, renderable } = input;
        const { ctx, source } = target;
        const identity = {
            requestId: event.requestId,
            sessionId: event.sessionId,
            platform: ctx.platform,
            clientName: ctx.clientName,
            targetSource: source,
        };
        const adapter = this.options.adapterRegistry.getForContext(ctx);
        if (!adapter?.renderPermission) {
            // Bound target, but no permission-capable adapter is registered for it.
            this.warn('permission card not sent', { ...identity, reason: 'adapter_unavailable' });
            return;
        }
        try {
            const { outboundMessageId } = await adapter.renderPermission({ ctx, renderable });
            this.pending.set(this.keyFor(ctx.platform, ctx.clientName, ctx.chatId), {
                requestId: event.requestId,
                platform: ctx.platform,
                clientName: ctx.clientName,
                chatId: ctx.chatId,
                ...(outboundMessageId ? { outboundMessageId } : {}),
                request: event.request,
                createdAt: this.options.nowMs(),
            });
            this.options.metrics?.incr('channel_permission_ask_total', {
                channel: ctx.platform,
                phase: 'delivered',
            });
            this.info('permission card delivered', identity);
        }
        catch (err) {
            this.warn('permission render failed for binding', {
                ...identity,
                chatId: ctx.chatId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    /**
     * Try to interpret an inbound platform callback as a reply to a pending
     * permission ask for this conversation. Returns the parsed reply (for the
     * caller to feed into `replyLocalPermissionRequests`) or `null` when the
     * message is not a permission reply.
     */
    async tryPermissionReply(ctx, raw) {
        const key = this.keyFor(ctx.platform, ctx.clientName, ctx.chatId);
        const pending = this.pending.get(key);
        if (!pending)
            return null;
        const adapter = this.options.adapterRegistry.getForContext(ctx);
        if (!adapter?.parsePermissionReply)
            return null;
        let reply;
        try {
            reply = await adapter.parsePermissionReply({ raw, pending });
        }
        catch (err) {
            this.warn('permission parseReply failed', {
                requestId: pending.requestId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
        if (!reply)
            return null;
        this.pending.delete(key);
        return { requestId: pending.requestId, behavior: reply.behavior };
    }
    /** Drop a pending entry once its reply has been resolved/dismissed elsewhere. */
    forget(platform, clientName, chatId) {
        this.pending.delete(this.keyFor(platform, clientName, chatId));
    }
    /** Drop every rendered ask owned by a Session that is being deleted. */
    forgetSession(sessionId) {
        let deleted = 0;
        for (const [key, pending] of this.pending) {
            if (pending.request.sessionId !== sessionId)
                continue;
            this.pending.delete(key);
            deleted += 1;
        }
        return deleted;
    }
    keyFor(platform, clientName, chatId) {
        return `${platform}:${clientName}:${chatId}`;
    }
    warn(message, detail) {
        if (this.options.logWarn)
            this.options.logWarn(message, detail);
        else
            logger.warn({ ...(detail ?? {}), operation: 'channel_permission_bridge' }, message);
    }
    info(message, detail) {
        logger.info({ ...detail, operation: 'channel_permission_bridge' }, message);
    }
}
function bindingToContext(binding) {
    return {
        platform: binding.platform,
        chatType: 'p2p',
        chatId: binding.chatId,
        senderId: binding.senderId,
        clientName: binding.clientName,
        ...(binding.threadId ? { threadId: binding.threadId } : {}),
        ...(binding.lane ? { lane: binding.lane } : {}),
    };
}
function legacyBindingTarget(binding, origin) {
    return {
        // Thread-aware delivery: the origin's threadId (the thread the turn
        // actually started in) wins over the binding's stored threadId, so the
        // card lands in the originating thread instead of the top-level chat.
        // Matching never looks at threadId.
        ctx: {
            ...bindingToContext(binding),
            ...(origin.threadId ? { threadId: origin.threadId } : {}),
        },
        source: 'legacy_binding',
    };
}
/**
 * Context for a V2 target. A physical Binding stores no chat, so the chat
 * coordinates come from the origin, with the same threadId override as the
 * legacy path. Checked field by field against the Feishu / Telegram / WeChat
 * `renderPermission`: platform + clientName pick the adapter (Telegram also
 * loads its bot record by clientName), chatId is the send target, threadId
 * the topic/thread. sourceMessageId (Feishu thread anchor) and contextToken
 * (WeChat falls back to its per-chat cache) are missing on the legacy path
 * too. chatType ('p2p', as in `bindingToContext`) and lane are read by none.
 * senderId is only copied into WeChat's outbound audit record and never used
 * for routing; the origin carries no sender, so it stays empty instead of a
 * guess (the chat id is not the sender id on Feishu).
 */
function originToContext(origin, platform) {
    return {
        platform,
        chatType: 'p2p',
        chatId: origin.chatId,
        senderId: '',
        clientName: origin.clientName,
        ...(origin.threadId ? { threadId: origin.threadId } : {}),
    };
}
/**
 * Exhaustive over `ChannelPlatform`, so a new platform fails to compile until
 * listed. Local rather than routing/'s `isChannelPlatform` so interaction/
 * takes no dependency on routing/.
 */
const CHANNEL_PLATFORMS = {
    feishu: 'feishu',
    telegram: 'telegram',
    wechat: 'wechat',
};
/** Narrows the origin's plain-string platform; an unknown one has no V2 Binding. */
function toChannelPlatform(value) {
    return Object.values(CHANNEL_PLATFORMS).find((platform) => platform === value);
}
//# sourceMappingURL=permission-bridge.js.map