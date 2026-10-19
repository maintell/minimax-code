import {} from '../contracts.js';
class CronSessionCreationError extends Error {
    code;
    name = 'CronSessionCreationError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/**
 * 基于宿主实现的 {@link CronSessionCreationPort}。先校验所属智能体；目标会话归属
 * 该智能体时复用，否则为本次运行创建新会话。
 */
export function createHostCronSessionCreation(host) {
    const detachCronSessions = host.detachCronSessions;
    return {
        create: (request) => createSession(host, request),
        rename: (sessionId, title) => host.renameSession(requireIdentifier(sessionId), requireIdentifier(title)),
        discard: (sessionId) => host.discardSession(requireIdentifier(sessionId)),
        ...(detachCronSessions
            ? {
                detach: (cronId, targetSessionId) => detachCronSessions(requireIdentifier(cronId), targetSessionId ? requireIdentifier(targetSessionId) : undefined),
            }
            : {}),
    };
}
async function createSession(host, request) {
    const requestedAgentName = requireIdentifier(request.agentName);
    const cronId = requireIdentifier(request.cronId);
    const cronName = requireIdentifier(request.cronName);
    requireIdentifier(request.runId);
    const runCreatedAtMs = requireUnixMs(request.runCreatedAtMs);
    if (request.sessionTarget.mode === 'sessionId' && request.sessionTarget.sessionId !== undefined) {
        await requireAgent(host, requestedAgentName);
        return resolveTargetSession(host, requestedAgentName, request.sessionTarget.sessionId);
    }
    const agentName = requireIdentifier(await host.resolveAgentWriteTarget(requestedAgentName));
    const agent = await requireAgent(host, agentName);
    const workspaceDir = request.project?.trim() || agent.defaultWorkspaceDir || resolveWorkspace(host);
    let created;
    try {
        created = await host.createSession({
            agentName,
            cronId,
            cronName,
            runCreatedAtMs,
            workspaceDir,
            isDefaultWorkspace: !request.project?.trim(),
            ...(request.model === undefined ? {} : { model: request.model }),
        });
    }
    catch {
        throw new CronSessionCreationError('CRON_SESSION_CREATE_FAILED', 'Cron session creation failed');
    }
    return { sessionId: requireResultSessionId(created, agentName) };
}
async function requireAgent(host, agentName) {
    const agent = await host.getAgent(agentName);
    if (agent)
        return agent;
    throw new CronSessionCreationError('CRON_SESSION_AGENT_NOT_FOUND', 'Cron session agent was not found');
}
async function resolveTargetSession(host, agentName, rawSessionId) {
    const sessionId = requireIdentifier(rawSessionId);
    const session = await host.getSession(sessionId);
    if (!session) {
        throw new CronSessionCreationError('CRON_SESSION_TARGET_NOT_FOUND', 'Cron target session was not found');
    }
    if (session.agentName !== agentName) {
        const [resolvedSessionAgentName, resolvedDefinitionAgentName] = await Promise.all([
            host.resolveAgentWriteTarget(session.agentName),
            host.resolveAgentWriteTarget(agentName),
        ]);
        if (requireIdentifier(resolvedSessionAgentName) !== requireIdentifier(resolvedDefinitionAgentName)) {
            throw new CronSessionCreationError('CRON_SESSION_TARGET_AGENT_MISMATCH', 'Cron target session belongs to a different agent');
        }
    }
    if (session.archived) {
        throw new CronSessionCreationError('CRON_SESSION_TARGET_ARCHIVED', 'Cron target session is archived');
    }
    return { sessionId };
}
function resolveWorkspace(host) {
    try {
        return host.resolveDefaultWorkspaceDir();
    }
    catch {
        throw new CronSessionCreationError('CRON_SESSION_WORKSPACE_FAILED', 'Cron session workspace resolution failed');
    }
}
function requireResultSessionId(session, agentName) {
    const sessionId = typeof session.sessionId === 'string' ? session.sessionId.trim() : '';
    if (sessionId.length === 0 ||
        sessionId !== session.sessionId ||
        session.agentName !== agentName) {
        throw new CronSessionCreationError('CRON_SESSION_INVALID_RESULT', 'Cron session creation returned an invalid result');
    }
    return sessionId;
}
function requireIdentifier(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length > 0)
        return normalized;
    throw new CronSessionCreationError('CRON_SESSION_INVALID_ARGUMENT', 'Cron session creation requires non-empty identifiers');
}
function requireUnixMs(value) {
    if (Number.isSafeInteger(value) && value >= 0)
        return value;
    throw new CronSessionCreationError('CRON_SESSION_INVALID_ARGUMENT', 'Cron session creation requires a valid run timestamp');
}
//# sourceMappingURL=session-creation.adapter.js.map