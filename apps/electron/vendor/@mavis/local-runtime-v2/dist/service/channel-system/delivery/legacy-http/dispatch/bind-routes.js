import { json, readFirstString, readJsonBody } from '../http-helpers.js';
import { AgentContractHttpError, isAgentContractLikeError, validateAgentName, } from '../agent-contract-error.js';
import { normalizePrimaryAgentResolutionConflict } from '../../../binding/family-gate.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { captureConnectionBindingCompensation, connectionError, finishConnectionBinding, finishWeChatStart, logConnectionBindingState, persistConnectionBinding, readResponsePayload, resolveImConnectionId, resolveImConnectionLink, responseCode, responseSucceeded, responseWithConnectionId, } from '../platform-api/connection-binding.js';
import { bindAgentDefaultChannelBinding } from '../../../binding/default-channel-binding.js';
import { readFeishuAgentName } from '../../../transport/feishu/feishu-store.js';
import { LocalImConnectionError } from '../../../binding/im-connection-types.js';
import { disconnectChannel, unbindFeishu, unbindTelegram, unbindWeChat } from './unbind-routes.js';
import { isFeishuConnectBody, localRunnerUnavailable, readAgentName, } from './bind-shared.js';
export async function routeLocalChannelBindApi(input) {
    try {
        if (input.method === 'GET' && input.joined === 'wechat/bind/status')
            return bindWeChatStatus(input);
        if (input.method !== 'POST')
            return undefined;
        if (input.joined === 'connect')
            return bindFeishuConnect(input);
        if (input.joined === 'disconnect')
            return disconnectChannel(input);
        if (input.joined === 'telegram/bind')
            return bindTelegram(input);
        if (input.joined === 'telegram/unbind')
            return unbindTelegram(input);
        if (input.joined === 'feishu/bind')
            return bindFeishu(input);
        if (input.joined === 'feishu/unbind')
            return unbindFeishu(input);
        if (input.joined === 'wechat/bind')
            return bindWeChat(input, 'bind');
        if (input.joined === 'wechat/unbind')
            return unbindWeChat(input);
        if (input.joined === 'wechat/bind/start')
            return bindWeChat(input, 'start');
        return undefined;
    }
    catch (error) {
        if (error instanceof LocalImConnectionError || isAgentContractLikeError(error)) {
            return connectionError(error.status, error.code, error.message);
        }
        throw error;
    }
}
// Shared helpers/type moved to bind-shared.ts to break the bind↔unbind cycle.
async function bindFeishuConnect(input) {
    const body = await readJsonBody(input.request);
    // Preserve the historical probe envelope for unrecognised connect bodies.
    if (!input.feishu || !isFeishuConnectBody(body))
        return localRunnerUnavailable();
    const link = await resolveBindLinkWithReconcile(input, body, 'feishu', (connectBody) => readFeishuAgentName(connectBody, 'mavis'));
    if (link instanceof Response)
        return link;
    const agentName = link
        ? link.agentName
        : await resolveWriteAgent(input.infra, readFeishuAgentName(body, 'mavis'), 'feishu');
    const compensate = link
        ? await captureConnectionBindingCompensation(input.feishu, link)
        : undefined;
    if (link) {
        await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'feishu' });
        logConnectionBindingState(link, 'start');
    }
    const bound = await input.feishu.bindBody({ ...body, agentName });
    if ('error' in bound)
        return link ? finishConnectionBinding(link, bound.error) : bound.error;
    if (link) {
        const persistenceError = await persistConnectionBinding(link, bound.record.clientId, compensate);
        if (persistenceError)
            return persistenceError;
    }
    else {
        await bindAgentDefaultChannelBinding(input.infra, 'feishu', bound.record.agentName, bound.record.clientId);
    }
    return json({
        ok: true,
        connected: true,
        platform: 'feishu',
        clientId: bound.record.clientId,
        localRuntime: true,
        ...(link ? { connectionId: link.connectionId } : {}),
    });
}
async function bindFeishu(input) {
    if (!input.feishu)
        return localRunnerUnavailable();
    const body = await readJsonBody(input.request);
    const link = await resolveBindLinkWithReconcile(input, body, 'feishu', (bindBody) => readFeishuAgentName(bindBody, 'mavis'));
    if (link instanceof Response)
        return link;
    const agentName = link
        ? link.agentName
        : await resolveWriteAgent(input.infra, readFeishuAgentName(body, 'mavis'), 'feishu');
    const compensate = link
        ? await captureConnectionBindingCompensation(input.feishu, link)
        : undefined;
    if (link) {
        await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'feishu' });
        logConnectionBindingState(link, 'start');
    }
    const response = await input.feishu.bind(requestWithJsonBody(input.request, { ...body, agentName }));
    if (link)
        return finishConnectionBinding(link, response, compensate);
    if (response.ok)
        await bindAgentDefaultChannelBinding(input.infra, 'feishu', agentName, agentName);
    return response;
}
async function bindTelegram(input) {
    if (!input.telegram)
        return localRunnerUnavailable();
    const body = await readJsonBody(input.request);
    const link = await resolveBindLinkWithReconcile(input, body, 'telegram', readAgentName);
    if (link instanceof Response)
        return link;
    const agentName = link
        ? link.agentName
        : await resolveWriteAgent(input.infra, readAgentName(body), 'telegram');
    const compensate = link
        ? await captureConnectionBindingCompensation(input.telegram, link)
        : undefined;
    if (link) {
        await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'telegram' });
        logConnectionBindingState(link, 'start');
    }
    const response = await input.telegram.bind(requestWithJsonBody(input.request, { ...body, agentName }));
    if (link)
        return finishConnectionBinding(link, response, compensate);
    if (response.ok)
        await bindAgentDefaultChannelBinding(input.infra, 'telegram', agentName, `telegram:${agentName}`);
    return response;
}
async function bindWeChat(input, kind) {
    if (!input.wechat)
        return localRunnerUnavailable();
    const body = await readJsonBody(input.request);
    const link = await resolveBindLinkWithReconcile(input, body, 'wechat', readAgentName);
    if (link instanceof Response)
        return link;
    const agentName = link
        ? link.agentName
        : await resolveWriteAgent(input.infra, readAgentName(body), 'wechat');
    const compensate = link
        ? await captureConnectionBindingCompensation(input.wechat, link)
        : undefined;
    if (link) {
        await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'wechat' });
        logConnectionBindingState(link, 'start');
    }
    const requestForBind = requestWithJsonBody(input.request, { ...body, agentName });
    const response = kind === 'bind'
        ? await input.wechat.bind(requestForBind)
        : await input.wechat.startBind(requestForBind);
    if (link)
        return kind === 'bind'
            ? finishConnectionBinding(link, response, compensate)
            : finishWeChatStart(link, response, compensate);
    if (response.ok)
        await bindAgentDefaultChannelBinding(input.infra, 'wechat', agentName, `wechat:${agentName}`);
    return response;
}
async function bindWeChatStatus(input) {
    if (!input.wechat)
        return localRunnerUnavailable();
    const url = new URL(input.request.url);
    const sessionId = url.searchParams.get('sessionId') ?? url.searchParams.get('session_id');
    const connectionId = url.searchParams.get('connectionId') ??
        url.searchParams.get('connection_id') ??
        (sessionId
            ? input.infra.imConnectionStore?.findAuthorizationByPlatformSession('wechat', sessionId)
            : undefined);
    if (!connectionId)
        return undefined;
    const link = await resolveImConnectionId({
        input,
        connectionId,
        channel: 'wechat',
        requestedAgentName: undefined,
        resolveWriteAgent,
    });
    if (link instanceof Response)
        return link;
    const compensate = await captureConnectionBindingCompensation(input.wechat, link);
    const response = await input.wechat.bindStatus(url);
    const payload = await readResponsePayload(response);
    const status = readFirstString(payload ?? {}, ['status'])?.toLowerCase();
    if (responseSucceeded(response, payload) && status === 'confirmed') {
        return finishConnectionBinding(link, response, compensate);
    }
    if (status === 'expired') {
        await link.store.expireAuthorization(link.connectionId);
        logConnectionBindingState(link, 'expired', {
            status: response.status,
            code: responseCode(payload, 'WECHAT_BIND_EXPIRED'),
        });
    }
    else if (!responseSucceeded(response, payload) || status === 'error') {
        const code = responseCode(payload, 'WECHAT_BIND_STATUS_FAILED');
        await link.store.markAuthorizationError(link.connectionId, 'wechat', code);
        logConnectionBindingState(link, 'failed', { status: response.status, code });
    }
    else if (sessionId) {
        await link.store.beginAuthorization({
            connectionId: link.connectionId,
            channel: 'wechat',
            platformSessionId: sessionId,
        });
    }
    return responseWithConnectionId(response, payload, link.connectionId);
}
/**
 * Resolve the Connection link for one platform bind request, emitting an
 * unconditional request diagnostic and reconciling a lost `connectionId`.
 *
 * Why this exists: incident upload-442733104115904 (2026-09-17) showed the
 * wire layer can drop `connectionId` between the Connection UI and this
 * route. The route used to fall back to the legacy per-agent binding
 * SILENTLY, so the durable Connection never reached `bound` while the
 * transport bind itself succeeded — the UI then showed a bogus
 * "authorization failed" and users deleted/recreated Connections in vain.
 *
 * Returns the link to bind on, a terminal error Response, or `undefined`
 * when the caller must keep using the legacy default-binding branch.
 */
