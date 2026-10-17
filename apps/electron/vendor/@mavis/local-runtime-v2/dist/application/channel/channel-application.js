import { normalizePrimaryAgentResolutionConflict } from '../../service/channel-system/index.js';
import { gatewayErrorCode, gatewayJson, wireErrorFromGatewayResult, } from './channel-gateway.js';
import { canonicalChannelProject, projectRefForChannelProjectKey, projectStoredChannelBinding, resolveChannelStatusExactOwner, resolvePhysicalDefaultBindingKey, selectAgentDefaultStoredChannelBinding, } from './binding-projection.js';
import { channelWireError, isAgentContractLikeError } from './wire-error.js';
export class ChannelApplication {
    gateway;
    agentResolver;
    constructor(deps) {
        this.gateway = deps.gateway;
        this.agentResolver = deps.agentResolver;
    }
    async listChannelConnections(req) {
        return gatewayJson(this.gateway, connectionsPath(req.channelFilter));
    }
    async prepareChannelConnection(req) {
        const project = req.project ? canonicalChannelProject(req.project) : undefined;
        return gatewayJson(this.gateway, '/mavis/api/channel/connections/prepare', {
            method: 'POST',
            body: {
                channel: req.channel,
                agentName: req.agentName,
                projectKey: project?.projectKey ?? null,
            },
        });
    }
    async disconnectChannelConnection(req) {
        return gatewayJson(this.gateway, `/mavis/api/channel/connections/${encodeURIComponent(req.connectionId)}/binding`, { method: 'DELETE' });
    }
    async deleteChannelConnection(req) {
        return gatewayJson(this.gateway, `/mavis/api/channel/connections/${encodeURIComponent(req.connectionId)}`, { method: 'DELETE' });
    }
    async cancelChannelAuthorization(req) {
        return gatewayJson(this.gateway, `/mavis/api/channel/connections/${encodeURIComponent(req.connectionId)}/authorization/cancel`, { method: 'POST' });
    }
    async listChannelBindings(req) {
        const wanted = req.channelFilter;
        const [status, stored, v2Bindings] = await Promise.all([
            gatewayJson(this.gateway, '/mavis/api/channel-bridge/status'),
            gatewayJson(this.gateway, '/mavis/api/channel-bridge/bindings'),
            this.listV2ChannelBindings(wanted),
        ]);
        const wantedAgents = await this.resolveWantedAgents(req.agentName?.trim(), wanted);
        const visibleV2Bindings = v2Bindings.filter((binding) => (!wanted || binding.channel === wanted) &&
            (!wantedAgents || wantedAgents.has(binding.agentName)));
        const projectedV2Bindings = await Promise.all(visibleV2Bindings.map(async (binding) => {
            const exactOwnerName = await resolveChannelStatusExactOwner(this.agentResolver, binding.agentName);
            return {
                bindingId: binding.bindingId,
                channel: binding.channel,
                externalId: binding.clientName,
                clientName: binding.clientName,
                enabled: true,
                createdAt: binding.createdAt,
                updatedAt: binding.updatedAt,
                status: 1,
                agentName: exactOwnerName,
                ...(binding.currentSessionId
                    ? {
                        routingTarget: {
                            exactOwnerName,
                            project: projectRefForChannelProjectKey(binding.projectKey),
                            projectKey: binding.projectKey,
                            routingMode: 'project-main',
                            sessionId: binding.currentSessionId,
                            generation: binding.updatedAt,
                        },
                    }
                    : {}),
            };
        }));
        const v2TransportClients = new Set(visibleV2Bindings.map((binding) => `${binding.channel}\u0000${binding.clientName}`));
        const visibleClients = Object.values(status.clients ?? {}).filter((c) => {
            // Skip half-finished QR binds (`pending`): a not-yet-scanned bind must
            // not surface as a real binding. Mirrors the renderer's
            // `hasBoundChannelForAgent` pending exclusion.
            if (!c || c.pending === true)
                return false;
            return ((!wanted || c.platform === wanted) &&
                (!wantedAgents || wantedAgents.has(c.agentName ?? '')) &&
                !v2TransportClients.has(`${c.platform ?? ''}\u0000${c.clientId ?? ''}`));
        });
        const legacyBindings = await Promise.all(visibleClients.map(async (c) => {
            const exactOwnerName = await this.resolveExactOwnerOrUndefined(c.agentName);
            const persisted = selectAgentDefaultStoredChannelBinding(stored.bindings ?? [], {
                platform: c.platform,
                clientName: c.clientId,
                physicalAgentName: c.agentName,
                exactOwnerName,
            });
            return {
                // IDL: desktop binding_id mirrors the transport clientId.
                bindingId: c.clientId ?? '',
                channel: c.platform ?? '',
                externalId: c.clientId ?? '',
                label: c.botName ?? '',
                enabled: c.enabled ?? true,
                createdAt: c.createdAt ?? 0,
                updatedAt: c.updatedAt ?? 0,
                // Connection health remains a separate status-snapshot axis.
                status: 1,
                ...(persisted ? projectStoredChannelBinding(persisted) : {}),
            };
        }));
        return { bindings: [...projectedV2Bindings, ...legacyBindings] };
    }
    async unbindChannel(req) {
        // bindingId == clientId (see listChannelBindings). Decode platform+agent the
        // same way the renderer's `agentNameForClient` does: wechat:/telegram: carry
        // a prefix, feishu uses the bare agent name.
        const id = (req.bindingId ?? '').trim();
        let platform;
        let agentName;
        if (id.startsWith('wechat:')) {
            platform = 'wechat';
            agentName = id.slice('wechat:'.length);
        }
        else if (id.startsWith('telegram:')) {
            platform = 'telegram';
            agentName = id.slice('telegram:'.length);
        }
        else {
            platform = 'feishu';
            agentName = id;
        }
        if (!agentName) {
            throw channelWireError(400, 'unbindChannel: empty bindingId', 'VALIDATION_ERROR');
        }
        const result = await gatewayJson(this.gateway, `/mavis/api/channel-bridge/${platform}/unbind`, { method: 'POST', body: { agentName } });
        return { ok: result.ok ?? result.unbound ?? true };
    }
    /** Retains the V2 physical Binding id for CAS, with the legacy lookup as fallback. */
    async updateChannelBindingTarget(req) {
        const project = canonicalChannelProject(req.target.project);
        const bindingKey = await this.resolveBindingKeyForTargetUpdate(req.bindingId);
        const result = await gatewayJson(this.gateway, `/mavis/api/channel-bridge/bindings/${encodeURIComponent(bindingKey)}/target`, {
            method: 'POST',
            body: {
                agentName: req.target.agentName,
                projectKey: project.projectKey,
                routingMode: req.target.routingMode,
                ...(req.target.sessionId ? { sessionId: req.target.sessionId } : {}),
                ...(req.target.ownerInstanceId ? { ownerInstanceId: req.target.ownerInstanceId } : {}),
                expectedGeneration: req.expectedGeneration,
            },
        });
        return mapBindingTargetResponse(req, project.ref, result.binding);
    }
    /**
     * Existing V2 physical Binding ids pass through for CAS; anything else is
     * resolved against the legacy status + stored-binding views (v1 fallback).
     */
    async resolveBindingKeyForTargetUpdate(bindingId) {
        const v2Binding = (await this.listV2ChannelBindings()).find((binding) => binding.bindingId === bindingId);
        if (v2Binding)
            return bindingId;
        const [status, stored] = await Promise.all([
            gatewayJson(this.gateway, '/mavis/api/channel-bridge/status'),
            gatewayJson(this.gateway, '/mavis/api/channel-bridge/bindings'),
        ]);
        return resolvePhysicalDefaultBindingKey({
            bindingId,
            status,
            bindings: stored.bindings ?? [],
            agentResolver: this.agentResolver,
        });
    }
    /**
     * Read-scope filter for the requested agent (v1 listChannelBindings head).
     * A manual row that illegally occupies `mavis`/`main` is fail-closed for
     * normal family resolution, but the user must still be able to see and
     * exact-unbind the inert physical channel rows. That display-only recovery
     * keeps both primary names visible; it neither chooses a winner nor makes
     * the records eligible for bind/start.
     */
    async resolveWantedAgents(requestedAgent, wanted) {
        if (!requestedAgent)
            return undefined;
        try {
            if (!this.agentResolver) {
                throw channelWireError(503, 'Agent read resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
            }
            const scope = await this.agentResolver.resolveAgentReadScope(requestedAgent);
            return new Set(scope.compatibleNames ?? [scope.canonicalName]);
        }
        catch (err) {
            return recoverWantedAgentsFromDisplayConflict(err, requestedAgent, wanted);
        }
    }
    /** Legacy rows keep rendering when owner resolution fails (v1 `.catch`). */
    async resolveExactOwnerOrUndefined(agentName) {
        try {
            return await resolveChannelStatusExactOwner(this.agentResolver, agentName);
        }
        catch {
            return undefined;
        }
    }
    async bindTelegram(req) {
        return gatewayJson(this.gateway, '/mavis/api/channel-bridge/telegram/bind', {
            method: 'POST',
            body: {
                botToken: req.botToken,
                ...(req.agentName ? { agentName: req.agentName } : {}),
                ...(req.connectionId ? { connectionId: req.connectionId } : {}),
            },
        });
    }
    async startWechatBind(req) {
        return gatewayJson(this.gateway, '/mavis/api/channel-bridge/wechat/bind/start', {
            method: 'POST',
            body: {
                ...(req.agentName ? { agentName: req.agentName } : {}),
                ...(req.connectionId ? { connectionId: req.connectionId } : {}),
            },
        });
    }
    async getWechatBindStatus(req) {
        return gatewayJson(this.gateway, `/mavis/api/channel-bridge/wechat/bind/status?sessionId=${encodeURIComponent(req.sessionId)}`);
    }
    async bindFeishu(req) {
        return gatewayJson(this.gateway, '/mavis/api/channel-bridge/feishu/bind', {
            method: 'POST',
            body: {
                appId: req.appId,
                appSecret: req.appSecret,
                ...(req.encryptKey ? { encryptKey: req.encryptKey } : {}),
                ...(req.agentName ? { agentName: req.agentName } : {}),
                ...(req.connectionId ? { connectionId: req.connectionId } : {}),
            },
        });
    }
    async startLarkOnboard(req) {
        return gatewayJson(this.gateway, '/mavis/api/lark/onboard/start', {
            method: 'POST',
            body: {
                ...(req.name !== undefined ? { name: req.name } : {}),
                ...(req.agentName !== undefined ? { agentName: req.agentName } : {}),
                ...(req.brand !== undefined ? { brand: req.brand } : {}),
                ...(req.skipUserAuth !== undefined ? { skipUserAuth: req.skipUserAuth } : {}),
                ...(req.connectionId !== undefined ? { connectionId: req.connectionId } : {}),
            },
        });
    }
    async getLarkOnboardStatus(req) {
        return gatewayJson(this.gateway, `/mavis/api/lark/onboard/status?sessionId=${encodeURIComponent(req.sessionId)}`);
    }
    async cancelLarkOnboard(req) {
        const result = await gatewayJson(this.gateway, '/mavis/api/lark/onboard/cancel', { method: 'POST', body: { sessionId: req.sessionId } });
        return {
            ok: result.ok,
            ...(result.cancelled !== undefined
                ? { alreadyGone: result.ok === true && result.cancelled === false }
                : {}),
        };
    }
    /**
     * The Connection endpoint is the only authority for V2 physical Bindings.
     * Older local runtimes deliberately report it as unavailable; retain their
     * legacy projection in that one case, but surface every other read failure.
     */
    async listV2ChannelBindings(channelFilter) {
        const result = await this.gateway.request(connectionsPath(channelFilter));
        if (!result.ok) {
            const code = gatewayErrorCode(result);
            if (result.status === 503 && code === 'CHANNEL_CONNECTIONS_UNAVAILABLE')
                return [];
            throw wireErrorFromGatewayResult(result);
        }
        let payload;
        try {
            payload = JSON.parse(result.bodyText);
        }
        catch {
            throw invalidV2ChannelBindingProjection();
        }
        if (!isRecord(payload) || !Array.isArray(payload.connections)) {
            throw invalidV2ChannelBindingProjection();
        }
        return payload.connections.flatMap((connection) => {
            const binding = parseV2ChannelBindingProjection(connection);
            return binding ? [binding] : [];
        });
    }
}
/** v1 tail of `updateChannelBindingTarget`: response completeness + DTO. */
function mapBindingTargetResponse(req, projectRef, binding) {
    if (!hasCompleteBindingTarget(binding)) {
        throw channelWireError(502, 'Channel binding target response is incomplete', 'INVALID_RESPONSE');
    }
    return {
        binding: {
            bindingId: req.bindingId,
            channel: binding.platform ?? '',
            externalId: binding.clientName ?? '',
            enabled: true,
            createdAt: binding.createdAt ?? 0,
            updatedAt: binding.updatedAt ?? 0,
            status: 1,
            agentName: binding.agentName ?? binding.exactOwnerName,
            clientName: binding.clientName,
            routingTarget: buildBindingRoutingTarget(binding, projectRef, req.target.routingMode),
        },
    };
}
/** v1 completeness guard as a predicate so narrowing flows to the helpers. */
function hasCompleteBindingTarget(binding) {
    return Boolean(binding?.exactOwnerName && binding.projectKey && binding.generation !== undefined);
}
/** routingTarget projection for {@link mapBindingTargetResponse}. */
function buildBindingRoutingTarget(binding, projectRef, fallbackRoutingMode) {
    return {
        exactOwnerName: binding.exactOwnerName,
        ...(binding.ownerInstanceId ? { ownerInstanceId: binding.ownerInstanceId } : {}),
        project: projectRef,
        projectKey: binding.projectKey,
        routingMode: binding.routingMode ?? fallbackRoutingMode,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
        generation: binding.generation,
    };
}
/**
 * v1 listChannelBindings catch: the display-only recovery for the reserved
 * primary-name conflict; every other failure keeps its legacy contract.
 */
function recoverWantedAgentsFromDisplayConflict(err, requestedAgent, wanted) {
    const primaryConflict = normalizePrimaryAgentResolutionConflict(err, {
        platform: wanted === 'feishu' || wanted === 'telegram' || wanted === 'wechat' ? wanted : 'wechat',
        canonicalAgentName: 'mavis',
        agentNames: ['mavis', 'main'],
    });
    if (primaryConflict &&
        (requestedAgent.toLowerCase() === 'mavis' || requestedAgent.toLowerCase() === 'main')) {
        return new Set(['mavis', 'main']);
    }
    if (isAgentContractLikeError(err)) {
        throw channelWireError(err.status, err.message, err.code);
    }
    throw err;
}
function connectionsPath(channelFilter) {
    return channelFilter
        ? `/mavis/api/channel/connections?channel_filter=${encodeURIComponent(channelFilter)}`
        : '/mavis/api/channel/connections';
}
function parseV2ChannelBindingProjection(raw) {
    if (!isRecord(raw))
        throw invalidV2ChannelBindingProjection();
    if (raw.state !== 'bound')
        return undefined;
    const binding = asRecord(raw.binding);
    const connectionId = requiredProjectionString(raw.connectionId);
    const channel = requiredProjectionChannel(raw.channel);
    const agentName = requiredProjectionString(raw.agentName);
    const bindingId = requiredProjectionString(binding.bindingId);
    const bindingChannel = requiredProjectionChannel(binding.channel);
    const clientName = requiredProjectionString(binding.externalId);
    const createdAt = requiredProjectionTimestamp(binding.createdAt);
    const updatedAt = requiredProjectionTimestamp(binding.updatedAt);
    if (bindingChannel !== channel)
        throw invalidV2ChannelBindingProjection();
    const project = raw.project === undefined ? undefined : asRecord(raw.project);
    const projectKey = project ? requiredProjectionString(project.key) : 'default';
    const rawCurrentSessionId = binding.currentSessionId;
    const currentSessionId = rawCurrentSessionId === undefined ? undefined : requiredProjectionString(rawCurrentSessionId);
    return {
        bindingId,
        connectionId,
        channel,
        clientName,
        agentName,
        projectKey,
        createdAt,
        updatedAt,
        ...(currentSessionId ? { currentSessionId } : {}),
    };
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function asRecord(value) {
    if (!isRecord(value))
        throw invalidV2ChannelBindingProjection();
    return value;
}
function requiredProjectionString(value) {
    if (typeof value !== 'string' || !value.trim())
        throw invalidV2ChannelBindingProjection();
    return value.trim();
}
function requiredProjectionChannel(value) {
    const channel = requiredProjectionString(value);
    if (channel !== 'feishu' && channel !== 'telegram' && channel !== 'wechat') {
        throw invalidV2ChannelBindingProjection();
    }
    return channel;
}
function requiredProjectionTimestamp(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw invalidV2ChannelBindingProjection();
    }
    return value;
}
function invalidV2ChannelBindingProjection() {
    return channelWireError(502, 'Channel Connection projection is invalid', 'INVALID_RESPONSE');
}
//# sourceMappingURL=channel-application.js.map