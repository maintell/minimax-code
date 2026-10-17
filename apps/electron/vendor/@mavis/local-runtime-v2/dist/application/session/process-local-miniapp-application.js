import { miniAppBusyReason, } from '../../service/miniapp/index.js';
/** Projects installed MiniApp definitions and Supervisor state for the Electron bridge. */
export function createProcessLocalMiniAppApplication(plugins, supervisor) {
    if (!supervisor)
        return undefined;
    const requireDefinition = async (pluginId) => {
        const miniApp = (await plugins.listAvailableMiniApps()).find((candidate) => candidate.pluginId === pluginId);
        if (!miniApp)
            throw applicationError('NOT_FOUND');
        return miniApp;
    };
    const launch = (miniApp, status) => {
        const active = status?.active;
        if (status?.phase !== 'active' ||
            !active?.origin ||
            !active.processGeneration ||
            active.pluginId !== miniApp.pluginId) {
            throw applicationError(status?.failureCode ?? 'RUNTIME_FAILED');
        }
        return {
            miniApp: summary(miniApp, status),
            launch: {
                origin: active.origin,
                surfacePath: active.surfacePath,
                runId: active.processGeneration,
            },
        };
    };
    const open = async (pluginId, signal) => {
        signal?.throwIfAborted();
        const miniApp = await requireDefinition(pluginId);
        try {
            await plugins.ensureMiniAppStarted({ pluginId, ...(signal ? { signal } : {}) });
        }
        catch (error) {
            const busyReason = miniAppBusyReason(error);
            if (!busyReason)
                throw error;
            throw Object.assign(applicationError('BUSY', { cause: error }), { busyReason });
        }
        signal?.throwIfAborted();
        return launch(miniApp, supervisor.inspect(pluginId)[0]);
    };
    return {
        list: async () => {
            const definitions = await plugins.listAvailableMiniApps();
            const statuses = new Map(supervisor.inspect().map((status) => [status.pluginId, status]));
            return {
                miniApps: definitions.map((miniApp) => summary(miniApp, statuses.get(miniApp.pluginId))),
            };
        },
        open: ({ pluginId, signal }) => open(pluginId, signal),
        stop: async ({ pluginId, signal }) => {
            await requireDefinition(pluginId);
            await plugins.stopMiniApp({ pluginId, ...(signal ? { signal } : {}) });
        },
    };
}
function summary(miniApp, status) {
    const runtimeStatus = mapRuntimeStatus(status?.phase);
    return {
        pluginId: miniApp.pluginId,
        ...(miniApp.displayName ? { displayName: miniApp.displayName } : {}),
        ...(miniApp.description ? { description: miniApp.description } : {}),
        ...(miniApp.iconPath ? { iconUrl: localIconUrl(miniApp.iconPath) } : {}),
        runtime: {
            kind: 'process',
            status: runtimeStatus,
            ...(runtimeStatus === 'failed' && status?.failureCode
                ? { errorCode: status.failureCode }
                : {}),
        },
    };
}
function localIconUrl(iconPath) {
    return `/mavis/api/file/preview?path=${encodeURIComponent(iconPath)}`;
}
function mapRuntimeStatus(phase) {
    if (phase === 'active')
        return 'running';
    if (phase === 'starting' || phase === 'preparing')
        return 'starting';
    if (phase === 'failed' || phase === 'quarantined')
        return 'failed';
    return 'stopped';
}
function applicationError(code, options) {
    return Object.assign(new Error('Mini App surface action failed', options), { code });
}
//# sourceMappingURL=process-local-miniapp-application.js.map