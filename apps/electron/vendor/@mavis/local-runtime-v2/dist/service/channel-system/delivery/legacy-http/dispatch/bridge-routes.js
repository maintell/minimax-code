/**
 * Legacy `/channel-bridge` + `/im-bridge` HTTP dispatcher.
 *
 * Migration copy (MR2): the route half of v1 `channels/infra.ts`
 * (`routeLocalChannelBridgeInfraApi` and its helpers), operating on v2
 * channel-system instances only. Adaptation: the Feishu card-action seam is
 * passed in explicitly (`feishuCardActionHandler`) because the v2 infra copy
 * deliberately dropped that field — the composition owns the single handler
 * instance shared with the WS dispatcher (proposal §6.4).
 */
import { json, notFound, readJsonBody } from '../http-helpers.js';
import { readChannelContext } from '../../../ingress/channel-inbound-utils.js';
import { serializeChannelBinding } from '../../../binding/channel-binding-codec.js';
import { routeLocalChannelBindApi } from './bind-routes.js';
import { AgentContractHttpError } from '../agent-contract-error.js';
import { normalizePrimaryAgentResolutionConflict } from '../../../binding/family-gate.js';
import { routeChannelBindingTarget } from './binding-target-route.js';
import { routeLocalAccessControlApi } from './access-control-routes.js';
import { dispatchTelegramAdapterRoute } from './telegram-adapter-routes.js';
import { dispatchWeChatAdapterRoute } from './wechat-adapter-routes.js';
export async function routeLocalChannelBridgeInfraApi(input) {
    const tail = input.parts.slice(1);
    const joined = tail.join('/');
    // Registry-routed `/channel-bridge/telegram/*` endpoints: status + inbound
    // ONLY. `telegram/bind` / `telegram/unbind` deliberately return `undefined`
    // here and fall through to `routeLocalChannelBindApi` below — the single
    // Connection-aware ingress shared by all three channels. The old MR-B
    // wiring handled bind/unbind in this dispatcher first, which silently
    // dropped the request's `connectionId` and left the durable Connection
    // stuck in `configured` while the transport bind succeeded (UI showed
    // "authorization failed"). Inbound dispatch threads the runner when one is
    // wired so `/telegram/inbound` exercises the same `runner.dispatchInbound`
    // flow legacy webhooks use.
    const adapterResponse = await dispatchTelegramAdapterRoute({
        method: input.method,
        path: joined,
        request: input.request,
        registry: input.infra.adapterRegistry,
        dispatcher: input.runner
            ? { dispatchInbound: (dispatchInput) => input.runner.dispatchInbound(dispatchInput) }
            : undefined,
    });
    if (adapterResponse)
        return adapterResponse;
    const wechatAdapterResponse = await dispatchWeChatAdapterRoute({
        method: input.method,
        path: joined,
        request: input.request,
        registry: input.infra.adapterRegistry,
        dispatcher: input.runner
            ? { dispatchInbound: (i) => input.runner.dispatchInbound(i) }
            : undefined,
    });
    if (wechatAdapterResponse)
        return wechatAdapterResponse;
    if (input.method === 'GET' && joined === 'status') {
        const status = await input.infra.status();
        const statusClients = status.clients && typeof status.clients === 'object'
            ? status.clients
            : {};
        const feishuClients = (await input.feishu?.statusClients()) ?? {};
        const telegramClients = (await input.telegram?.statusClients()) ?? {};
        const wechatClients = (await input.wechat?.statusClients()) ?? {};
        const scope = await resolveChannelReadAgent(input.infra, input.url.searchParams.get('agent') ?? input.url.searchParams.get('agentName') ?? undefined);
        const compatibleNames = scope ? new Set(scope.compatibleNames) : undefined;
        const clients = { ...statusClients, ...feishuClients, ...telegramClients, ...wechatClients };
        const filteredClients = compatibleNames
            ? Object.fromEntries(Object.entries(clients).filter(([, value]) => {
                if (!value || typeof value !== 'object')
                    return false;
                const agentName = value.agentName;
                return typeof agentName === 'string' && compatibleNames.has(agentName);
            }))
            : clients;
        return json({
            ...status,
            clients: filteredClients,
            ...(input.runner ? { runner: input.runner.status() } : {}),
        });
    }
    if (input.method === 'GET' && joined === 'available-apps') {
        return json({ apps: ['feishu', 'telegram', 'wechat'], localRuntime: true });
    }
    if (input.method === 'GET' && joined === 'config-check') {
        const platform = input.url.searchParams.get('platform');
        const requestedAgentName = input.url.searchParams.get('agent') ?? input.url.searchParams.get('agentName') ?? undefined;
        const scope = await resolveChannelReadAgent(input.infra, requestedAgentName);
        const names = scope?.compatibleNames;
        const canonicalName = scope?.canonicalName;
        let resourceAmbiguityReported = false;
        const chooseConfig = async (channel, api) => {
            const configuredResults = [];
            const candidates = [];
            let fallback;
            let canonicalResult;
            if (names) {
                for (const name of names) {
                    const check = await api.configCheck(name);
                    if (name === canonicalName)
                        canonicalResult = { ...check, agentName: name };
                    if (check.configured === true) {
                        configuredResults.push({ ...check, agentName: name });
                        candidates.push({ agentName: name, platform: channel });
                    }
                }
            }
            else {
                const check = await api.configCheck(undefined);
                fallback = check;
                if (check.configured === true)
                    configuredResults.push(check);
            }
            if (candidates.length > 1) {
                if (!resourceAmbiguityReported) {
                    resourceAmbiguityReported = true;
                    input.infra.reportResourceAmbiguity(candidates.length);
                }
                return json({
                    configured: false,
                    source: null,
                    hasCredentials: false,
                    platform: channel,
                    localRuntime: true,
                    code: 'AMBIGUOUS_CHANNEL_CONFIG',
                    error: `Channel config for ${channel} is ambiguous`,
                    candidates,
                }, { status: 409 });
            }
            if (configuredResults.length === 1)
                return configuredResults[0];
            const result = fallback ?? canonicalResult ?? (await api.configCheck(canonicalName));
            return { ...result, ...(canonicalName ? { agentName: canonicalName } : {}) };
        };
        if (input.feishu && platform === 'feishu') {
            const result = await chooseConfig('feishu', input.feishu);
            return result instanceof Response ? result : json(result);
        }
        if (input.telegram && platform === 'telegram') {
            const result = await chooseConfig('telegram', input.telegram);
            return result instanceof Response ? result : json(result);
        }
        if (input.wechat && platform === 'wechat') {
            const result = await chooseConfig('wechat', input.wechat);
            return result instanceof Response ? result : json(result);
        }
        if (!platform && (input.feishu || input.telegram || input.wechat)) {
            const chosen = await Promise.all([
                input.feishu ? chooseConfig('feishu', input.feishu) : undefined,
                input.telegram ? chooseConfig('telegram', input.telegram) : undefined,
                input.wechat ? chooseConfig('wechat', input.wechat) : undefined,
            ]);
            const ambiguity = chosen.find((check) => check instanceof Response);
            if (ambiguity)
                return ambiguity;
            const checks = chosen.filter(Boolean);
            const configured = checks.some((check) => check.configured === true);
            return json({
                configured,
                source: configured ? 'local-runtime' : null,
                hasCredentials: configured,
                localRuntime: true,
                runnerEnabled: Boolean(input.runner),
                platforms: Object.fromEntries(checks.map((check) => [String(check.platform), check])),
            });
        }
        return json({
            configured: false,
            source: null,
            hasCredentials: false,
            localRuntime: true,
            runnerEnabled: Boolean(input.runner),
        });
    }
    if (input.method === 'GET' && tail[0] === 'message-filter' && tail[1]) {
        return json(await input.infra.bindingStore.getMessageFilter(tail[1]));
    }
    if (input.method === 'PUT' && tail[0] === 'message-filter' && tail[1]) {
        const body = await readJsonBody(input.request);
        return json({
            ok: true,
            saved: true,
            ...(await input.infra.bindingStore.setMessageFilter(tail[1], {
                mode: body.mode === 'full' ? 'full' : 'result',
                includeToolSummary: body.includeToolSummary === true,
            })),
        });
    }
    // Access Control CRUD lives under /channel-bridge/access-control.
    // Delegate to the dedicated routes module so the channel subsystem
    // does not bloat this 1k+ line dispatcher.
    if (tail[0] === 'access-control') {
        return ((await routeLocalAccessControlApi({
            request: input.request,
            method: input.method,
            parts: tail,
            store: input.infra.accessControlStore,
        })) ?? notFound(`/channel-bridge/${joined}`));
    }
    const bindResponse = await routeLocalChannelBindApi({ ...input, joined });
    if (bindResponse)
        return bindResponse;
    if (input.method === 'POST' && joined === 'feishu/webhook') {
        if (!input.feishu)
            return localRunnerUnavailable();
        return input.feishu.handleEvent(input.request, true, true);
    }
    if (input.method === 'POST' && joined === 'feishu/card-action') {
        // MR-C: Feishu interactive card action callback. Decoded into a
        // ChannelQuestionnaireOptionToken + reply by the host-supplied handler
        // (which knows how to walk the questionnaire store + invoke the
        // LocalChannelQuestionnaireBridge). When unwired, return 503 so the
        // operator notices the gap rather than silently dropping clicks.
        const body = await readJsonBody(input.request);
        const handler = input.feishuCardActionHandler;
        if (!handler) {
            return json({
                ok: false,
                error: 'feishu card-action handler is not wired',
                code: 'FEISHU_CARD_ACTION_UNAVAILABLE',
                localRuntime: true,
            }, { status: 503 });
        }
        return handler(body);
    }
    if (input.method === 'POST' && joined === 'telegram/bind') {
        if (!input.telegram)
            return localRunnerUnavailable();
        return input.telegram.bind(input.request);
    }
    if (input.method === 'POST' && joined === 'telegram/unbind') {
        if (!input.telegram)
            return localRunnerUnavailable();
        return input.telegram.unbind(input.request);
    }
    if (input.method === 'POST' && joined === 'telegram/webhook') {
        if (!input.telegram)
            return localRunnerUnavailable();
        return input.telegram.handleUpdate(input.request, true, true);
    }
    if (input.method === 'GET' && joined === 'wechat/bind/status') {
        if (!input.wechat)
            return localRunnerUnavailable();
        return input.wechat.bindStatus(input.url);
    }
    if (input.method === 'POST' && joined === 'wechat/webhook') {
        if (!input.wechat)
            return localRunnerUnavailable();
        return input.wechat.handleEvent(input.request, true, true);
    }
    if (input.method === 'GET' && tail[0] === 'bindings') {
        const requestedAgentName = input.url.searchParams.get('agent') ?? input.url.searchParams.get('agentName') ?? undefined;
        const scope = await resolveChannelReadAgent(input.infra, requestedAgentName, channelPlatformFromQuery(input.url));
        const sessionId = input.url.searchParams.get('sessionId') ?? undefined;
        const bindings = await input.infra.bindingStore.list({ sessionId });
        return json({
            bindings: bindings
                .filter((binding) => !scope || scope.compatibleNames.includes(binding.agentName))
                .map(serializeChannelBinding),
        });
    }
    const targetResponse = await routeChannelBindingTarget({ ...input, tail });
    if (targetResponse)
        return targetResponse;
    if (input.method === 'POST' && tail[0] === 'bindings') {
        const body = await readJsonBody(input.request);
        const ctx = readChannelContext(body);
        // v2 adaptation: readChannelContext returns the structured wire error;
        // map it back to the exact v1 400 JSON here at the HTTP edge.
        if ('error' in ctx) {
            return json({ error: ctx.error.message, code: ctx.error.code }, { status: ctx.error.status });
        }
        const requestedAgentName = readFirstString(body, ['agentName', 'agentId', 'agent']);
        const agentName = requestedAgentName
            ? await resolveChannelWriteAgent(input.infra, requestedAgentName, ctx.ctx.platform)
            : undefined;
        const sessionId = readFirstString(body, ['sessionId', 'session_id']);
        if (!agentName || !sessionId) {
            return json({ error: 'agentName and sessionId are required' }, { status: 400 });
        }
        const binding = await input.infra.bindingStore.upsert(ctx.ctx, {
            agentName,
            sessionId,
            strategy: normalizeStrategy(readFirstString(body, ['strategy', 'sessionStrategy'])),
            pinned: body.pinned === true,
            routeRuleId: readFirstString(body, ['routeRuleId', 'ruleId']) ?? null,
        });
        return json({ binding: serializeChannelBinding(binding) }, { status: 201 });
    }
    if (input.method === 'DELETE' && tail[0] === 'bindings' && tail[1]) {
        return json({ deleted: await input.infra.bindingStore.deleteByKey(tail[1]), key: tail[1] });
    }
    if (input.method === 'GET' && joined === 'queue/status') {
        return json({
            queue: input.infra.laneQueue.stats(),
            ...(input.runner ? { runner: input.runner.status() } : {}),
            localRuntime: true,
        });
    }
    return notFound(`/channel-bridge/${joined}`);
}
async function resolveChannelReadAgent(infra, requestedName, platform = 'wechat') {
    if (!requestedName)
        return undefined;
    if (!infra.resolveAgentReadScope) {
        throw new AgentContractHttpError(503, 'Agent read resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
    }
    let scope;
    try {
        scope = await infra.resolveAgentReadScope(requestedName);
    }
    catch (err) {
        const primaryConflict = normalizePrimaryAgentResolutionConflict(err, {
            platform,
            canonicalAgentName: 'mavis',
            agentNames: ['mavis', 'main'],
        });
        if (primaryConflict)
            throw primaryConflict;
        throw err;
    }
    return {
        canonicalName: scope.canonicalName,
        compatibleNames: scope.compatibleNames ?? [scope.canonicalName],
    };
}
async function resolveChannelWriteAgent(infra, requestedName, platform) {
    if (!infra.resolveAgentWriteTarget) {
        throw new AgentContractHttpError(503, 'Agent write resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
    }
    try {
        return await infra.resolveAgentWriteTarget(requestedName);
    }
    catch (err) {
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
function channelPlatformFromQuery(url) {
    const platform = url.searchParams.get('platform');
    return platform === 'feishu' || platform === 'telegram' || platform === 'wechat'
        ? platform
        : 'wechat';
}
function normalizeStrategy(value) {
    if (value === 'pin' ||
        value === 'root' ||
        value === 'main' ||
        value === 'per-sender' ||
        value === 'per-chat' ||
        value === 'shared-task') {
        return value;
    }
    return 'root';
}
function readFirstString(raw, keys) {
    for (const key of keys) {
        const value = raw[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
/**
 * Terminal `/compact` receipt for a given {@link CompactionOutcome} code. The
 * success line intentionally omits N→M counts (per spec §D). Unknown / hard
 * failure codes fall back to the generic "unsupported" copy so the sender is
 * never left without feedback.
 */
function localRunnerUnavailable() {
    return json({
        ok: false,
        error: 'Local channel platform runner is not implemented in G6 channel infra.',
        code: 'LOCAL_CHANNEL_RUNNER_UNAVAILABLE',
        localRuntime: true,
    }, { status: 200 });
}
//# sourceMappingURL=bridge-routes.js.map