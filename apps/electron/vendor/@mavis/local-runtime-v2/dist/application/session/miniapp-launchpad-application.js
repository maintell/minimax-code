import { isLaunchpadCommand } from '@mavis/shared/miniapp-launchpad';
export class MiniAppLaunchpadApplication {
    application;
    accountId;
    constructor(application, accountId) {
        this.application = application;
        this.accountId = accountId;
    }
    async ensureMiniAppHostSession(req) {
        const accountId = this.accountId()?.trim();
        const isCurrent = () => Boolean(accountId) && this.accountId()?.trim() === accountId;
        if (!accountId || req.expectedAccountId !== accountId)
            return { ok: false, code: 'unavailable' };
        try {
            const sessionId = await this.application.ensureHostSession(accountId, isCurrent);
            return isCurrent() ? { ok: true, sessionId } : { ok: false, code: 'unavailable' };
        }
        catch {
            return { ok: false, code: isCurrent() ? 'failed' : 'unavailable' };
        }
    }
    suggestMiniAppCreationIdeas(req) {
        return this.dispatch({ action: 'creation-ideas', language: req.language }, req.expectedAccountId);
    }
    startMiniAppCreation(req) {
        return this.dispatch({
            action: 'creation-start',
            requestId: req.requestId,
            requirements: req.requirements,
            ...(req.recommendationId !== undefined ? { recommendationId: req.recommendationId } : {}),
            ...(req.sourceSessionId !== undefined ? { sourceSessionId: req.sourceSessionId } : {}),
            ...(req.sourceSummary !== undefined ? { sourceSummary: req.sourceSummary } : {}),
            ...(req.workspaceDir !== undefined ? { workspaceDir: req.workspaceDir } : {}),
        }, req.expectedAccountId);
    }
    stopMiniAppCreation(req) {
        return this.dispatch({ action: 'creation-stop', creationId: req.creationId }, req.expectedAccountId);
    }
    removeMiniAppCreation(req) {
        return this.dispatch({ action: 'creation-remove', creationId: req.creationId }, req.expectedAccountId);
    }
    maintainMiniAppCreation(req) {
        return this.dispatch({ action: 'creation-maintenance', pluginId: req.pluginId, recover: req.recover }, req.expectedAccountId);
    }
    getMiniAppCreation(req) {
        return this.dispatch({
            action: 'creation-get',
            ...(req.creationId !== undefined ? { creationId: req.creationId } : {}),
            ...(req.sessionId !== undefined ? { sessionId: req.sessionId } : {}),
        }, req.expectedAccountId);
    }
    listMiniAppLaunchpad(req) {
        return this.dispatch({ action: 'list' }, req.expectedAccountId);
    }
    async dispatch(command, expectedAccountId) {
        const accountId = this.accountId()?.trim();
        if (!accountId || expectedAccountId !== accountId)
            return { ok: false, code: 'unavailable' };
        if (!isLaunchpadCommand(command))
            return { ok: false, code: 'invalid_request' };
        const result = await this.application.request({ accountId, command });
        // Do not return the previous account's state after an asynchronous login change.
        return this.accountId()?.trim() === accountId ? result : { ok: false, code: 'unavailable' };
    }
}
/** Only Electron owns this capability; authentication remains Runtime-owned. */
export function createMiniAppLaunchpadService(runtimeOwnerKind, launchpad, getAuth) {
    if (runtimeOwnerKind !== 'electron')
        return {};
    return {
        miniAppLaunchpad: new MiniAppLaunchpadApplication(launchpad, () => {
            const auth = getAuth();
            return auth?.authState === 'pending' || auth?.authState === 'logged_out'
                ? undefined
                : auth?.realUserID;
        }),
    };
}
//# sourceMappingURL=miniapp-launchpad-application.js.map