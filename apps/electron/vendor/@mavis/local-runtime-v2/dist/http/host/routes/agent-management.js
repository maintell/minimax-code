import { isAgentNotFoundError } from '../../../service/agent/index.js';
import { logger } from '../../../infra/logging/logger.js';
import { buildGeneratedAgentName, isValidLocalAgentName, json, notFound, readFirstString, readString, } from '../../../infra/transport/host-http.js';
/** HTTP management mapping for the Agent owner; Session routing stays with the caller. */
export class LocalAgentManagementRoutes {
    ctx;
    constructor(ctx) {
        this.ctx = ctx;
    }
    async routeCustomAgentAvatar(agentName) {
        try {
            const avatar = await this.ctx.agentRuntimePort.readCustomAgentAvatar(agentName);
            if (!avatar)
                return notFound(`/agent/${agentName}/identity/avatar`);
            // Copy at the DOM boundary so Node's Uint8Array<ArrayBufferLike> is a BodyInit.
            return new Response(new Uint8Array(avatar.bytes), {
                headers: {
                    'Content-Type': avatar.contentType,
                    'Cache-Control': 'private, no-store',
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        }
        catch (error) {
            if (isAgentNotFoundError(error))
                return notFound(`/agent/${agentName}/identity/avatar`);
            const candidate = Object(error);
            if (typeof candidate.status === 'number' &&
                typeof candidate.code === 'string' &&
                candidate.code.startsWith('AGENT_')) {
                return json({
                    error: error instanceof Error ? error.message : 'Agent avatar is unavailable.',
                    code: candidate.code,
                }, { status: candidate.status });
            }
            throw error;
        }
    }
    async getLocalAgent(name) {
        try {
            const resp = await this.ctx.agentRuntimePort.getAgent({
                name,
                include: 'identity,persona,system_prompt',
            });
            return resp.agent ? detailToRecord(resp.agent) : undefined;
        }
        catch (err) {
            if (isAgentNotFoundError(err))
                return undefined;
            logger.error({
                scope: 'agent-routes',
                op: 'getLocalAgent',
                agentName: name,
                err: err instanceof Error ? err.message : String(err),
            }, 'getLocalAgent via Agent runtime port failed');
            throw err;
        }
    }
    async listLocalAgents() {
        // The primary Agent is projected separately by the Session route owner.
        const resp = await this.ctx.agentRuntimePort.listAgents({
            include: 'identity',
            excludePrimary: true,
        });
        return (resp.agents ?? []).map(detailToRecord);
    }
    async createLocalAgent(body) {
        const requestedName = readString(body, 'name');
        const agentName = requestedName ?? buildGeneratedAgentName();
        if (!isValidLocalAgentName(agentName)) {
            return json({
                error: `Invalid agent name: "${agentName}"`,
                code: 'INVALID_AGENT_NAME',
                errorCode: 40001,
            }, { status: 400 });
        }
        // The V2 owner writes; this read-only guard also protects historical Agent keys.
        if (agentName === this.ctx.agentName ||
            (await this.getLocalAgent(agentName)) ||
            (await this.ctx.hasLegacyAgent(agentName))) {
            return json({
                error: `Agent name "${agentName}" already exists`,
                code: 'AGENT_NAME_CONFLICT',
                errorCode: 40901,
            }, { status: 409 });
        }
        const request = createAgentRequest(this.ctx, body, agentName, requestedName);
        try {
            const created = await this.ctx.agentRuntimePort.createAgent(request);
            return json({ name: created.name, rootSessionId: created.rootSessionId }, { status: 201 });
        }
        catch (error) {
            return createAgentErrorResponse(error);
        }
    }
}
function createAgentErrorResponse(error) {
    if (isAgentNotFoundError(error))
        return notFound('/agent');
    const status = typeof Object(error).status === 'number' ? Object(error).status : 500;
    const code = typeof Object(error).code === 'string' ? Object(error).code : 'INTERNAL_ERROR';
    return json({ error: error instanceof Error ? error.message : String(error), code }, { status });
}
function createAgentRequest(ctx, body, agentName, requestedName) {
    return {
        name: agentName,
        displayName: readFirstString(body, ['displayName', 'display_name']) ?? requestedName ?? agentName,
        ...optionalAgentDetails({
            description: readString(body, 'description'),
            avatar: readString(body, 'avatar'),
            persona: readFirstString(body, ['persona']),
            systemPrompt: readFirstString(body, ['systemPrompt', 'system_prompt']),
            defaultWorkspaceDir: readFirstString(body, ['defaultWorkspaceDir', 'default_workspace_dir']) ??
                ctx.resolveDefaultWorkspaceDir(),
        }),
    };
}
function optionalAgentDetails(detail) {
    return {
        ...(detail.description ? { description: detail.description } : {}),
        ...(detail.avatar ? { avatar: detail.avatar } : {}),
        ...(detail.persona ? { persona: detail.persona } : {}),
        ...(detail.systemPrompt ? { systemPrompt: detail.systemPrompt } : {}),
        ...(detail.defaultWorkspaceDir ? { defaultWorkspaceDir: detail.defaultWorkspaceDir } : {}),
    };
}
function detailToRecord(detail) {
    // thrift: 1=manual, 2=auto, 3=builtin, 0=unknown. Builtins are not user-managed IM records.
    const creationSource = detail.creationSource === 1 ? 'manual' : 'auto';
    return {
        name: detail.name ?? '',
        displayName: detail.displayName ?? detail.name ?? '',
        ...optionalAgentDetails(detail),
        creationSource,
        rootSessionId: detail.rootSessionId ?? '',
        createdAtMs: detail.createdAt ?? 0,
        updatedAtMs: detail.updatedAt ?? 0,
    };
}
//# sourceMappingURL=agent-management.js.map