import { SessionStatusView, SessionTypeView, } from '@mavis/thrift-gen/generated/desktop-service/types';
export function localSessionRecordToSessionInfoView(session) {
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        sessionType: session.sessionType === 'root' ? SessionTypeView.Root : SessionTypeView.Branch,
        title: session.title ?? undefined,
        parentSessionId: session.parentSessionId ?? undefined,
        archived: session.archived,
        status: {
            statusType: session.status === 'started'
                ? SessionStatusView.Started
                : session.status === 'error'
                    ? SessionStatusView.Error
                    : session.status === 'aborted' || session.status === 'interrupted'
                        ? SessionStatusView.Abort
                        : SessionStatusView.Idle,
            message: session.errorMessage,
            errorCode: session.errorCode,
            errorSource: session.errorSource,
            errorDetail: session.errorDetail,
            errorProviderId: session.errorProviderId,
        },
        createdAt: session.createdAtMs,
        updatedAt: session.updatedAtMs,
        workspaceDir: session.workspaceDir,
        // UI consumers key `canUseNativeQueue` off `frameworkType === 'pi-agent'`.
        frameworkType: session.runtime === 'pi-agent' ? 'pi-agent' : 'opencode',
        visibility: session.visibility,
        purpose: session.purpose,
        effectiveModel: session.effectiveModel ?? undefined,
        effectiveModelVariant: session.effectiveModelVariant ?? undefined,
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
//# sourceMappingURL=session-view.js.map