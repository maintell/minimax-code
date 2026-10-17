/**
 * WeChat legacy HTTP Api (bind / QR onboard / unbind / webhook / status).
 *
 * Migration copy (MR2): Api half of v1 `channels/wechat.ts`, operating only
 * on v2 channel-system instances. Adaptations:
 * - `parseLocalWeChatEvent` returns the structured wire error; mapped back to
 *   the exact v1 400 JSON here.
 * - `LocalAgentContractError` pass-through uses a structural predicate — the
 *   error class lives in the v1 package and service code must not import v1
 *   values; cross-package `instanceof` would be wrong anyway.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { clearOwnerAllConventions } from '../../../binding/storage/owner-store.js';
import { PRIMARY_AGENT_CHANNEL_CONFLICT, PrimaryAgentChannelConflictError, } from '../../../binding/family-gate.js';
import { isPendingWeChatBindingToken, isUsableWeChatBinding, wechatClientId, } from '../../../transport/wechat/wechat-store.js';
import { applyMonitorHealthOverlay, serializeWeChatBinding, } from '../../../transport/wechat/wechat-binding-serde.js';
import { parseLocalWeChatEvent } from '../../../transport/wechat/inbound/wechat-events.js';
import { resolveWeChatAttachments } from '../../../transport/wechat/inbound/wechat-attachment-support.js';
import { pollBindStatusReal, startBindReal } from '../../../transport/wechat/wechat-onboard.js';
import { LocalWeChatChannelClient } from '../../../transport/wechat/wechat-outbound-client.js';
import { json, readFirstString, readJsonBody } from '../http-helpers.js';
export class LocalWeChatChannelApi {
    store;
    runner;
    defaultAgentName;
    makeId;
    ownerStore;
    onboardFetch;
    onBindFinalised;
    monitorHealthProvider;
    onUnbind;
    constructor(input) {
        this.store = input.store;
        this.runner = input.runner;
        this.defaultAgentName = input.defaultAgentName;
        this.makeId = input.makeId;
        this.ownerStore = input.ownerStore;
        this.onboardFetch = input.onboardFetch;
        this.onBindFinalised = input.onBindFinalised;
        this.monitorHealthProvider = input.monitorHealthProvider;
        this.onUnbind = input.onUnbind;
    }
    registerClient(adapter) {
        this.runner.clients.registerExact(new LocalWeChatChannelClient(this.runner.outboundStore, adapter));
    }
    async statusClients() {
        const clients = {};
        for (const record of await this.store.list()) {
            const serialized = serializeWeChatBinding(record);
            applyMonitorHealthOverlay(serialized, record, this.monitorHealthProvider?.(record.agentName));
            clients[record.clientId] = serialized;
        }
        return clients;
    }
    async configCheck(agentName) {
        const record = await this.store.get(agentName ?? this.defaultAgentName);
        return {
            configured: isUsableWeChatBinding(record),
            source: record ? 'local-runtime' : null,
            hasCredentials: Boolean(record?.botToken && !isPendingWeChatBindingToken(record.botToken)),
            platform: 'wechat',
            clientId: record?.clientId ?? wechatClientId(agentName ?? this.defaultAgentName),
            localRuntime: true,
            runnerEnabled: true,
        };
    }
    /**
     * Arm or revive the iLink monitor after a confirmed binding. Pending and
     * disabled shadows remain inert (delegated to the family reconciler);
     * an enabled real winner may use this awaited, idempotent hook.
     */
    async fireBindFinalised(agentName) {
        const hook = this.onBindFinalised;
        if (!hook)
            return;
        const current = await this.store.get(agentName);
        const primaryFamily = await this.store.isPrimaryFamilyAgent(agentName);
        if (!isUsableWeChatBinding(current)) {
            logger.info({ agentName, platform: 'wechat', primaryFamily }, 'WeChat bind finalizer delegated to family reconciler');
            return;
        }
        await hook(agentName);
    }
    /**
     * Direct bind path — caller supplies a real `botToken`. Interactive (QR
     * scan) onboard MUST go through `startBind` / `bindStatus`.
     */
    async bind(request) {
        const body = await readJsonBody(request);
        const bound = await this.bindBody(body);
        if ('error' in bound)
            return bound.error;
        // A direct token is already a confirmed credential, so it needs the same
        // exact adapter/client edge as QR confirmation; `fireBindFinalised` is
        // idempotent and keeps a staged primary-family candidate delegated.
        await this.fireBindFinalised(bound.record.agentName);
        return json({ ok: true, ...serializeWeChatBinding(bound.record) });
    }
    /**
     * Real iLink onboard — fetch a fresh QR code, persist a `pending:` binding
     * keyed by the new bindSessionId, and return the QR URL for the UI. No mock
     * fallback: a binding only becomes `connected` after a real scan.
     */
    async startBind(request) {
        const body = await readJsonBody(request);
        if (readFirstString(body, ['mode']) === 'mock') {
            return json({
                ok: false,
                status: 'error',
                error: 'mock channel mode is not supported',
                code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
                platform: 'wechat',
                localRuntime: true,
            }, { status: 400 });
        }
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
            this.defaultAgentName;
        const baseUrl = readFirstString(body, ['baseUrl', 'base_url']);
        const botType = readFirstString(body, ['botType', 'bot_type']);
        const sessionId = this.makeId('wechat_bind');
        try {
            const started = await startBindReal({
                agentName,
                sessionId,
                ...(baseUrl ? { baseUrl } : {}),
                ...(botType ? { botType } : {}),
            }, this.store, this.onboardFetch ? { fetch: this.onboardFetch } : {});
            // `startBindReal` skips QR issuance for an active binding. Re-run the
            // finaliser before confirming so a stale/missing runtime edge revives.
            if (started.alreadyBound)
                await this.fireBindFinalised(agentName);
            return startBindSuccessResponse(agentName, started);
        }
        catch (err) {
            if (err instanceof PrimaryAgentChannelConflictError)
                return primaryAgentConflictResponse();
            if (isAgentContractLikeError(err))
                throw err;
            // Opaque public error: iLink failures can carry request URLs or
            // provider diagnostics; never reflect credential-bearing details back.
            logger.warn({ err, agentName, platform: 'wechat' }, 'WeChat startBind QR request failed');
            return weChatIlinkQrFailureResponse();
        }
    }
    /**
     * Real iLink status long-poll — invoked by the UI to learn whether the
     * pending QR was scanned + confirmed. `pending` / `scanned` / `confirmed` /
     * `expired` are normal 200 states; provider failures keep the opaque 502
     * contract; family conflicts and monitor-start failures keep 409/503.
     */
    async bindStatus(requestUrl) {
        const sessionId = requestUrl.searchParams.get('sessionId') ??
            requestUrl.searchParams.get('session_id') ??
            undefined;
        if (!sessionId) {
            return json({ status: 'error', error: 'sessionId is required', code: 'VALIDATION_ERROR' }, { status: 400 });
        }
        const record = await this.store.getByBindSessionId(sessionId);
        if (!record) {
            return json({
                status: 'expired',
                sessionId,
                error: 'WeChat bind session is not found',
                code: 'WECHAT_BIND_SESSION_NOT_FOUND',
                localRuntime: true,
            });
        }
        // Already confirmed — short-circuit without re-polling iLink, but still
        // fire the finaliser: a binding can be `connected` on disk while its
        // iLink long-poll is dead; re-opening the bind panel revives it.
        if (isUsableWeChatBinding(record)) {
            await this.fireBindFinalised(record.agentName);
            return json({
                status: 'confirmed',
                sessionId,
                qrcodeUrl: record.qrcodeUrl,
                isImageData: false,
                platform: 'wechat',
                clientId: record.clientId,
                connected: true,
                localRuntime: true,
            });
        }
        const pollResult = await this.pollBindStatusGuarded(sessionId, record);
        if (pollResult.kind === 'response')
            return pollResult.response;
        const polled = pollResult.polled;
        if (polled.status === 'confirmed') {
            // Arm the monitor before reporting confirmation. A transport failure is
            // an explicit 503 contract, never a false-positive `confirmed` state.
            await this.fireBindFinalised(record.agentName);
            return json({
                status: 'confirmed',
                sessionId,
                qrcodeUrl: record.qrcodeUrl,
                isImageData: false,
                platform: 'wechat',
                clientId: polled.clientId,
                connected: true,
                localRuntime: true,
            });
        }
        return nonConfirmedBindStatusResponse(sessionId, record, polled);
    }
    /**
     * Guarded iLink poll: family conflicts map to the 409 contract, agent
     * contract errors pass through, provider failures keep the opaque 502.
     */
    async pollBindStatusGuarded(sessionId, record) {
        try {
            const polled = await pollBindStatusReal({
                sessionId,
                agentName: record.agentName,
                ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
            }, this.store, this.onboardFetch ? { fetch: this.onboardFetch } : {});
            return { kind: 'polled', polled };
        }
        catch (err) {
            if (err instanceof PrimaryAgentChannelConflictError) {
                return { kind: 'response', response: primaryAgentConflictResponse() };
            }
            if (isAgentContractLikeError(err))
                throw err;
            logger.warn({ err, sessionId, agentName: record.agentName, platform: 'wechat' }, 'WeChat bindStatus iLink poll failed');
            return { kind: 'response', response: weChatIlinkQrFailureResponse() };
        }
    }
    /**
     * Direct-token bind body — requires a real `botToken`. Interactive QR
     * onboard goes through `startBind` instead (no token at start time).
     */
    async bindBody(body) {
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
            this.defaultAgentName;
        const botToken = readFirstString(body, ['botToken', 'token']);
        if (!botToken) {
            return {
                error: json({
                    ok: false,
                    error: 'botToken is required',
                    code: 'VALIDATION_ERROR',
                    platform: 'wechat',
                    localRuntime: true,
                }, { status: 400 }),
            };
        }
        const requestedMode = readFirstString(body, ['mode']);
        if (requestedMode === 'mock') {
            return {
                error: json({
                    ok: false,
                    error: 'mock channel mode is not supported',
                    code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
                    platform: 'wechat',
                    localRuntime: true,
                }, { status: 400 }),
            };
        }
        if (requestedMode && requestedMode !== 'polling') {
            return {
                error: json({
                    ok: false,
                    error: 'unsupported channel mode',
                    code: 'VALIDATION_ERROR',
                    platform: 'wechat',
                    localRuntime: true,
                }, { status: 400 }),
            };
        }
        const record = await this.store.bind({
            agentName,
            botToken,
            ilinkBotId: readFirstString(body, ['ilinkBotId', 'ilink_bot_id', 'botId', 'bot_id']),
            baseUrl: readFirstString(body, ['baseUrl', 'base_url']),
            webhookToken: readFirstString(body, ['webhookToken', 'webhook_token', 'verificationToken']),
            botName: readFirstString(body, ['botName', 'bot_name', 'name']),
            bindSessionId: readFirstString(body, ['bindSessionId', 'bind_session_id']),
            qrcodeUrl: readFirstString(body, ['qrcodeUrl', 'qrCodeUrl', 'qr_code_url']),
            mode: 'polling',
            // A direct-token bind is by definition already connected.
            connected: true,
        });
        return { record };
    }
    async unbind(request) {
        const body = await readJsonBody(request);
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
            this.defaultAgentName;
        // Stop the iLink inbound monitor BEFORE deleting the store record so an
        // in-flight long-poll result cannot dispatch after the binding is gone
        // (proposal §5.4). Idempotent + scoped to this exact agentName.
        await this.onUnbind?.(agentName);
        const unbound = await this.store.unbind(agentName);
        if (unbound && this.ownerStore) {
            // Clear the owner under BOTH key conventions:
            //   1. `wechatClientId(agentName)` → `wechat:<agent>` (daemon-local).
            //   2. the imGateway inbound key `${agentName}:wechat` — WeChat inbound
            //      flows through the Electron imGateway owner-record convention.
            await clearOwnerAllConventions(this.ownerStore, agentName, 'wechat', wechatClientId(agentName));
        }
        return json({
            ok: true,
            unbound,
            disconnected: unbound,
            platform: 'wechat',
            clientId: wechatClientId(agentName),
            localRuntime: true,
        });
    }
    async handleEvent(request, dispatch, requireBinding = false) {
        const body = await readJsonBody(request);
        if (requireBinding) {
            const gate = await this.assertBinding(body);
            if (gate)
                return gate;
        }
        const envelope = parseLocalWeChatEvent(body, this.defaultAgentName);
        if ('error' in envelope)
            return wireValidationResponse(envelope.error);
        if (dispatch) {
            // Resolve inbound attachments (iLink downloader). Best-effort: a failed
            // download becomes a marker attachment instead of an exception — the
            // main message must still flow through to the agent loop.
            const attachments = await resolveWeChatAttachments(envelope.attachmentRefs, {
                messageId: envelope.eventId ?? '',
                contextToken: readFirstString(body, ['contextToken', 'context_token']),
                botToken: readFirstString(body, ['botToken', 'bot_token', 'token']),
                sessionId: envelope.eventId ?? '',
                clientName: envelope.ctx.clientName,
            });
            return json(await this.runner.dispatchInbound({
                ctx: envelope.ctx,
                text: envelope.text,
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
            }));
        }
        return json({ ok: true, envelope, localRuntime: true });
    }
    async assertBinding(body) {
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
            this.defaultAgentName;
        const record = await this.store.get(agentName);
        if (!isUsableWeChatBinding(record)) {
            return json({
                ok: false,
                error: 'WeChat binding is not configured',
                code: 'WECHAT_BINDING_REQUIRED',
                platform: 'wechat',
                clientId: wechatClientId(agentName),
                localRuntime: true,
            }, { status: 401 });
        }
        const token = readWeChatWebhookToken(body);
        if (record.webhookToken && token !== record.webhookToken) {
            return json({
                ok: false,
                error: 'WeChat webhook token mismatch',
                code: 'WECHAT_VERIFICATION_FAILED',
                platform: 'wechat',
                clientId: record.clientId,
                localRuntime: true,
            }, { status: 401 });
        }
        return undefined;
    }
}
/** Exact v1 startBind success payload (pending vs already-bound confirmed). */
function startBindSuccessResponse(agentName, started) {
    return json({
        ok: true,
        status: started.alreadyBound ? 'confirmed' : 'pending',
        sessionId: started.sessionId,
        qrcode: started.qrcode,
        qrcodeUrl: started.qrcodeUrl,
        isImageData: started.isImageData,
        ...(started.alreadyBound ? { connected: true } : {}),
        platform: 'wechat',
        clientId: wechatClientId(agentName),
        localRuntime: true,
    });
}
/** Non-confirmed poll outcomes keep their distinct v1 payload shapes. */
function nonConfirmedBindStatusResponse(sessionId, record, polled) {
    if (polled.status === 'scanned') {
        return json({
            status: 'scanned',
            sessionId,
            qrcodeUrl: record.qrcodeUrl,
            platform: 'wechat',
            clientId: record.clientId,
            connected: false,
            localRuntime: true,
        });
    }
    if (polled.status === 'expired') {
        return json({
            status: 'expired',
            sessionId,
            error: polled.error,
            platform: 'wechat',
            clientId: record.clientId,
            connected: false,
            localRuntime: true,
        });
    }
    if (polled.status === 'error') {
        return weChatIlinkQrFailureResponse();
    }
    // pending
    return json({
        status: 'pending',
        sessionId,
        qrcodeUrl: record.qrcodeUrl,
        isImageData: false,
        platform: 'wechat',
        clientId: record.clientId,
        connected: false,
        localRuntime: true,
    });
}
function primaryAgentConflictResponse() {
    return json({
        ok: false,
        status: 'conflict',
        error: 'WeChat binding conflicts with an existing primary Agent channel',
        code: PRIMARY_AGENT_CHANNEL_CONFLICT,
        platform: 'wechat',
        localRuntime: true,
    }, { status: 409 });
}
function weChatIlinkQrFailureResponse() {
    return json({
        ok: false,
        status: 'error',
        error: 'WeChat QR request failed',
        code: 'WECHAT_ILINK_QR_FAILED',
        platform: 'wechat',
        localRuntime: true,
    }, { status: 502 });
}
/** Maps the v2 structured wire error back to the exact v1 400 JSON shape. */
function wireValidationResponse(error) {
    return json({ error: error.message, code: error.code }, { status: error.status });
}
/**
 * v1 rethrows `LocalAgentContractError` so the host maps it to its HTTP
 * contract. The class lives in the v1 package; use the structural signature
 * (name + numeric status + string code) instead of a cross-package import.
 */
function isAgentContractLikeError(err) {
    return (err instanceof Error &&
        err.name === 'LocalAgentContractError' &&
        typeof err.status === 'number' &&
        typeof err.code === 'string');
}
function readWeChatWebhookToken(body) {
    const header = isRecord(body.header) ? body.header : undefined;
    return (readFirstString(body, ['token', 'webhookToken', 'webhook_token', 'verificationToken']) ??
        (header
            ? readFirstString(header, ['token', 'webhookToken', 'webhook_token', 'verificationToken'])
            : undefined));
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=wechat-api.js.map