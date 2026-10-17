import { DEFAULT_PROJECT_KEY, buildAgentDefaultChannelContext, buildLocalChannelBindingKey, normalizeAbsolutePath, projectKeyForWorkspace, workspaceDirFromProjectKey, } from '../../service/channel-system/index.js';
import { ChannelWireError, channelWireError, isAgentContractLikeError } from './wire-error.js';
export async function resolveChannelStatusExactOwner(agentResolver, agentName) {
    if (!agentName || !agentResolver) {
        throw channelWireError(503, 'Agent read resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
    }
    try {
        const scope = await agentResolver.resolveAgentReadScope(agentName);
        const exactOwnerName = scope.exactOwnerName?.trim() || scope.canonicalName.trim();
        if (exactOwnerName)
            return exactOwnerName;
    }
    catch (err) {
        if (isAgentContractLikeError(err)) {
            throw channelWireError(err.status, err.message, err.code);
        }
        throw err;
    }
    throw channelWireError(409, 'The exact Channel owner is unavailable', 'AGENT_IDENTITY_REQUIRED');
}
export async function resolvePhysicalDefaultBindingKey(input) {
    const clients = Object.values(input.status.clients ?? {}).filter((client) => client !== null &&
        client !== undefined &&
        client.pending !== true &&
        client.clientId === input.bindingId);
    if (clients.length !== 1) {
        throw channelWireError(clients.length === 0 ? 404 : 409, 'The physical Channel binding is unavailable or ambiguous', 'CHANNEL_BINDING_NOT_FOUND');
    }
    const client = clients[0];
    if (!client) {
        throw channelWireError(409, 'The physical Channel binding is unavailable', 'INVALID_RESPONSE');
    }
    const exactOwnerName = await resolveChannelStatusExactOwner(input.agentResolver, client.agentName);
    const binding = selectAgentDefaultStoredChannelBinding(input.bindings, {
        platform: client.platform,
        clientName: client.clientId,
        physicalAgentName: client.agentName,
        exactOwnerName,
    });
    if (!binding?.key) {
        throw channelWireError(409, 'The default Channel routing target is unavailable or ambiguous', 'CHANNEL_DEFAULT_BINDING_REQUIRED');
    }
    return binding.key;
}
export function selectAgentDefaultStoredChannelBinding(bindings, input) {
    const { platform, clientName, physicalAgentName, exactOwnerName } = input;
    if ((platform !== 'feishu' && platform !== 'telegram' && platform !== 'wechat') ||
        !clientName ||
        !physicalAgentName ||
        !exactOwnerName) {
        return undefined;
    }
    const expectedKey = buildLocalChannelBindingKey(buildAgentDefaultChannelContext(platform, physicalAgentName, clientName));
    const matches = bindings.filter((binding) => binding.key === expectedKey &&
        binding.platform === platform &&
        binding.clientName === clientName &&
        binding.exactOwnerName === exactOwnerName &&
        binding.routingMode === 'project-main');
    return matches.length === 1 ? matches[0] : undefined;
}
export function projectStoredChannelBinding(binding) {
    const exactOwnerName = binding.exactOwnerName ?? binding.agentName;
    const projected = {
        ...(exactOwnerName ? { agentName: exactOwnerName } : {}),
        ...(binding.clientName ? { clientName: binding.clientName } : {}),
    };
    if (!exactOwnerName ||
        !binding.projectKey ||
        !binding.routingMode ||
        !binding.sessionId ||
        binding.generation === undefined) {
        return projected;
    }
    return {
        ...projected,
        routingTarget: {
            exactOwnerName,
            ...(binding.ownerInstanceId ? { ownerInstanceId: binding.ownerInstanceId } : {}),
            project: projectRefForChannelProjectKey(binding.projectKey),
            projectKey: binding.projectKey,
            routingMode: binding.routingMode,
            sessionId: binding.sessionId,
            generation: binding.generation,
        },
    };
}
export function projectRefForChannelProjectKey(projectKey) {
    if (projectKey === DEFAULT_PROJECT_KEY)
        return { key: DEFAULT_PROJECT_KEY };
    const workspaceDir = workspaceDirFromProjectKey(projectKey);
    if (!workspaceDir) {
        throw channelWireError(502, 'Stored Channel Project is invalid', 'INVALID_RESPONSE');
    }
    return { key: projectKey, workspaceDir };
}
/** v1 `canonicalChannelProject` twin (target project validation). */
export function canonicalChannelProject(ref) {
    if (ref.projectId !== undefined) {
        throw channelTargetValidationError('project_id is not supported by desktop local-runtime');
    }
    const workspaceDir = normalizeAbsolutePath(ref.workspaceDir);
    if (ref.workspaceDir && !workspaceDir) {
        throw channelTargetValidationError('workspace_dir must be absolute');
    }
    const requestedKey = validatedRequestedProjectKey(ref);
    const projectKey = workspaceDir
        ? projectKeyForWorkspace(workspaceDir)
        : requestedKey || DEFAULT_PROJECT_KEY;
    if (requestedKey && requestedKey !== projectKey) {
        throw channelTargetValidationError('project key and workspace_dir do not match');
    }
    return {
        projectKey,
        ref: projectKey === DEFAULT_PROJECT_KEY
            ? { key: DEFAULT_PROJECT_KEY }
            : { key: projectKey, workspaceDir: workspaceDirFromProjectKey(projectKey) },
    };
}
function validatedRequestedProjectKey(ref) {
    const requestedKey = ref.key?.trim();
    if (requestedKey &&
        requestedKey !== DEFAULT_PROJECT_KEY &&
        workspaceDirFromProjectKey(requestedKey) === undefined) {
        throw channelTargetValidationError('project key must be default or a canonical workspace key');
    }
    return requestedKey;
}
function channelTargetValidationError(message) {
    return channelWireError(400, message, 'VALIDATION_ERROR');
}
//# sourceMappingURL=binding-projection.js.map