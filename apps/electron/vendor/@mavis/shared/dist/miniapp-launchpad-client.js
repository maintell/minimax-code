import { isLaunchpadResponse, } from './miniapp-launchpad.js';
/** Dispatches domain commands through the IDL-generated client; no IPC or raw JSON protocol. */
export async function requestMiniAppLaunchpad(client, command, accountId) {
    const response = await dispatch();
    if (!isLaunchpadResponse(response))
        return { ok: false, code: 'failed' };
    if (!response.ok)
        return response;
    const valid = command.action === 'list'
        ? Boolean(response.state)
        : command.action === 'creation-ideas'
            ? Boolean(response.ideas)
            : ['creation-stop', 'creation-remove'].includes(command.action) ||
                Boolean(response.creation);
    return valid ? response : { ok: false, code: 'failed' };
    function dispatch() {
        switch (command.action) {
            case 'creation-ideas':
                return client.suggestMiniAppCreationIdeas({
                    expectedAccountId: accountId,
                    language: command.language,
                });
            case 'creation-start':
                return client.startMiniAppCreation({
                    expectedAccountId: accountId,
                    requestId: command.requestId,
                    requirements: command.requirements,
                    recommendationId: command.recommendationId,
                    sourceSessionId: command.sourceSessionId,
                    sourceSummary: command.sourceSummary,
                    workspaceDir: command.workspaceDir,
                });
            case 'creation-stop':
                return client.stopMiniAppCreation({
                    expectedAccountId: accountId,
                    creationId: command.creationId,
                });
            case 'creation-remove':
                return client.removeMiniAppCreation({
                    expectedAccountId: accountId,
                    creationId: command.creationId,
                });
            case 'creation-maintenance':
                return client.maintainMiniAppCreation({
                    expectedAccountId: accountId,
                    pluginId: command.pluginId,
                    recover: command.recover,
                });
            case 'creation-get':
                return client.getMiniAppCreation({
                    expectedAccountId: accountId,
                    creationId: command.creationId,
                    sessionId: command.sessionId,
                });
            case 'list':
                return client.listMiniAppLaunchpad({ expectedAccountId: accountId });
        }
    }
}
//# sourceMappingURL=miniapp-launchpad-client.js.map