async function resolveBindLinkWithReconcile(input, body, channel, readRequestedAgentName) {
    const agentNameInBody = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']);
    const requestedAgentName = readRequestedAgentName(body);
    const connectionIdInBody = readFirstString(body, ['connectionId', 'connection_id']);
    const requestId = readBindRequestId(input.request);
    // Unconditional diagnostic so a lost connectionId is visible on the very
    // first bind. Only key NAMES of the body are logged: it carries transport
    // credentials (botToken / appSecret / …) whose values must never be
    // logged. The connectionId itself is a non-secret local identifier.
    logger.info({
        operation: 'bind_request',
        channel,
        hasConnectionId: Boolean(connectionIdInBody),
        ...(connectionIdInBody ? { connectionId: connectionIdInBody } : {}),
        bodyKeys: Object.keys(body).sort(),
        ...(agentNameInBody ? { agentNameInBody } : {}),
        requestedAgentName,
        // Whether the name above came from an explicit agent field or from the
        // route-level fallback (readFeishuAgentName may also mine `name`).
        agentNameSource: agentNameInBody ? 'body' : 'fallback',
        ...(requestId ? { requestId } : {}),
    }, 'channel bind request');
    const link = await resolveImConnectionLink(input, body, channel, resolveWriteAgent);
    if (link)
        return link;
    const legacyFallback = (agentName, reason, detail) => {
        // Why the legacy branch survives: pre-Connection callers (older desktop
        // builds, direct API users) legitimately bind without a Connection. The
        // WARN keeps the downgrade observable — the old silent fallback is
        // exactly what hid the lost-connectionId state mismatch.
        logger.warn({
            operation: 'bind_legacy_fallback',
            channel,
            ...(agentName ? { agentName } : {}),
            reason,
            ...(detail?.connectionId ? { connectionId: detail.connectionId } : {}),
            ...(detail?.connectionState ? { connectionState: detail.connectionState } : {}),
            ...(detail?.decision ? { decision: detail.decision } : {}),
        }, 'channel bind fell back to legacy');
        return undefined;
    };
    const store = input.infra.imConnectionStore;
    if (!store) {
        return legacyFallback(undefined, 'connection_store_unavailable', {
            decision: 'this host has no Connection store; only the legacy binding path exists',
        });
    }
    const agentName = await resolveWriteAgent(input.infra, requestedAgentName, channel);
    // Reconcile: the store enforces at most ONE Connection per Agent+channel
    // (CHANNEL_CONNECTION_DUPLICATE), so a hit here is unambiguous — this is
    // the Connection the user configured in the new Channel page. Adopting it
    // keeps Connection state truthful even when a caller loses the id again.
    const connection = await store.findConnection(agentName, channel);
    if (!connection) {
        return legacyFallback(agentName, 'no_configured_connection', {
            decision: 'agent has no Connection for this channel; nothing to reconcile onto',
        });
    }
    const view = (await store.listViews(channel)).find((candidate) => candidate.connection.connectionId === connection.connectionId);
    if (view?.state === 'bound') {
        // An already-bound Connection must not be re-authorized here: a legacy
        // re-bind (same token, no id) has to keep succeeding on the old path
        // instead of failing with CHANNEL_CONNECTION_ALREADY_BOUND.
        return legacyFallback(agentName, 'connection_already_bound', {
            connectionId: connection.connectionId,
            connectionState: view.state,
            decision: 'bound Connection must not be re-authorized; legacy re-bind stays on the old path',
        });
    }
    logger.warn({
        operation: 'bind_reconcile',
        connectionId: connection.connectionId,
        channel,
        agentName,
        connectionState: view?.state ?? 'configured',
        decision: 'body lost the connectionId; adopting the agent single configured Connection',
    }, 'channel bind reconciled without connectionId');
    return {
        connectionId: connection.connectionId,
        channel: connection.channel,
        agentName: connection.agentName,
        store,
    };
}
/** Mirrors REQUEST_ID_HEADERS in runtime/pi-turn-observability.ts. */
function readBindRequestId(request) {
    for (const header of ['request-id', 'x-request-id', 'x-mm-request-id']) {
        const value = request.headers.get(header)?.trim();
        if (value)
            return value;
    }
    return undefined;
}
async function resolveWriteAgent(infra, requestedName, platform) {
    if (!infra.resolveAgentWriteTarget) {
        throw new AgentContractHttpError(503, 'Agent write resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
    }
    try {
        return await infra.resolveAgentWriteTarget(requestedName);
    }
    catch (err) {
        if (isAgentContractLikeError(err) && err.code === 'UNKNOWN_AGENT_NAME') {
            return validateAgentName(requestedName);
        }
        const primaryConflict = normalizePrimaryAgentResolutionConflict(err, {
            platform,
            canonicalAgentName: 'mavis',
            agentNames: ['mavis', 'main'],
        });
        if (primaryConflict)
            throw primaryConflict;
        throw err;
    }
}
function requestWithJsonBody(input, body) {
    const headers = new Headers(input.headers);
    headers.set('content-type', 'application/json');
    return new Request(input.url, { method: input.method, headers, body: JSON.stringify(body) });
}
//# sourceMappingURL=bind-routes.js.map