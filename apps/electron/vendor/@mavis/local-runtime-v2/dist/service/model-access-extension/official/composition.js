import { settleInBackground } from '../../../infra/async/settle.js';
import os from 'node:os';
import { MODEL_ACCESS_HOST_SDK_VERSION } from '../package-lifecycle.service.js';
import { ModelAccessRemoteClient, } from './client.js';
import { OfficialModelAccessDelivery } from './delivery.js';
const INERT = Object.freeze({
    start: () => undefined,
    authContextChanged: () => undefined,
    laneChanged: () => undefined,
    close: async () => undefined,
});
/**
 * Runtime owners that receive official delivery, mapped to the client_kind they report.
 * Electron, the mcode CLI and the TUI follow the same master switch, remote rules and entry
 * hiding. Other owners (app-server, cloud, tests) get an inert composition and empty rules.
 */
export function modelAccessClientKind(runtimeOwnerKind) {
    return runtimeOwnerKind === 'electron' || runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui'
        ? runtimeOwnerKind
        : undefined;
}
export function composeOfficialModelAccessDelivery(options) {
    const clientKind = modelAccessClientKind(options.runtimeOwnerKind);
    if (!clientKind)
        return INERT;
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux')
        return INERT;
    const modelAccess = options.modelAccess;
    // The switch itself is derived inside the package service (options + env + persisted opt-in),
    // so startup activation and sync always agree.
    const attached = modelAccess.attachRemoteDelivery({
        contentDigest: options.archive.contentDigest,
    });
    const owner = new OfficialModelAccessDelivery({
        host: attached.host,
        archive: options.archive,
        client: new ModelAccessRemoteClient(options.transport(), {
            clientKind,
            platform,
            arch: os.arch(),
            sdkVersion: MODEL_ACCESS_HOST_SDK_VERSION,
        }),
        optIn: () => modelAccess.remoteDelivery().optIn,
        ...(options.lane ? { lane: options.lane } : {}),
        refresh: attached.refresh,
        authenticated: () => {
            const auth = options.authContextGetter();
            return !!auth?.accessToken?.trim() && !!auth.realUserID?.trim();
        },
    });
    return {
        control: {
            status: () => owner.status(),
            syncNow: () => owner.syncNow(),
            setOptIn: (enabled) => owner.setOptIn(enabled),
        },
        start: () => {
            settleInBackground(owner.start());
        },
        authContextChanged: () => owner.authContextChanged(),
        laneChanged: () => owner.laneChanged(),
        close: () => owner.close(),
    };
}
//# sourceMappingURL=composition.js.map