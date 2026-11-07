import { logger } from '../../../infra/logging/logger.js';
export async function hostCreateRootSession(deps) {
    const { agentName, createSession, replaceRootSession, deleteSession, resolveWorkspaceDir } = deps;
    // Create the transient session as a branch, then let
    // `replaceRootSession` promote it to root (which also demotes the
    // previous root). If the promote
    // fails we must NOT return the branch masquerading as a root —
    // that was the original silent-bail bug that produced
    // `outcome:'ok'` while `sessionType='branch'`. Clean up the
    // transient row and return undefined so the caller surfaces the
    // failure to the user.
    const branch = await createSession({
        agentName,
        workspaceDir: resolveWorkspaceDir(),
        sessionType: 'branch',
        sessionKind: 'conversation',
        title: 'Main',
        parentSessionId: null,
        isDefaultWorkspace: true,
        origin: 'user',
    });
    const promoted = await replaceRootSession(agentName, branch.sessionId);
    if (!promoted) {
        logger.error({
            scope: 'host.createRootSession',
            agentName,
            transientBranchId: branch.sessionId,
        }, 'createRootSession: replaceRootSession returned undefined; cleaning up transient branch');
        try {
            await deleteSession(branch.sessionId);
        }
        catch (err) {
            logger.warn({
                scope: 'host.createRootSession',
                agentName,
                transientBranchId: branch.sessionId,
                err: err instanceof Error ? err.message : String(err),
            }, 'createRootSession: cleanup of transient branch failed (non-fatal)');
        }
        return undefined;
    }
    return promoted;
}
//# sourceMappingURL=create-root-session.js.map