/**
 * Telegram adapter route helper — drives the registry-backed
 * `/channel-bridge/telegram/status` and `/channel-bridge/telegram/inbound`
 * endpoints through the {@link LocalChannelAdapterRegistry}.
 *
 * `telegram/bind` and `telegram/unbind` are deliberately NOT handled here.
 * They used to be (MR-B), but this dispatcher runs BEFORE
 * `routeLocalChannelBindApi` in `routeLocalChannelBridgeInfraApi`, so it
 * swallowed every telegram bind/unbind while knowing nothing about the IM
 * Connection model: the request's `connectionId` was ignored, the durable
 * Connection never left `configured`, and the new Channel page reported a
 * bogus "authorization failed" even though the transport bind succeeded.
 * Bind/unbind now fall through to `channel-bind-routes.ts` /
 * `channel-unbind-routes.ts` — the single ingress where Connection state,
 * reconcile diagnostics, and legacy default bindings are all written for the
 * three channels (feishu / telegram / wechat) alike.
 *
 * Lives in its own file so {@link telegram-adapter.ts} stays under the
 * default 500-line source budget. Both files are tightly coupled (the routes
 * only know how to talk to a `TelegramPlatformAdapter`), but split keeps the
 * adapter class self-contained and the route surface easy to evolve.
 *
 * The dispatcher returns `undefined` when the path does not match one of
 * the adapter-routed endpoints. The caller (the infra route handler) then
 * falls through to the bind/unbind ingress and its own legacy webhook
 * branches, which stay wired against `LocalTelegramChannelApi`.
 */
import { json, readFirstString, readJsonBody } from '../http-helpers.js';
import { telegramClientId } from '../../../transport/telegram/telegram-store.js';
import { downloadAttachmentsForUnifiedInbound, ensureUnifiedInboundText, } from '../../../transport/telegram/telegram-adapter-shared.js';
const ADAPTER_UNAVAILABLE = {
    status: 503,
    body: { ok: false, error: 'telegram adapter not registered', code: 'ADAPTER_UNAVAILABLE' },
};
/**
 * Dispatch a registry-backed `/channel-bridge/telegram/*` request. Returns
 * `undefined` for paths that are not handled here — including
 * `telegram/bind` / `telegram/unbind`, which MUST keep falling through to
 * the Connection-aware ingress in `channel-bind-routes.ts` (see the file
 * header for why).
 *
 * Endpoints (all under `/channel-bridge/telegram/`):
 *   - `GET   status`   → registry.adapter.status()
 *   - `POST  inbound`  → adapter.normalizeInbound() → dispatcher (when wired)
 */
export async function dispatchTelegramAdapterRoute(input) {
    const { method, path, request, registry, dispatcher } = input;
    const defaultAgentName = dispatcher?.defaultAgentName ?? 'mavis';
    if (method === 'GET' && path === 'telegram/status') {
        const url = new URL(request.url);
        const agentName = url.searchParams.get('agent') ?? defaultAgentName;
        const adapter = registry.get('telegram', telegramClientId(agentName));
        if (!adapter)
            return json(ADAPTER_UNAVAILABLE.body, { status: ADAPTER_UNAVAILABLE.status });
        const result = await adapter.status({ agentName });
        return json({
            ok: true,
            platform: 'telegram',
            clientId: result.clientName,
            configured: result.configured,
            connected: result.connected,
            ...(result.detail ? { detail: result.detail } : {}),
            localRuntime: true,
        });
    }
    if (method === 'POST' && path === 'telegram/inbound') {
        const body = await readJsonBody(request);
        const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? defaultAgentName;
        const adapter = registry.get('telegram', telegramClientId(agentName));
        if (!adapter)
            return json(ADAPTER_UNAVAILABLE.body, { status: ADAPTER_UNAVAILABLE.status });
        let envelope;
        try {
            envelope = await adapter.normalizeInbound({
                clientName: adapter.clientName,
                raw: body,
            });
        }
        catch (err) {
            return json({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                code: 'INVALID_PAYLOAD',
            }, { status: 400 });
        }
        if (dispatcher?.dispatchInbound) {
            // Multimodal inbound: resolve attachmentRefs to local files via the
            // adapter's downloadAttachmentToLocal. Failures degrade gracefully —
            // each failed ref becomes a `download_failed` placeholder and the
            // rest of the batch is dispatched unchanged.
            const attachments = await downloadAttachmentsForUnifiedInbound(adapter, envelope);
            const dispatched = await dispatcher.dispatchInbound({
                ctx: envelope.ctx,
                text: ensureUnifiedInboundText(envelope.text, envelope.attachmentRefs),
                ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
            });
            return json({ ok: true, envelope, dispatched, localRuntime: true });
        }
        return json({ ok: true, envelope, localRuntime: true });
    }
    return undefined;
}
//# sourceMappingURL=telegram-adapter-routes.js.map