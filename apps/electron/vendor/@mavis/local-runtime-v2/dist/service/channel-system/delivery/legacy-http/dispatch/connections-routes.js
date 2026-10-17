import { json, notFound, readFirstString, readJsonBody } from '../http-helpers.js';
import { AgentContractHttpError, isAgentContractLikeError } from '../agent-contract-error.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { DEFAULT_PROJECT_KEY, normalizeAbsolutePath, projectKeyForWorkspace, workspaceDirFromProjectKey, } from '../project-key.js';
import { LocalImConnectionError, } from '../../../binding/im-connection-types.js';
export async function routeLocalChannelConnectionsApi(input) {
    if (input.parts[0] !== 'channel' || input.parts[1] !== 'connections')
        return undefined;
    const store = input.infra.imConnectionStore;
    if (!store) {
        return json({
            error: 'Channel Connections require the Local Runtime V2 Conversation composition.',
            code: 'CHANNEL_CONNECTIONS_UNAVAILABLE',
        }, { status: 503 });
    }
    let operation;
    let connectionIdForLog;
    try {
        if (input.method === 'GET' && input.parts.length === 2) {
            const rawChannelFilter = input.url.searchParams.get('channel_filter');
            const channelFilter = rawChannelFilter === null ? undefined : readChannel(rawChannelFilter);
            if (rawChannelFilter !== null && !channelFilter) {
                return json({ error: 'channel_filter is invalid', code: 'VALIDATION_ERROR' }, { status: 400 });
            }
            return json({
                connections: await serializeConnectionViews(input, await store.listViews(channelFilter)),
            });
        }
        if (input.method === 'POST' && input.parts[2] === 'prepare' && input.parts.length === 3) {
            operation = 'prepare';
            const body = await readJsonBody(input.request);
            const channel = readChannel(body.channel);
            const requestedAgentName = readFirstString(body, ['agentName', 'agent_name']);
            if (!channel || !requestedAgentName) {
                logConnectionMutationFailure(operation, undefined, 400, 'VALIDATION_ERROR');
                return json({ error: 'channel and agent_name are required', code: 'VALIDATION_ERROR' }, { status: 400 });
            }
            const agentName = await resolveWriteAgent(input.infra, requestedAgentName);
            const projectKey = readProjectKey(body);
            if (projectKey === undefined) {
                logConnectionMutationFailure(operation, undefined, 400, 'VALIDATION_ERROR');
                return json({ error: 'project_key is invalid', code: 'VALIDATION_ERROR' }, { status: 400 });
            }
            const connection = await store.prepare({
                agentName,
                channel,
                projectKey,
                resolvedProjectKey: projectKey ?? DEFAULT_PROJECT_KEY,
            });
            const view = await viewForConnection(input, store.listViews(), connection.connectionId);
            logConnectionMutation({
                operation,
                connectionId: connection.connectionId,
                connection,
                state: view.state,
                deleted: false,
            });
            return json({ connection: view });
        }
        const connectionId = input.parts[2];
        if (!connectionId)
            return notFound(`/channel/connections/${input.parts.slice(2).join('/')}`);
        connectionIdForLog = connectionId;
        if (input.method === 'DELETE' && input.parts.length === 3) {
            operation = 'delete';
            let deletedConnection;
            const deleted = await store.deleteConnection(connectionId, async (snapshot) => {
                deletedConnection = snapshot.connection;
                const view = {
                    connection: snapshot.connection,
                    state: connectionSnapshotState(snapshot),
                    ...(snapshot.binding ? { binding: snapshot.binding } : {}),
                };
                if (snapshot.binding) {
                    await disconnectPlatformBinding(input, view);
                }
                else if (snapshot.authorization) {
                    await cancelPlatformAuthorization(input, view, snapshot.authorization.channel);
                }
            });
            logConnectionMutation({
                operation,
                connectionId,
                connection: deletedConnection,
                state: 'deleted',
                deleted,
            });
            return json({ deleted });
        }
        if (input.method === 'DELETE' && input.parts[3] === 'binding' && input.parts.length === 4) {
            operation = 'unbind';
            const view = await requireConnectionView(store.listViews(), connectionId);
            if (view.binding)
                await disconnectPlatformBinding(input, view);
            const deleted = await store.deleteBinding(connectionId);
            const connection = await viewForConnection(input, store.listViews(), connectionId);
            logConnectionMutation({
                operation,
                connectionId,
                connection: view.connection,
                state: connection.state,
                deleted,
            });
            return json({ connection });
        }
        if (input.method === 'POST' &&
            input.parts[3] === 'authorization' &&
            input.parts[4] === 'cancel' &&
            input.parts.length === 5) {
            operation = 'cancel';
            const initialView = await requireConnectionView(store.listViews(), connectionId);
            const authorization = store.getAuthorization(connectionId);
            if (authorization) {
                await cancelPlatformAuthorization(input, initialView, authorization.channel);
            }
            // Bind and cancel share the Connection lane. If a platform success
            // callback committed while its adapter cancellation was in flight,
            // clearing authorization first prevents any later callback from
            // re-binding; then tear down that winning physical Binding as well.
            const cancelled = await store.cancelAuthorization(connectionId);
            if (authorization && cancelled.binding) {
                const boundView = await requireConnectionView(store.listViews(), connectionId);
                await disconnectPlatformBinding(input, boundView);
                await store.deleteBinding(connectionId);
                const after = await requireConnectionView(store.listViews(), connectionId);
                if (after.binding) {
                    throw new LocalImConnectionError(409, 'CHANNEL_CONNECTION_CANCEL_RACE', 'The Channel Connection could not be cancelled cleanly.');
                }
            }
            const connection = await viewForConnection(input, store.listViews(), connectionId);
            logConnectionMutation({
                operation,
                connectionId,
                connection: initialView.connection,
                state: connection.state,
                deleted: false,
            });
            return json({ connection });
        }
        return notFound(`/channel/connections/${input.parts.slice(2).join('/')}`);
    }
    catch (error) {
        if (error instanceof LocalImConnectionError || isAgentContractLikeError(error)) {
            if (operation) {
                logConnectionMutationFailure(operation, connectionIdForLog, error.status, error.code);
            }
            return json({ error: error.message, code: error.code }, { status: error.status });
        }
        if (operation)
            logConnectionMutationUnexpectedFailure(operation, connectionIdForLog, error);
        throw error;
    }
}
function readChannel(value) {
    return value === 'feishu' || value === 'telegram' || value === 'wechat' ? value : undefined;
}
/** Undefined means malformed; null means explicit no-project selection. */
function readProjectKey(body) {
    const direct = body.projectKey ?? body.project_key;
    if (direct === null)
        return null;
    if (typeof direct === 'string')
        return direct.trim() || undefined;
    const project = body.project;
    if (project === undefined || project === null)
        return null;
    if (!project || typeof project !== 'object' || Array.isArray(project))
        return undefined;
    const value = project;
    const key = value.key;
    if (typeof key === 'string' && key.trim())
        return key.trim();
    if (key !== undefined && key !== null)
        return undefined;
    const workspaceDir = typeof value.workspaceDir === 'string' ? normalizeAbsolutePath(value.workspaceDir) : undefined;
    if (value.workspaceDir !== undefined && !workspaceDir)
        return undefined;
    return workspaceDir ? projectKeyForWorkspace(workspaceDir) : null;
}
async function resolveWriteAgent(infra, requestedAgentName) {
    if (!infra.resolveAgentWriteTarget) {
        throw new AgentContractHttpError(503, 'Agent write resolver is unavailable', 'AGENT_RESOLVER_UNAVAILABLE');
    }
    return infra.resolveAgentWriteTarget(requestedAgentName);
}
async function requireConnectionView(list, connectionId) {
    const view = (await list).find((candidate) => candidate.connection.connectionId === connectionId);
    if (!view) {
        throw new LocalImConnectionError(404, 'CHANNEL_CONNECTION_NOT_FOUND', 'Channel Connection not found.');
    }
    return view;
}
async function viewForConnection(input, list, connectionId) {
    const view = await requireConnectionView(list, connectionId);
    return serializeConnectionView(view, await feishuStatusSnapshot(input, [view]));
}
async function serializeConnectionViews(input, views) {
    const feishuClients = await feishuStatusSnapshot(input, views);
    return views.map((view) => serializeConnectionView(view, feishuClients));
}
async function feishuStatusSnapshot(input, views) {
    if (!input.feishu || !views.some((view) => view.binding?.channel === 'feishu'))
        return undefined;
    try {
        const clients = await input.feishu.statusClients();
        if (clients && typeof clients === 'object' && !Array.isArray(clients))
            return clients;
        logger.warn({
            operation: 'feishu_status_snapshot',
            resultType: describeStatusSnapshotType(clients),
        }, 'Feishu Connection status snapshot returned an invalid shape');
        return undefined;
    }
    catch (error) {
        logger.warn({ operation: 'feishu_status_snapshot', errorName: safeErrorName(error) }, 'Feishu Connection status snapshot failed');
        return undefined;
    }
}
function logConnectionMutation(input) {
    logger.info({
        operation: input.operation,
        connectionId: input.connectionId,
        ...(input.connection
            ? {
                channel: input.connection.channel,
                agentName: input.connection.agentName,
            }
            : {}),
        state: input.state,
        deleted: input.deleted,
        projectSelected: input.connection ? input.connection.projectKey !== null : false,
    }, 'Channel Connection mutation completed');
}
function logConnectionMutationFailure(operation, connectionId, status, code) {
    logger.warn({ operation, connectionId: connectionId ?? null, status, code }, 'Channel Connection mutation failed');
}
function logConnectionMutationUnexpectedFailure(operation, connectionId, error) {
    logger.error({ operation, connectionId: connectionId ?? null, errorName: safeErrorName(error) }, 'Channel Connection mutation failed unexpectedly');
}
function safeErrorName(error) {
    return error instanceof Error && error.name ? error.name : typeof error;
}
function serializeConnectionView(view, feishuClients) {
    const connection = view.connection;
    const project = connection.projectKey ? projectRef(connection.projectKey) : undefined;
    const label = feishuBindingLabel(view.binding, feishuClients);
    const binding = view.binding
        ? {
            bindingId: view.binding.bindingId,
            channel: view.binding.channel,
            externalId: view.binding.clientName,
            ...(label ? { label } : {}),
            ...(view.binding.imConversationId
                ? { imConversationId: view.binding.imConversationId }
                : {}),
            createdAt: view.binding.createdAt,
            updatedAt: view.binding.updatedAt,
            ...(view.binding.currentSessionId !== undefined
                ? { currentSessionId: view.binding.currentSessionId }
                : {}),
        }
        : undefined;
    return {
        connectionId: connection.connectionId,
        channel: connection.channel,
        agentName: connection.agentName,
        ...(project ? { project } : {}),
        state: view.state,
        ...(binding ? { binding } : {}),
        ...(view.errorCode ? { errorCode: view.errorCode } : {}),
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
    };
}
function feishuBindingLabel(binding, clients) {
    if (binding?.channel !== 'feishu' || !clients || !Object.hasOwn(clients, binding.clientName)) {
        return undefined;
    }
    const client = clients[binding.clientName];
    if (!client || typeof client !== 'object' || Array.isArray(client))
        return undefined;
    const botName = client.botName;
    return typeof botName === 'string' && botName.trim() ? botName : undefined;
}
function projectRef(projectKey) {
    const workspaceDir = workspaceDirFromProjectKey(projectKey);
    return workspaceDir ? { key: projectKey, workspaceDir } : { key: projectKey };
}
async function disconnectPlatformBinding(input, view) {
    const { channel, agentName } = view.connection;
    const api = platformApiFor(input, channel);
    if (!api) {
        throw new LocalImConnectionError(503, 'CHANNEL_PLATFORM_UNBIND_UNAVAILABLE', 'The platform binding cannot be disconnected because its adapter is unavailable.');
    }
    const response = await api.unbind(requestForAgent(channel, agentName));
    if (!response.ok) {
        throw new LocalImConnectionError(response.status, 'CHANNEL_PLATFORM_UNBIND_FAILED', 'The platform binding could not be disconnected.');
    }
}
async function cancelPlatformAuthorization(input, view, channel) {
    if (channel === 'feishu') {
        if (!input.cancelFeishuAuthorization) {
            throw new LocalImConnectionError(503, 'CHANNEL_PLATFORM_CANCEL_UNAVAILABLE', 'Feishu authorization cancellation is unavailable.');
        }
        await input.cancelFeishuAuthorization(view.connection.connectionId);
        return;
    }
    const api = channel === 'telegram' ? input.telegram : input.wechat;
    if (!api) {
        throw new LocalImConnectionError(503, 'CHANNEL_PLATFORM_CANCEL_UNAVAILABLE', 'The platform authorization cancellation is unavailable.');
    }
    const response = await api.unbind(requestForAgent(channel, view.connection.agentName));
    if (!response.ok) {
        throw new LocalImConnectionError(response.status, 'CHANNEL_PLATFORM_CANCEL_FAILED', 'The platform authorization could not be cancelled.');
    }
}
function requestForAgent(platform, agentName) {
    return new Request(`http://local-runtime.test/channel-bridge/${platform}/unbind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentName }),
    });
}
/** Legacy view state projection for a deleted-Connection snapshot. */
function connectionSnapshotState(snapshot) {
    if (snapshot.binding)
        return 'bound';
    return snapshot.authorization ? 'authorizing' : 'configured';
}
/** Human-readable shape tag for the invalid-status warn line. */
function describeStatusSnapshotType(clients) {
    if (clients === null)
        return 'null';
    return Array.isArray(clients) ? 'array' : typeof clients;
}
/** The transport Api owning this channel; undefined when not wired. */
function platformApiFor(input, channel) {
    if (channel === 'telegram')
        return input.telegram;
    if (channel === 'wechat')
        return input.wechat;
    return input.feishu;
}
//# sourceMappingURL=connections-routes.js.map