import { parseMiniAppPermissionId, } from '@mavis/shared/miniapp-surface';
import { classifyMiniAppCandidateChange, miniAppBusyReason, } from '../../service/miniapp/index.js';
import { PluginSystemError, } from '../../service/plugin-system/index.js';
/** Projects installed MiniApp definitions and Supervisor state for the Electron bridge. */
export function createProcessLocalMiniAppApplication(plugins, supervisor) {
    if (!supervisor)
        return undefined;
    const applying = new Set();
    const projections = async () => {
        const accepted = new Map(plugins.listAcceptedMiniApps().map((item) => [item.candidate.pluginId, item]));
        return (await plugins.listAvailableMiniAppDefinitions()).map((available) => {
            const pluginId = available.candidate.pluginId;
            return {
                available,
                accepted: accepted.get(pluginId),
                running: plugins.isAcceptedMiniAppRunning(pluginId),
                applying: applying.has(pluginId),
            };
        });
    };
    const requireProjection = async (pluginId) => {
        const projection = (await projections()).find(({ available }) => available.candidate.pluginId === pluginId);
        if (!projection)
            throw applicationError('NOT_FOUND');
        return projection;
    };
    /** Coordinates of the accepting run serving `pluginId`, or undefined when none is. */
    const currentRun = (pluginId, status) => {
        const active = status?.active;
        const credential = supervisor.launchCredential(pluginId);
        if (status?.phase !== 'active' ||
            !active?.origin ||
            !active.processGeneration ||
            active.pluginId !== pluginId ||
            credential?.origin !== active.origin ||
            credential.processGeneration !== active.processGeneration) {
            return undefined;
        }
        return {
            origin: active.origin,
            surfacePath: active.surfacePath,
            runId: active.processGeneration,
            loopbackToken: credential.loopbackToken,
            ...(active.surfaceWindow ? { window: active.surfaceWindow } : {}),
        };
    };
    const launch = (projection, status) => {
        const run = currentRun(projection.available.candidate.pluginId, status);
        if (!run)
            throw applicationError(status?.failureCode ?? 'RUNTIME_FAILED');
        return { miniApp: summary(projection, status), launch: run };
    };
    const runPluginAction = async (action) => {
        try {
            await action();
        }
        catch (error) {
            const busyReason = miniAppBusyReason(error);
            if (!busyReason)
                throw error;
            throw Object.assign(applicationError('BUSY', { cause: error }), { busyReason });
        }
    };
    const open = async (pluginId, signal) => {
        signal?.throwIfAborted();
        await requireProjection(pluginId);
        await runPluginAction(() => plugins.ensureMiniAppStarted({ pluginId, ...(signal ? { signal } : {}) }));
        signal?.throwIfAborted();
        return launch(await requireProjection(pluginId), supervisor.inspect(pluginId)[0]);
    };
    return {
        list: async () => {
            const statuses = new Map(supervisor.inspect().map((status) => [status.pluginId, status]));
            return {
                miniApps: (await projections()).map((projection) => summary(projection, statuses.get(projection.available.candidate.pluginId))),
            };
        },
        open: ({ pluginId, signal }) => open(pluginId, signal),
        stop: async ({ pluginId, signal }) => {
            signal?.throwIfAborted();
            try {
                // Stop the accepted owner even when its package has disappeared from discovery.
                await plugins.stopMiniApp({ pluginId, ...(signal ? { signal } : {}) });
            }
            catch (error) {
                signal?.throwIfAborted();
                if (error instanceof PluginSystemError &&
                    error.code === 'MINIAPP_NOT_ACCEPTED' &&
                    !supervisor.hasRuntimeCustody(pluginId)) {
                    return;
                }
                throw error;
            }
        },
        // Read-only: unlike open, this never calls ensureMiniAppStarted.
        credential: async ({ pluginId, signal }) => {
            signal?.throwIfAborted();
            const run = currentRun(pluginId, supervisor.inspect(pluginId)[0]);
            return run
                ? {
                    credential: {
                        origin: run.origin,
                        runId: run.runId,
                        loopbackToken: run.loopbackToken,
                    },
                }
                : { running: false };
        },
        applyUpdate: async ({ pluginId, signal }) => {
            signal?.throwIfAborted();
            await requireProjection(pluginId);
            if (applying.has(pluginId)) {
                throw Object.assign(applicationError('BUSY'), { busyReason: 'operation_busy' });
            }
            applying.add(pluginId);
            try {
                await runPluginAction(() => plugins.applyUpdate({ pluginId, ...(signal ? { signal } : {}) }));
            }
            finally {
                applying.delete(pluginId);
            }
            // A cancellation that lands after the publication committed cannot undo it; report the
            // run that is now serving so Main re-syncs credentials and reopens the page.
            return launch(await requireProjection(pluginId), supervisor.inspect(pluginId)[0]);
        },
        listPermissions: ({ pluginId }) => permissionCall(() => plugins.listMiniAppPermissions(pluginId)),
        setPermission: async ({ pluginId, permission, enabled }) => {
            const parsed = parseMiniAppPermissionId(permission);
            if (!parsed)
                throw applicationError('PERMISSION_UNKNOWN');
            return permissionCall(() => plugins.setMiniAppPermission({ pluginId, permission: parsed.id, enabled }));
        },
    };
}
const PERMISSION_ERROR_CODES = {
    MINIAPP_NOT_FOUND: 'NOT_FOUND',
    MINIAPP_PERMISSION_UNKNOWN: 'PERMISSION_UNKNOWN',
};
/** Maps the two caller mistakes to stable codes; any other failure keeps its own identity. */
async function permissionCall(operation) {
    try {
        return await operation();
    }
    catch (error) {
        const code = error instanceof PluginSystemError ? PERMISSION_ERROR_CODES[error.code] : undefined;
        throw code ? applicationError(code, { cause: error }) : error;
    }
}
function summary(projection, status) {
    const { available } = projection;
    const runtimeStatus = mapRuntimeStatus(status?.phase);
    const update = pendingUpdate(projection);
    return {
        pluginId: available.candidate.pluginId,
        ...(available.displayName ? { displayName: available.displayName } : {}),
        ...(available.description ? { description: available.description } : {}),
        ...(available.iconPath ? { iconUrl: localIconUrl(available.iconPath) } : {}),
        runtime: {
            kind: 'process',
            status: runtimeStatus,
            ...(runtimeStatus === 'failed' && status?.failureCode
                ? { errorCode: status.failureCode }
                : {}),
        },
        ...(update ? { update } : {}),
    };
}
/** Derived, never stored: a running official package differs from the available one by a restart-class change. */
function pendingUpdate(projection) {
    const { available, accepted, running, applying } = projection;
    if (applying) {
        return { state: 'applying', ...(available.version ? { version: available.version } : {}) };
    }
    if (!running || accepted?.source !== 'official')
        return undefined;
    if (classifyMiniAppCandidateChange(accepted.candidate, available.candidate) !== 'restart') {
        return undefined;
    }
    return {
        state: 'available',
        ...(accepted.version ? { currentVersion: accepted.version } : {}),
        ...(available.version ? { version: available.version } : {}),
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