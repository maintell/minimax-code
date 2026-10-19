/**
 * Legacy unbind / disconnect ingress for the platform channel bridge,
 * split out of `channel-bind-routes.ts` to keep both files inside the
 * 500-line layout budget. Same dispatch surface (`routeLocalChannelBindApi`
 * forwards here), no behaviour change.
 *
 * F2 semantics live here: every legacy unbind/disconnect path must clear
 * the Agent's IM Connection physical Binding symmetrically after the
 * adapter-side cleanup, otherwise a Connection bound through the reconcile
 * fallback would stay `bound` forever and block re-authorization in the
 * new Channel page.
 */
import { json, readFirstString, readJsonBody } from '../http-helpers.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { isFeishuConnectBody, isNonFeishuPlatformBody, localRunnerUnavailable, readAgentName, } from './bind-shared.js';
import { deleteAgentPlatformChannelBindings } from '../../../binding/default-channel-binding.js';
import { readFeishuAgentName } from '../../../transport/feishu/feishu-store.js';
import { LocalImConnectionError } from '../../../binding/im-connection-types.js';
/**
 * Symmetric Connection cleanup for the LEGACY unbind/disconnect ingress
 * (reviewer finding F2): the reconcile fallback in
 * `resolveBindLinkWithReconcile` can commit a physical Binding onto the
 * Agent's Connection even when the request carried no connectionId, but the
 * legacy unbind paths only cleared the legacy route rows and transport
 * credentials. The Connection then stayed `bound` forever — the new Channel
 * page showed a live binding after a successful disconnect and blocked any
 * re-authorization. Mirror the Connection-page unbind semantics here:
 * delete the physical Binding (via the same `store.deleteBinding`), keep
 * the Connection itself as `configured`.
 */
async function clearImConnectionBindingForLegacyUnbind(infra, channel, agentName) {
    const store = infra.imConnectionStore;
    if (!store)
        return; // V1 host without the Connection model: nothing to clear.
    let connection;
    try {
        connection = await store.findConnection(agentName, channel);
        if (!connection) {
            logger.info({ operation: 'unbind_connection_cleanup', channel, agentName, result: 'no_connection' }, 'legacy unbind found no Connection to clear');
            return;
        }
        const deleted = await store.deleteBinding(connection.connectionId);
        logger.info({
            operation: 'unbind_connection_cleanup',
            connectionId: connection.connectionId,
            channel,
            agentName,
            deleted,
        }, 'legacy unbind cleared the Connection physical binding');
    }
    catch (error) {
        // The transport-side unbind already succeeded; a Connection-store race
        // must not turn the whole disconnect into an error response. Loud WARN
        // so a stuck `bound` Connection is still traceable.
        if (!(error instanceof LocalImConnectionError))
            throw error;
        logger.warn({
            operation: 'unbind_connection_cleanup',
            ...(connection ? { connectionId: connection.connectionId } : {}),
            channel,
            agentName,
            code: error.code,
        }, 'legacy unbind could not clear the Connection physical binding');
    }
}
export async function disconnectChannel(input) {
    const body = await readJsonBody(input.request);
    const platform = detectDisconnectPlatform(body);
    const agentName = resolveDisconnectAgentName(body);
    if (platform === 'telegram') {
        if (!input.telegram)
            return json({ ok: true, disconnected: false, localRuntime: true });
        await deleteAgentPlatformChannelBindings(input.infra, 'telegram', agentName);
        const response = await input.telegram.unbind(disconnectRequestWithAgent(body, agentName));
        await clearImConnectionBindingForLegacyUnbind(input.infra, 'telegram', agentName);
        return response;
    }
    if (platform === 'wechat') {
        if (!input.wechat)
            return json({ ok: true, disconnected: false, localRuntime: true });
        await deleteAgentPlatformChannelBindings(input.infra, 'wechat', agentName);
        const response = await input.wechat.unbind(disconnectRequestWithAgent(body, agentName));
        await clearImConnectionBindingForLegacyUnbind(input.infra, 'wechat', agentName);
        return response;
    }
    if (!input.feishu || !isFeishuDisconnectBody(body)) {
        return json({ ok: true, disconnected: false, localRuntime: true });
    }
    if (!isFeishuConnectBody(body) && !(await input.feishu.hasBindingBody(body))) {
        return json({ ok: true, disconnected: false, localRuntime: true });
    }
    await deleteAgentPlatformChannelBindings(input.infra, 'feishu', agentName);
    const response = await input.feishu.unbindBody(body);
    await clearImConnectionBindingForLegacyUnbind(input.infra, 'feishu', agentName);
    return response;
}
export async function unbindFeishu(input) {
    if (!input.feishu)
        return localRunnerUnavailable();
    const requestForUnbind = input.request.clone();
    const body = await readJsonBody(input.request);
    const agentName = readFeishuAgentName(body, 'mavis');
    await deleteAgentPlatformChannelBindings(input.infra, 'feishu', agentName);
    const response = await input.feishu.unbind(requestForUnbind);
    await clearImConnectionBindingForLegacyUnbind(input.infra, 'feishu', agentName);
    return response;
}
/**
 * Sole `telegram/unbind` ingress since the registry-routed adapter handler
 * was removed from `telegram-adapter-routes.ts` (it ran before this route
 * and knew nothing about the Connection model). Mirrors `unbindFeishu` /
 * `unbindWeChat`: delete the legacy per-agent route rows, stop the transport
 * (the API's `onUnbind` seam shuts the poller down and unregisters the
 * adapter), then clear the Connection physical Binding symmetrically.
 */
