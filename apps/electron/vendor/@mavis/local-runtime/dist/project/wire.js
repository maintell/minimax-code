import { SessionStatusView, SessionTypeView, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { projectDisplayName } from './canonical-workspace.js';
import { groupChildren, paginate } from './helpers.js';
/**
 * Paginate one project's root sessions and render them as a session tree.
 * Returns `ProjectSessionGroup`-shaped pagination fields because it feeds both
 * `listProjects`, which embeds the group verbatim, and `listProjectSessions`,
 * which remaps them onto that response's flat `hasMore` / `nextCursor` naming.
 */
export function pageProjectSessions(sessions, allSessions, cursor, limit, isDefaultWorkspaceSession) {
    const page = paginate(sessions, cursor, limit, (session) => session.sessionId);
    const childrenByParent = groupChildren(allSessions);
    return {
        sessions: page.items.map((session) => toSessionTreeNodeView(session, childrenByParent, isDefaultWorkspaceSession)),
        hasMoreSessions: page.hasMore,
        nextSessionCursor: page.nextCursor,
    };
}
export function toSessionTreeNodeView(session, childrenByParent, isDefaultWorkspaceSession) {
    return {
        session: toSessionInfoView(session, isDefaultWorkspaceSession),
        childSessions: (childrenByParent.get(session.sessionId) ?? []).map(toSessionTreeChildView),
    };
}
export function toSessionInfoView(session, isDefaultWorkspaceSession) {
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        sessionType: session.sessionType === 'root' ? SessionTypeView.Root : SessionTypeView.Branch,
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
    };
}
export function toSessionStatusView(session) {
    if (session.status === 'started')
        return { statusType: SessionStatusView.Started };
    if (session.status === 'error') {
        return {
            statusType: SessionStatusView.Error,
            message: session.errorMessage,
            errorCode: session.errorCode,
            errorSource: session.errorSource,
            errorDetail: session.errorDetail,
            errorProviderId: session.errorProviderId,
        };
    }
    if (session.status === 'aborted' || session.status === 'interrupted') {
        return {
            statusType: SessionStatusView.Abort,
            message: session.errorMessage,
            errorCode: session.errorCode,
            errorSource: session.errorSource,
            errorDetail: session.errorDetail,
            errorProviderId: session.errorProviderId,
        };
    }
    return { statusType: SessionStatusView.Idle };
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