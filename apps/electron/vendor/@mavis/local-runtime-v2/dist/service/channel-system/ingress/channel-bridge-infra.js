import { LocalChannelBindingStore } from '../binding/legacy-binding-store.js';
import { LocalImConnectionStore } from '../binding/connection-store/im-connection-store.js';
import { LocalChannelRouteResolver } from '../routing/channel-route-resolver.js';
import { LocalChannelRootlessError } from '../routing/rootless-route-resolver.js';
import { reportChannelResourceAmbiguity } from '../routing/channel-resource-ambiguity.js';
import { LocalChannelAdapterRegistry } from './adapter-registry.js';
import { LocalChannelLaneQueue } from './channel-lane-queue.js';
import { buildLocalChannelInboundRequestId, buildLocalChannelInboundRequestKey, hashLocalChannelRequestId, parseLocalChannelSlashCommand, } from './channel-inbound-utils.js';
import { normalizeLocalInboundAttachments } from './media/inbound-media-normalizer.js';
import { checkChannelAccess, isP2pChat } from '../access-control/access.js';
import { buildAccessControlKey, } from '../access-control/access-control-store.js';
import { buildAgentChannelConfig, buildAgentChannelConfigForAgents, } from '../binding/storage/agent-channel-config.js';
import { serializeChannelBinding } from '../binding/channel-binding-codec.js';
import { validateImBindingTargetSession } from '../binding/im-binding-target-validation.js';
import { channelImNewCreatedReceiptText, channelRouteBrokenReceiptText, imReceiptForRoute, imReceiptFromRouteError, isMissingEnqueueSessionError, keepImReceiptInternal, logImReceipt, resolveChannelEnqueueRejectionInboundResult, } from '../delivery/channel-im-receipts.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { buildEnqueueChannelContext, channelPrefersZh, compactionReply, compactionStartReply, mapAccessDenial, } from './channel-inbound-helpers.js';
export class LocalChannelBridgeInfra {
    options;
    bindingStore;
    /** V2-only durable Connection / physical Binding store. */
    imConnectionStore;
    routeResolver;
    laneQueue = new LocalChannelLaneQueue();
    /**
     * Inbound event dedup cache keyed by `${platform}:${clientName}:${eventId}`.
     * Owned by the infra instance so HTTP / SDK callers share the same view.
     * See `channels/access.ts` for the dedup policy.
     */
    eventDedupCache;
    /**
     * Unified platform-adapter registry (MR-B/C/D). The infra owns the field
     * but the host wire layer (`host-channels.ts`) populates it — `channels/`
     * never self-registers. Routes that go through this registry (today:
     * `/channel-bridge/telegram/inbound|status|bind|unbind` and
     * `/channel-bridge/feishu/card-action`) call adapter methods directly;
     * legacy routes that pre-date the registry continue to route via
     * `LocalTelegramChannelApi` / `LocalFeishuChannelApi` / etc. Defaults to a
     * fresh empty registry when `options.adapterRegistry` is omitted.
     */
    adapterRegistry;
    rootlessEnabled;
    /**
     * Optional Access Control store. Exposed as a public field so the
     * `/mavis/api/channel-bridge/access-control/*` CRUD routes (and the
     * bind-restore flow's `ensureDefaultPolicy` call) can reach the same
     * store that `handleInbound` evaluates against.
     */
    accessControlStore;
    issuedPreflightTokens = new WeakSet();
    /**
     * Setter for the deny-reply provider. The wire layer
     * (`host-channels.ts`) injects this AFTER the channel runner's
     * outbound-client registry is constructed, since the provider
     * needs `runner.clients.get(ctx)` to deliver the notice. Mutable so
     * the wire layer can patch it in at the right point in the
     * construction sequence without forcing the infra to depend on the
     * runner type.
     */
    accessControlDenyReply;
    constructor(options) {
        this.options = options;
        this.bindingStore = new LocalChannelBindingStore(options.dataDir, options.nowMs);
        this.imConnectionStore =
            options.rootlessV2 && options.imConversationModel
                ? new LocalImConnectionStore({
                    dataDir: options.dataDir,
                    nowMs: options.nowMs,
                    resolveProjectWorkspace: options.rootlessV2.resolveProjectWorkspace,
                    createSession: options.createSession,
                    validateTargetSession: (target) => validateImBindingTargetSession(options, target),
                    ...(options.revealMigratedSession
                        ? { revealMigratedSession: options.revealMigratedSession }
                        : {}),
                })
                : undefined;
        this.routeResolver = new LocalChannelRouteResolver(this.bindingStore, options, this.imConnectionStore);
        this.eventDedupCache = options.eventDedupCache ?? new Map();
        this.adapterRegistry = options.adapterRegistry ?? new LocalChannelAdapterRegistry();
        this.accessControlStore = options.accessControlStore;
        this.accessControlDenyReply = options.accessControlDenyReply;
        this.rootlessEnabled = Boolean(options.rootlessV2);
    }
    /** Exposes the host-owned resolver to the shared bind route only. */
    get resolveAgentWriteTarget() {
        return this.options.resolveAgentWriteTarget;
    }
    get resolveAgentReadScope() {
        return this.options.resolveAgentReadScope;
    }
    /** Emit one bounded resource-ambiguity observation for an HTTP bridge request. */
    reportResourceAmbiguity(memberCount) {
        reportChannelResourceAmbiguity(this.options, memberCount);
    }
    /**
     * Run the same inbound access pipeline as `handleInbound`, without routing,
     * queueing, attachment normalization, or any Agent work. The returned token
     * is consumed once by `handleInbound` so the gate is not evaluated twice.
     */
    async preflightInbound(input) {
        const command = parseLocalChannelSlashCommand(input.text);
        const lane = input.ctx.lane ?? (command ? 'control' : 'interactive');
        const didRunAccessControl = Boolean(this.options.accessControlStore);
        if (didRunAccessControl) {
            const dedup = await checkChannelAccess(input.ctx, input.eventId, this.eventDedupCache, {
                skipGroupHardBlock: true,
                skipOwnerGate: true,
            });
            if (dedup !== 'allow')
                return { allowed: false, inbound: mapAccessDenial(dedup, lane) };
        }
        if (this.options.accessControlStore) {
            const denied = await this.evaluateAccessControlGate(this.options.accessControlStore, input.ctx, lane);
            if (denied)
                return denied;
        }
        const access = await checkChannelAccess(input.ctx, input.eventId, this.eventDedupCache, this.legacyAccessOptions());
        if (access !== 'allow')
            return { allowed: false, inbound: mapAccessDenial(access, lane) };
        const token = {
            ctx: input.ctx,
            text: input.text,
            ...(input.eventId ? { eventId: input.eventId } : {}),
            lane,
        };
        this.issuedPreflightTokens.add(token);
        return {
            allowed: true,
            token,
        };
    }
    /**
     * Legacy owner-gate options. With an AC store present the dedup/group/owner
     * legs already ran (AC path), so only the residual bookkeeping runs here.
     */
    legacyAccessOptions() {
        return {
            ...(this.options.ownerStore ? { ownerStore: this.options.ownerStore } : {}),
            ...(this.options.requiresOwnerGate
                ? { requiresOwnerGate: this.options.requiresOwnerGate }
                : {}),
            ...(this.options.accessControlStore
                ? { skipDedupCheck: true, skipGroupHardBlock: true, skipOwnerGate: true }
                : {}),
        };
    }
    /**
     * Access-control policy gate (proposal: dev-im-access-control-yaml
     * 接入点 1). Bootstraps the owner for restrictive p2p policies, evaluates
     * the policy, and on deny sends + logs the best-effort deny notice.
     * Returns undefined when the policy allows the inbound.
     */
    async evaluateAccessControlGate(acStore, ctx, lane) {
        const acPolicy = await acStore.get(ctx.platform, ctx.clientName);
        if (acPolicy.allowedUsers !== 'ALL' && this.options.ownerStore && isP2pChat(ctx.chatType)) {
            await this.options.ownerStore.checkAndBootstrap(ctx.clientName, ctx.senderId, undefined);
        }
        const decision = await acStore.evaluate({
            ctx,
            resolveOwnerSenderId: async (clientName) => {
                if (!this.options.ownerStore)
                    return undefined;
                const owner = await this.options.ownerStore.getOwner(clientName);
                return owner?.ownerSenderId;
            },
        });
        if (decision.decision === 'allow')
            return undefined;
        const reason = decision.reason ?? 'owner_only';
        const key = buildAccessControlKey(ctx.platform, ctx.clientName);
        await this.deliverAccessDenyNotice(acStore, ctx, reason, key);
        return {
            allowed: false,
            inbound: {
                handled: true,
                lane,
                accessDeniedReason: `access-control:${reason}`,
            },
        };
    }
    /** Deny notice is best-effort: every settle path is logged, none can throw. */
    async deliverAccessDenyNotice(acStore, ctx, reason, key) {
        if (!this.accessControlDenyReply) {
            acStore.logDenyReply({ ctx, reason, key, status: 'unavailable' });
            return;
        }
        try {
            const replyStatus = await this.accessControlDenyReply({ ctx, reason, key });
            acStore.logDenyReply({ ctx, reason, key, status: replyStatus });
        }
        catch {
            acStore.logDenyReply({ ctx, reason, key, status: 'error' });
        }
    }
    async handleInbound(input) {
        const command = parseLocalChannelSlashCommand(input.text);
        const lane = input.ctx.lane ?? (command ? 'control' : 'interactive');
        // Inbound access check (D2 + D3) runs *before* the lane queue so:
        //   - Replayed events do not occupy a queue slot.
        //   - Group messages on owner-gated platforms are dropped before the
        //     per-lane serialisation point, so a flood of group @-mentions
        //     cannot starve p2p DMs.
        //   - The owner bootstrap (async file I/O) is not serialised by the
        //     lane — different clientNames are independent.
        // SECURITY: card_action / approval endpoints must call `checkChannelAccess`
        // when wired (D5). The dedup cache is shared via `eventDedupCache` so the
        // future approval path deduplicates clicks too.
        const gate = await this.consumePreflightOrGate(input, lane);
        if (gate)
            return gate;
        return this.laneQueue.enqueue(lane, async () => {
            if (command)
                return this.handleSlashCommand(input.ctx, command, lane, {
                    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
                    requestId: buildLocalChannelInboundRequestId(input.ctx, input.eventId),
                });
            const resolved = await this.resolveRouteOrReceipt(input, lane);
            if ('inbound' in resolved)
                return resolved.inbound;
            const route = resolved.route;
            const sessionId = route.sessionId;
            if (route.blocked || !sessionId) {
                return {
                    handled: true,
                    reply: 'Message blocked by channel route mention policy.',
                    route,
                    lane,
                };
            }
            return this.enqueueRoutedInbound(input, { ...route, sessionId }, lane);
        });
    }
    /**
     * Product decision 2026-09-04 (desktop and cloud agree): when the bound
     * Agent / Session behind a Channel route has been deleted or invalidated,
     * reply a human-readable localized receipt instead of letting the error
     * bubble into an HTTP 500 (webhook entries) or a silent log-only drop
     * (polling entries) — both read as a black hole to the IM user. Cloud
     * counterpart: archon_server InboundFromChannel [im-guard].
     */
    async resolveRouteOrReceipt(input, lane) {
        try {
            return { route: await this.routeResolver.resolve(input.ctx) };
        }
        catch (err) {
            if (!(err instanceof LocalChannelRootlessError))
                throw err;
            const requestKey = buildLocalChannelInboundRequestKey(input.ctx, input.eventId);
            const imReceipt = imReceiptFromRouteError(err, 'route_validation', requestKey);
            if (imReceipt) {
                logImReceipt({
                    ctx: input.ctx,
                    receipt: imReceipt,
                    outcome: 'receipt_generated',
                    message: '[im-guard] IM route validation failed; generated receipt',
                });
            }
            else {
                logger.warn({
                    requestKey,
                    platform: input.ctx.platform,
                    code: err.code,
                    outcome: 'receipt_generated',
                }, '[im-guard] channel route resolve failed; generated receipt');
            }
            return {
                inbound: keepImReceiptInternal({
                    handled: true,
                    reply: channelRouteBrokenReceiptText(input.ctx.platform, err.code),
                    ...(imReceipt?.sessionId ? { sessionId: imReceipt.sessionId } : {}),
                    ...(imReceipt ? { imReceipt } : {}),
                    lane,
                }),
            };
        }
    }
    /** Enqueue the routed inbound onto the target Session (v1 hot path). */
    async enqueueRoutedInbound(input, route, lane) {
        const attachments = input.attachments
            ? await normalizeLocalInboundAttachments(input.attachments)
            : undefined;
        const clientRequestId = buildLocalChannelInboundRequestId(input.ctx, input.eventId);
        const requestKey = hashLocalChannelRequestId(clientRequestId);
        let queued;
        try {
            await this.routeResolver.validateImRouteForEnqueue(route);
            queued = await this.options.enqueueMessage({ sessionId: route.sessionId, agentName: route.agentName }, {
                content: input.text,
                ...(attachments && attachments.length > 0 ? { attachments } : {}),
                ...(input.quotedMessage ? { quotedMessage: input.quotedMessage } : {}),
                channelContext: buildEnqueueChannelContext(input.ctx, route),
            }, {
                source: `channel:${input.ctx.platform}`,
                clientRequestId,
                dedupeKey: clientRequestId,
            });
        }
        catch (error) {
            return this.settleEnqueueFailure({ input, route, requestKey, error, lane });
        }
        return {
            handled: true,
            route,
            sessionId: route.sessionId,
            ...(queued ? { queueItemId: queued.itemId } : {}),
            ...(queued?.ahead !== undefined ? { queueAhead: queued.ahead } : {}),
            lane,
        };
    }
    /**
     * Enqueue-failure settlement. The Agent may have been deleted with its
     * Session after route validation; recheck the resolved target without
     * creating or moving a cursor — `/new` cannot repair an invalid Agent
     * binding. The cursor stays untouched: a subsequent /new is the only
     * action that may move it after this validation-to-enqueue deletion race.
     */
    async settleEnqueueFailure(settle) {
        const { input, route, requestKey, error, lane } = settle;
        let imReceipt;
        const rejection = resolveChannelEnqueueRejectionInboundResult({
            ctx: input.ctx,
            route,
            requestKey,
            error,
            lane,
        });
        if (rejection)
            return rejection;
        if (route.imRoute && isMissingEnqueueSessionError(error)) {
            imReceipt = imReceiptForRoute(route, 'CHANNEL_IM_SESSION_DELETED', 'enqueue', requestKey);
            try {
                await this.routeResolver.validateImRouteForEnqueue(route);
            }
            catch (revalidation) {
                const currentReceipt = revalidation instanceof LocalChannelRootlessError
                    ? imReceiptFromRouteError(revalidation, 'enqueue', requestKey)
                    : undefined;
                if (!currentReceipt)
                    throw revalidation;
                if (currentReceipt.code !== 'CHANNEL_IM_AGENT_UNAVAILABLE' &&
                    currentReceipt.code !== 'CHANNEL_IM_SESSION_DELETED') {
                    throw revalidation;
                }
                imReceipt = currentReceipt;
            }
        }
        if (!imReceipt)
            throw error;
        logImReceipt({
            ctx: input.ctx,
            receipt: imReceipt,
            outcome: 'receipt_generated',
            message: '[im-guard] IM Session disappeared before enqueue; generated receipt',
        });
        return keepImReceiptInternal({
            handled: true,
            reply: channelRouteBrokenReceiptText(input.ctx.platform, imReceipt.code),
            route,
            sessionId: route.sessionId,
            imReceipt,
            lane,
        });
    }
    /**
     * Consume a matching one-shot preflight token, else run the full gate now.
     * The token is bound to the exact normalized input so a caller cannot
     * reuse it for another message or after mutating the payload.
     */
    async consumePreflightOrGate(input, lane) {
        const preflight = input.preflight;
        const preflightMatches = preflight &&
            preflight.ctx === input.ctx &&
            preflight.text === input.text &&
            preflight.eventId === input.eventId &&
            preflight.lane === lane &&
            this.issuedPreflightTokens.has(preflight);
        if (preflightMatches) {
            this.issuedPreflightTokens.delete(preflight);
            return undefined;
        }
        const access = await this.preflightInbound({
            ctx: input.ctx,
            text: input.text,
            ...(input.eventId ? { eventId: input.eventId } : {}),
        });
        return access.allowed ? undefined : access.inbound;
    }
    async status() {
        const bindings = await this.bindingStore.list();
        return {
            clients: {},
            queue: this.laneQueue.stats(),
            bindings: bindings.length,
            localRuntime: true,
            runner: {
                enabled: true,
                mode: 'local-runtime',
            },
        };
    }
    async buildAgentChannelConfig(agentName) {
        return buildAgentChannelConfig(this.bindingStore, agentName);
    }
    async routeAgentIm(agentName, method, compatibleNames) {
        if (method === 'GET') {
            const familyNames = compatibleNames?.length ? compatibleNames : undefined;
            const names = familyNames ? new Set(familyNames) : undefined;
            const bindings = names
                ? (await this.bindingStore.list()).filter((binding) => names.has(binding.agentName))
                : await this.bindingStore.list({ agentName });
            const configResult = familyNames
                ? await buildAgentChannelConfigForAgents(this.bindingStore, familyNames)
                : { config: await this.buildAgentChannelConfig(agentName), candidates: [] };
            if (configResult.candidates.length > 0) {
                reportChannelResourceAmbiguity(this.options, configResult.candidates.length);
                return {
                    status: 409,
                    body: {
                        channel: null,
                        activeBindings: bindings.map(serializeChannelBinding),
                        localRuntime: true,
                        code: 'AMBIGUOUS_CHANNEL_CONFIG',
                        error: `Channel config for ${agentName} is ambiguous`,
                        candidates: configResult.candidates,
                    },
                };
            }
            const channel = configResult.config ?? null;
            return {
                status: 200,
                body: {
                    channel,
                    activeBindings: bindings.map(serializeChannelBinding),
                    localRuntime: true,
                },
            };
        }
        if (method === 'DELETE') {
            const deletedCount = await this.bindingStore.deleteByAgent(agentName);
            return {
                status: 200,
                body: { ok: true, deleted: deletedCount > 0, deletedCount, localRuntime: true },
            };
        }
        // Same body the v1 `notFound` helper produced for this route.
        return {
            status: 404,
            body: { error: `Local runtime route not found: /agent/${agentName}/im` },
        };
    }
    async handleSlashCommand(ctx, command, lane, extras = {}) {
        // ── Single IM-channel slash command surface ──
        // Every recognized `/<cmd>` that arrives from Feishu / Telegram / WeChat
        // goes through here. Dispatch is keyed off `command.name`; the same
        // string also drives {@link LOCAL_CHANNEL_SLASH_COMMANDS} (the parser
        // allowlist) and `LocalChannelSlashCommandName` (the TS union type).
        // The type-safe `registry` below makes TypeScript refuse to compile if
        // you add a new entry to the allowlist without wiring a handler (or vice
        // versa) — there is deliberately no fallthrough path for unknown names.
        //
        // Args are intentionally NOT logged: slash-command args from IM
        // channels can contain user prompt text, which may include sensitive
        // content. We log only `argsLength` for observability.
        logger.info({
            scope: 'channel.slash',
            op: 'dispatch',
            command: command.name,
            lane,
            platform: ctx.platform,
            argsLength: command.args.length,
        }, 'Channel slash command dispatching');
        // Single-source dispatch: every entry in `LOCAL_CHANNEL_SLASH_COMMANDS`
        // must have exactly one handler here. The `Record<...>` key type is the
        // command-name union derived from that constant, so TypeScript refuses to
        // compile if a command is added to the source of truth without a handler
        // (or vice versa) — no more three-way manual sync of allowlist + union +
        // if-chain.
        const registry = {
            new: (c, cmd, l, e) => this.handleNewCommand(c, cmd, l, e),
            clear: (c, cmd, l, e) => this.handleNewCommand(c, cmd, l, e),
            stop: (c, cmd, l) => this.handleStopCommand(c, cmd, l),
            compact: (c, cmd, l, e) => this.handleCompactCommand(c, cmd, l, e),
        };
        return registry[command.name](ctx, command, lane, extras);
    }
    async handleStopCommand(ctx, _command, lane) {
        // ── `/stop` handler ──
        // Reads the active binding and aborts the underlying session's in-flight
        // turn (if any). We deliberately do NOT archive the session — `stop` is
        // a "cease current generation" verb, not a "close the chat" verb; use
        // the desktop sidebar archive for the latter.
        const baseFields = {
            scope: 'channel.slash',
            op: 'stop',
            command: 'stop',
            lane,
            platform: ctx.platform,
        };
        const route = await this.routeResolver.resolveExisting(ctx);
        if (!route?.sessionId) {
            logger.warn({ ...baseFields, outcome: 'no_binding' }, 'Channel /stop skipped — no active binding for this sender/chat');
            return { handled: true, command: 'stop', reply: 'No active session binding found.', lane };
        }
        await this.options.abortSession(route.sessionId);
        this.options.emitBusEvent?.('channel.stop_requested', {
            targetKind: 'concrete_session',
        });
        logger.info({ ...baseFields, outcome: 'ok' }, 'Channel /stop aborted active session');
        return {
            handled: true,
            command: 'stop',
            reply: `Stop requested for session: ${route.sessionId}`,
            sessionId: route.sessionId,
            lane,
        };
    }
    async handleNewCommand(ctx, command, lane, extras) {
        // Standalone V1 keeps the legacy Root swap below. Production V2 returns
        // from the Rootless branch before any Root capability is touched.
        const baseFields = {
            scope: 'channel.slash',
            op: 'new',
            command: command.name,
            lane,
            platform: ctx.platform,
        };
        const startedAt = Date.now();
        if (this.options.rootlessV2) {
            return this.handleRootlessNewCommand({ ctx, command, lane, extras, baseFields, startedAt });
        }
        const route = await this.routeResolver.resolve(ctx);
        if (route.blocked || !route.sessionId) {
            logger.warn({
                ...baseFields,
                ...(route.agentName ? { agentName: route.agentName } : {}),
                outcome: 'no_route',
                durationMs: Date.now() - startedAt,
            }, 'Channel /new skipped — route resolver returned blocked or no sessionId');
            return { handled: true, command: command.name, reply: 'No active route.', route, lane };
        }
        const created = await this.createLegacyRootSession(route, baseFields, startedAt);
        if ('inbound' in created)
            return { ...created.inbound, command: command.name, lane };
        const { session, createdVia } = created;
        // Defense in depth: `createRootSession` already asserts `sessionType='root'`
        // via `replaceRootSession`, but if any future path re-enters this handler
        // with a non-root session we fail the command rather than report a
        // successful Root swap.
        if (session.sessionType !== 'root') {
            logger.error({
                ...baseFields,
                agentName: route.agentName,
                previousSessionId: route.sessionId,
                newSessionId: session.sessionId,
                sessionType: session.sessionType,
                outcome: 'promotion_failed',
                durationMs: Date.now() - startedAt,
            }, 'Channel /new received non-root session from Root creation');
            return {
                handled: true,
                command: command.name,
                reply: 'Failed to promote the new session to root. Please try again later.',
                route,
                lane,
            };
        }
        logger.info({
            ...baseFields,
            agentName: route.agentName,
            previousSessionId: route.sessionId,
            newSessionId: session.sessionId,
            createdVia,
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
        }, 'Channel /new archived old root and created new root');
        return {
            handled: true,
            command: command.name,
            reply: `New session created: ${session.sessionId}`,
            sessionId: session.sessionId,
            lane,
        };
    }
    /**
     * Rootless `/new`: advance the concrete Session binding. Production V2
     * always takes this branch; the legacy Root swap below only serves
     * standalone V1 hosts.
     */
    async handleRootlessNewCommand(cmd) {
        const { ctx, command, lane, extras, baseFields, startedAt } = cmd;
        const requestId = extras.requestId?.trim() || buildLocalChannelInboundRequestId(ctx);
        try {
            const route = await this.routeResolver.advance(ctx, requestId);
            if (route.blocked || !route.sessionId) {
                logger.warn({ ...baseFields, outcome: 'no_route', durationMs: Date.now() - startedAt }, 'Channel /new skipped because no Rootless route is active');
                return { handled: true, command: command.name, reply: 'No active route.', route, lane };
            }
            return this.settleRootlessNewSuccess({
                route,
                command,
                lane,
                requestId,
                baseFields,
                startedAt,
            });
        }
        catch (error) {
            const receiptReply = this.rootlessNewErrorReceipt({ ctx, command, lane, requestId, error });
            if (receiptReply)
                return receiptReply;
            logger.error({
                ...baseFields,
                outcome: 'failed',
                code: error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : 'CHANNEL_NEW_FAILED',
                durationMs: Date.now() - startedAt,
            }, 'Channel /new failed to advance the concrete Session binding');
            throw error;
        }
    }
    /**
     * Legacy Root creation for standalone-V1 `/new`. Prefers the host-wired
     * `createRootSession` promote path; falls back to a plain
     * `createSession({sessionType:'root'})` so the inbound never crashes on a
     * host misconfig (only exercised by some unit test doubles).
     */
    async createLegacyRootSession(route, baseFields, startedAt) {
        try {
            if (this.options.createRootSession) {
                const created = await this.options.createRootSession(route.agentName);
                if (!created) {
                    // The host wired `createRootSession`, but the promote path bailed
                    // (agent record missing, no existing root in the sessions table,
                    // demote/promote failed, …). Every failure branch now emits its
                    // own logger.error/warn upstream — this line records the
                    // channel-level outcome so the /new operator sees a matching
                    // failure without wading through the daemon log.
                    logger.error({
                        ...baseFields,
                        agentName: route.agentName,
                        previousSessionId: route.sessionId,
                        outcome: 'createRootSession_failed',
                        durationMs: Date.now() - startedAt,
                    }, 'Channel /new failed — createRootSession returned undefined');
                    // `lane` is re-attached by the caller so the reply keeps the
                    // inbound's actual lane instead of assuming the control lane.
                    return {
                        inbound: {
                            handled: true,
                            reply: 'Failed to create a new session. Please try again later.',
                            route,
                            lane: 'control',
                        },
                    };
                }
                return { session: created, createdVia: 'createRootSession' };
            }
            const session = await this.options.createSession({
                agentName: route.agentName,
                workspaceDir: this.options.resolveDefaultWorkspaceDir(),
                sessionType: 'root',
                title: 'Main',
                parentSessionId: null,
                isDefaultWorkspace: true,
            });
            return { session, createdVia: 'createSession_fallback' };
        }
        catch (err) {
            logger.error({
                ...baseFields,
                agentName: route.agentName,
                previousSessionId: route.sessionId,
                outcome: 'create_failed',
                durationMs: Date.now() - startedAt,
                err: err instanceof Error ? err.message : String(err),
            }, 'Channel /new failed to create root session');
            throw err;
        }
    }
    /** Advanced-route success settle for /new: receipt + operator log + reply. */
    settleRootlessNewSuccess(settle) {
        const { route, command, lane } = settle;
        const imReceipt = imReceiptForRoute(route, 'CHANNEL_IM_NEW_CREATED', 'new_receipt', hashLocalChannelRequestId(settle.requestId));
        logger.info({ ...settle.baseFields, outcome: 'ok', durationMs: Date.now() - settle.startedAt }, 'Channel /new advanced the concrete Session binding');
        return keepImReceiptInternal({
            handled: true,
            command: command.name,
            reply: route.imRoute
                ? channelImNewCreatedReceiptText()
                : `New session created: ${route.sessionId}`,
            route,
            ...(route.sessionId ? { sessionId: route.sessionId } : {}),
            ...(imReceipt ? { imReceipt } : {}),
            lane,
        });
    }
    /** Route-validation failures on /new become localized receipts, not throws. */
    rootlessNewErrorReceipt(receipt) {
        const { ctx, command, lane, requestId, error } = receipt;
        if (!(error instanceof LocalChannelRootlessError))
            return undefined;
        const imReceipt = imReceiptFromRouteError(error, 'route_validation', hashLocalChannelRequestId(requestId));
        if (!imReceipt)
            return undefined;
        logImReceipt({
            ctx,
            receipt: imReceipt,
            outcome: 'receipt_generated',
            message: '[im-guard] IM /new route validation failed; generated receipt',
        });
        return keepImReceiptInternal({
            handled: true,
            command: command.name,
            reply: channelRouteBrokenReceiptText(ctx.platform, error.code),
            ...(imReceipt.sessionId ? { sessionId: imReceipt.sessionId } : {}),
            imReceipt,
            lane,
        });
    }
    // [本期隐藏] /btw 本期不作为受支持命令。parser 已不识别 `/btw`(当普通消息发
    // LLM),注册表也不含 btw 项。逻辑保留休眠不丢。恢复:向
    // LOCAL_CHANNEL_SLASH_COMMANDS 加回 'btw' + 注册表加回
    // `btw: (c, cmd, l) => this.handleBtwCommand(c, cmd, l)`。
    async handleBtwCommand(ctx, command, lane) {
        const route = await this.routeResolver.resolve(ctx);
        if (route.blocked || !route.sessionId) {
            return {
                handled: true,
                // [本期隐藏] 'btw' 已不在 LocalChannelSlashCommandName 联合内(真源移除);
                // 休眠 handler 的回执值保持不变,用 cast 保留字面量待下期恢复。
                command: 'btw',
                reply: 'No active route.',
                route,
                lane,
            };
        }
        const content = command.args.trim() || 'What should I know about the current context?';
        const queued = await this.options.enqueueMessage({ sessionId: route.sessionId, agentName: route.agentName }, {
            content,
            channelContext: {
                platform: ctx.platform,
                chatType: ctx.chatType,
                chatId: ctx.chatId,
                senderId: ctx.senderId,
                clientName: ctx.clientName,
                ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
                ...(ctx.sourceMessageId ? { sourceMessageId: ctx.sourceMessageId } : {}),
                ...(ctx.contextToken ? { contextToken: ctx.contextToken } : {}),
            },
        }, { source: `channel:${ctx.platform}` });
        return {
            handled: true,
            command: 'btw',
            reply: `Queued BTW question for session: ${route.sessionId}`,
            route,
            sessionId: route.sessionId,
            ...(queued ? { queueItemId: queued.itemId } : {}),
            ...(queued?.ahead !== undefined ? { queueAhead: queued.ahead } : {}),
            lane,
        };
    }
    async handleCompactCommand(ctx, command, lane, extras) {
        // ── `/compact` handler ──
        // Out-of-band compaction request for the active session. We do NOT
        // touch the routing table here — `/compact` runs on whichever session
        // the route resolver currently points at (typically a branch task
        // session for short-lived work, or the agent root for the main chat).
        //
        // Stages:
        //   1. resolve route (skip cleanly if blocked / unrouteable),
        //   2. defensive check: refuse to crash if host omitted
        //      `requestCompaction` (some test scaffolding + the legacy
        //      HTTP-only boot path),
        //   3. invoke the compaction core. The core itself may return
        //      `SESSION_BUSY` / `UNSUPPORTED` / `SUCCESS` etc. — we mirror
        //      the code through the localized reply copy.
        //
        // Note: `args` here are the user's `/compact <custom instructions>`
        // payload. Like the dispatcher we log `argsLength` not the contents.
        const baseFields = {
            scope: 'channel.slash',
            op: 'compact',
            command: 'compact',
            lane,
            platform: ctx.platform,
            clientName: ctx.clientName,
            chatId: ctx.chatId,
            senderId: ctx.senderId,
            argsLength: command.args.length,
        };
        const startedAt = Date.now();
        const route = await this.routeResolver.resolve(ctx);
        if (route.blocked || !route.sessionId) {
            logger.warn({
                ...baseFields,
                ...(route.agentName ? { agentName: route.agentName } : {}),
                outcome: 'no_route',
                durationMs: Date.now() - startedAt,
            }, 'Channel /compact skipped — route resolver returned blocked or no sessionId');
            return { handled: true, command: 'compact', reply: 'No active route.', route, lane };
        }
        const zh = channelPrefersZh(ctx.platform);
        // Defensive: host did not wire the compaction core. Never crash the inbound
        // path — surface the "unsupported" copy so the sender gets feedback.
        if (!this.options.requestCompaction) {
            logger.warn({
                ...baseFields,
                agentName: route.agentName,
                sessionId: route.sessionId,
                outcome: 'unsupported',
                durationMs: Date.now() - startedAt,
            }, 'Channel /compact ignored — host did not wire requestCompaction');
            return {
                handled: true,
                command: 'compact',
                reply: compactionReply('COMPACTION_UNSUPPORTED', zh),
                route,
                sessionId: route.sessionId,
                lane,
            };
        }
        const customInstructions = command.args.trim() || undefined;
        const outcome = await this.options.requestCompaction({
            sessionId: route.sessionId,
            agentName: route.agentName,
            ...(customInstructions ? { customInstructions } : {}),
            reason: 'im_request',
            // The two-stage "started" line only fires once the core has passed its
            // busy/lock guards and is genuinely about to compact. A busy session
            // returns SESSION_BUSY before this runs, so no "started" line is sent.
            onStarted: extras.onProgress
                ? async () => {
                    await extras.onProgress?.(compactionStartReply(zh));
                }
                : undefined,
        });
        const isSuccess = outcome.code === 'SUCCESS';
        if (isSuccess) {
            logger.info({
                ...baseFields,
                agentName: route.agentName,
                sessionId: route.sessionId,
                outcome: 'ok',
                compactionCode: outcome.code,
                durationMs: Date.now() - startedAt,
            }, 'Channel /compact completed');
        }
        else {
            logger.warn({
                ...baseFields,
                agentName: route.agentName,
                sessionId: route.sessionId,
                outcome: 'failed',
                compactionCode: outcome.code,
                durationMs: Date.now() - startedAt,
            }, 'Channel /compact did not succeed — surfacing localized reply to sender');
        }
        return {
            handled: true,
            command: 'compact',
            reply: compactionReply(outcome.code, zh),
            route,
            sessionId: route.sessionId,
            lane,
        };
    }
}
// mapAccessDenial / channelPrefersZh / compaction replies /
// buildEnqueueChannelContext live in ./channel-inbound-helpers.ts (split to
// keep this hub under the file-size budget).
//# sourceMappingURL=channel-bridge-infra.js.map