import path from "node:path";
import { app, net, ipcMain } from "electron";
import { DOMAIN_URL, IPC_CHANNELS } from "../config/constants.js";
import { browserBackendPolicy } from "../modules/browser/browser-backend-policy.js";
import { createFileBrowserBackendPolicyStore, fetchBrowserBackendRemotePolicy } from "../modules/browser/browser-backend-policy-store.js";
import { getEmbeddedBrowserBackendDiagnostics } from "../modules/browser/embedded-browser-manager.js";
import { browserTelemetry } from "../modules/browser/browser-telemetry-runtime.js";
function browserTelemetrySessionDiagnostics() {
    try {
        const snapshot = browserTelemetry.snapshot();
        return { session: snapshot.sessions, resources: snapshot.lastResources };
    }
    catch {
        return {};
    }
}
import { isMainDocumentNavigation } from "../modules/browser/embedded-browser-manager-helpers.js";
import { isRegisteredMainRenderer, listRegisteredMainRenderers } from "../windows/desktopRendererWindow.js";
import { trustedHost } from "./miniAppComposer.ipc.js";
import { getUserInfo, onUserInfoChanged } from "./storage.ipc.js";
function defaultPolicySources() {
    return {
        store: createFileBrowserBackendPolicyStore({
            filePath: path.join(app.getPath('userData'), 'browser-backend-policy.json'),
            // Test, staging and production publish separate Apollo documents.
            scope: DOMAIN_URL,
        }),
        fetchRemote: (signal) => fetchBrowserBackendRemotePolicy({
            origin: DOMAIN_URL,
            fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
            signal,
        }),
    };
}
export function setupBrowserBackendIPC(options = {}) {
    // Sources must be attached before the first account sync so the cached
    // policy (or Main's own read) fixes this launch's backend before pages restore.
    browserBackendPolicy.attachSources(options.sources !== undefined ? options.sources : defaultPolicySources());
    const owners = new Map();
    const syncAccount = () => {
        const id = getUserInfo().realUserID;
        browserBackendPolicy.setAccount(typeof id === 'string' && id.trim() ? id : null);
    };
    syncAccount();
    const unsubscribeAccount = onUserInfoChanged(syncAccount);
    const trusted = (event) => trustedHost(event) && isRegisteredMainRenderer(event.sender);
    const observeOwner = (owner) => {
        if (owners.has(owner))
            return;
        const revoke = () => browserBackendPolicy.revokeOwner(owner);
        const navigation = (...args) => {
            if (isMainDocumentNavigation(args))
                revoke();
        };
        const dispose = () => {
            revoke();
            owner.removeListener('did-start-navigation', navigation);
            owner.removeListener('did-navigate', revoke);
            owner.removeListener('render-process-gone', revoke);
            owner.removeListener('destroyed', dispose);
            owners.delete(owner);
        };
        owner.on('did-start-navigation', navigation);
        // Also fence a request admitted by the outgoing document after navigation
        // started but before its replacement committed.
        owner.on('did-navigate', revoke);
        owner.on('render-process-gone', revoke);
        owner.once('destroyed', dispose);
        owners.set(owner, dispose);
    };
    ipcMain.handle(IPC_CHANNELS.BROWSER_BACKEND_BEGIN_REFRESH, (event) => {
        if (!trusted(event))
            return { success: false, code: 'untrusted_sender' };
        syncAccount();
        observeOwner(event.sender);
        const leaseId = browserBackendPolicy.beginRefresh(event.sender);
        return leaseId
            ? { success: true, leaseId, policy: browserBackendPolicy.snapshot() }
            : { success: false, code: 'account_unavailable' };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_BACKEND_APPLY_REFRESH, (event, leaseId, config) => {
        if (!trusted(event))
            return { success: false, code: 'untrusted_sender' };
        syncAccount();
        const result = browserBackendPolicy.applyRefresh(event.sender, leaseId, config);
        return result === 'stale'
            ? { success: false, code: 'stale_request' }
            : { success: true, applied: result === 'applied', policy: browserBackendPolicy.snapshot() };
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_BACKEND_GET_DIAGNOSTICS, (event) => {
        if (!trusted(event))
            return { success: false, code: 'untrusted_sender' };
        return {
            success: true,
            diagnostics: {
                policy: browserBackendPolicy.diagnosticSnapshot(),
                nextSelection: browserBackendPolicy.select(),
                tabs: getEmbeddedBrowserBackendDiagnostics(),
                ...browserTelemetrySessionDiagnostics(),
            },
        };
    });
    // Shared menus and overlays follow this launch's backend, so the main renderer
    // reads it on mount (covers reloads) and is told once when a cold launch decides.
    ipcMain.handle(IPC_CHANNELS.BROWSER_BACKEND_GET_LAUNCH, (event) => trusted(event) ? browserBackendPolicy.snapshot().launchBackend : null);
    const stopLaunchBroadcast = browserBackendPolicy.onLaunchDecided(({ backend }) => {
        for (const contents of listRegisteredMainRenderers()) {
            contents.send(IPC_CHANNELS.BROWSER_BACKEND_LAUNCH_DECIDED, backend);
        }
    });
    return () => {
        unsubscribeAccount();
        stopLaunchBroadcast();
        for (const dispose of [...owners.values()])
            dispose();
        browserBackendPolicy.reset();
        ipcMain.removeHandler(IPC_CHANNELS.BROWSER_BACKEND_BEGIN_REFRESH);
        ipcMain.removeHandler(IPC_CHANNELS.BROWSER_BACKEND_APPLY_REFRESH);
        ipcMain.removeHandler(IPC_CHANNELS.BROWSER_BACKEND_GET_DIAGNOSTICS);
        ipcMain.removeHandler(IPC_CHANNELS.BROWSER_BACKEND_GET_LAUNCH);
    };
}