export async function unbindTelegram(input) {
    if (!input.telegram)
        return localRunnerUnavailable();
    const requestForUnbind = input.request.clone();
    const body = await readJsonBody(input.request);
    const agentName = readAgentName(body);
    // Parity with the removed adapter-route unbind (`deletePlatformBindings`):
    // without this, the default route rows created at bind time survive the
    // unbind and keep routing inbound at a dead binding.
    const deletedRouteBindings = await deleteAgentPlatformChannelBindings(input.infra, 'telegram', agentName);
    logger.info({ operation: 'unbind_route_cleanup', channel: 'telegram', agentName, deletedRouteBindings }, 'legacy telegram unbind cleared platform route bindings');
    const response = await input.telegram.unbind(requestForUnbind);
    await clearImConnectionBindingForLegacyUnbind(input.infra, 'telegram', agentName);
    return response;
}
export async function unbindWeChat(input) {
    if (!input.wechat)
        return localRunnerUnavailable();
    const requestForUnbind = input.request.clone();
    const body = await readJsonBody(input.request);
    const agentName = readAgentName(body);
    await deleteAgentPlatformChannelBindings(input.infra, 'wechat', agentName);
    const response = await input.wechat.unbind(requestForUnbind);
    await clearImConnectionBindingForLegacyUnbind(input.infra, 'wechat', agentName);
    return response;
}
function resolveDisconnectAgentName(body) {
    const explicit = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']);
    if (explicit)
        return explicit;
    const raw = readFirstString(body, ['name', 'clientId', 'client_id']);
    if (!raw)
        return 'mavis';
    const stripped = stripPlatformPrefix(raw).trim();
    return !stripped || isPlatformLiteral(stripped) ? 'mavis' : stripped;
}
function stripPlatformPrefix(value) {
    const lower = value.toLowerCase();
    for (const prefix of ['telegram:', 'wechat:', 'feishu:']) {
        if (lower.startsWith(prefix))
            return value.slice(prefix.length);
    }
    return value;
}
function isPlatformLiteral(value) {
    return ['feishu', 'lark', 'telegram', 'wechat'].includes(value.toLowerCase());
}
function disconnectRequestWithAgent(body, agentName) {
    return new Request('http://local/channel-bridge/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, agentName }),
    });
}
function detectDisconnectPlatform(body) {
    const explicit = readFirstString(body, ['platform']);
    if (explicit === 'telegram' || explicit === 'wechat' || explicit === 'feishu')
        return explicit;
    const name = readFirstString(body, ['name', 'clientId', 'client_id']) ?? '';
    if (name.startsWith('telegram:'))
        return 'telegram';
    if (name.startsWith('wechat:'))
        return 'wechat';
    return 'feishu';
}
function isFeishuDisconnectBody(body) {
    if (isNonFeishuPlatformBody(body))
        return false;
    if (isFeishuConnectBody(body))
        return true;
    const name = readFirstString(body, ['name']);
    return Boolean(name) && !readFirstString(body, ['botToken', 'token']);
}
//# sourceMappingURL=unbind-routes.js.map