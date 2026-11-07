import { projectDisplayName } from '../../../infra/legacy-db/project-canonical-workspace.js';
import { groupChildren, paginate, } from '../../../infra/legacy-db/project-helpers.js';
/**
 * 本地兼容表示保留既有数值编码；由架构测试验证与 Desktop DTO 的兼容性。
 * @internal Exported only for focused tests.
 */
export const PROJECT_SESSION_TYPE = { Branch: 0, Root: 1 };
/** @internal Exported only for focused tests. */
export const PROJECT_SESSION_STATUS = { Idle: 0, Started: 1, Error: 2, Abort: 3 };
/**
 * Paginate one project's root sessions and render them as a session tree.
 * Returns `ProjectSessionGroup`-shaped pagination fields because it feeds both
 * `listProjects`, which embeds the group verbatim, and `listProjectSessions`,
 * which remaps them onto that response's flat `hasMore` / `nextCursor` naming.
 */
export function pageProjectSessions(sessions, allSessions, pagination, isDefaultWorkspaceSession) {
    const page = paginate(sessions, pagination.cursor, pagination.limit, (session) => session.sessionId);
    const childrenByParent = groupChildren(allSessions);
    return {
        sessions: page.items.map((session) => toSessionTreeNodeView(session, childrenByParent, isDefaultWorkspaceSession)),
        hasMoreSessions: page.hasMore,
        nextSessionCursor: page.nextCursor,
    };
}
function toSessionTreeNodeView(session, childrenByParent, isDefaultWorkspaceSession) {
    return {
        session: toSessionInfoView(session, isDefaultWorkspaceSession),
        childSessions: (childrenByParent.get(session.sessionId) ?? []).map(toSessionTreeChildView),
    };
}
/** @internal Exported only for focused tests. */
export function toSessionInfoView(session, isDefaultWorkspaceSession) {
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        sessionType: session.sessionType === 'root' ? PROJECT_SESSION_TYPE.Root : PROJECT_SESSION_TYPE.Branch,
        title: session.title ?? undefined,
        parentSessionId: session.parentSessionId ?? undefined,
        archived: session.archived,
        status: toSessionStatusView(session),
        createdAt: session.createdAtMs,
        updatedAt: session.updatedAtMs,
        workspaceDir: session.workspaceDir,
        isDefaultWorkspace: isDefaultWorkspaceSession(session),
        visibility: session.visibility,
        purpose: session.purpose,
        effectiveModel: session.effectiveModel ?? undefined,
        effectiveModelVariant: session.effectiveModelVariant ?? undefined,
        lastActiveAt: session.updatedAtMs,
        runLocation: session.runLocation
            ? {
                mode: session.runLocation.mode,
                resolvedDir: session.runLocation.resolvedDir,
                resolvedBranch: session.runLocation.resolvedBranch,
                parentRepoDir: session.runLocation.parentRepoDir,
                createdAt: session.runLocation.createdAt,
            }
            : undefined,
    };
}
/** @internal Exported only for focused tests. */
export function toSessionTreeChildView(session) {
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        title: session.title ?? undefined,
        createdAt: session.createdAtMs,
        updatedAt: session.updatedAtMs,
        archived: session.archived,
        compressed: session.archived,
        status: toSessionStatusView(session),
        ...(session.purpose ? { purpose: session.purpose } : {}),
    };
}
function toSessionStatusView(session) {
    if (session.status === 'started')
        return { statusType: PROJECT_SESSION_STATUS.Started };
    if (session.status === 'error') {
        return {
            statusType: PROJECT_SESSION_STATUS.Error,
            message: session.errorMessage,
            errorCode: session.errorCode,
            errorSource: session.errorSource,
            errorDetail: session.errorDetail,
            errorProviderId: session.errorProviderId,
        };
    }
    if (session.status === 'aborted' || session.status === 'interrupted') {
        return {
            statusType: PROJECT_SESSION_STATUS.Abort,
            message: session.errorMessage,
            errorCode: session.errorCode,
            errorSource: session.errorSource,
            errorDetail: session.errorDetail,
            errorProviderId: session.errorProviderId,
        };
    }
    return { statusType: PROJECT_SESSION_STATUS.Idle };
}
export function toProjectDetail(aggregate) {
    return {
        key: aggregate.key,
        workspaceDir: aggregate.workspaceDir,
        displayName: projectDisplayName(aggregate.workspaceDir),
        archived: false,
        latestActivityAt: aggregate.latestActivityAt,
        sessionCount: aggregate.sessions.length,
        state: aggregate.state,
    };
}
//# sourceMappingURL=wire.js.map