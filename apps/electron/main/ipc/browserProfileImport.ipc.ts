import { BrowserWindow, ipcMain } from "electron";
import { isDev } from "../config";
import { DEV_SERVER_URL, IPC_CHANNELS } from "../config/constants";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager";
import { getBrowserProfileImportService, subscribeBrowserProfileImportProgress, reportBrowserProfileImportDiagnostic } from "../modules/browser-profile-import";
const requestOwners = new Map();
let progressForwardingInitialized = false;
function trustedHostRenderer(event) {
    if (event.sender.isDestroyed())
        return false;
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
        return false;
    const hostWindow = BrowserWindow.fromWebContents(event.sender);
    if (!hostWindow || hostWindow.webContents.id !== event.sender.id)
        return false;
    try {
        const url = new URL(event.sender.getURL());
        if (url.pathname !== '/archon')
            return false;
        if (!isDev)
            return url.protocol === 'app:' && url.hostname === '.';
        return url.origin === new URL(DEV_SERVER_URL).origin;
    }
    catch {
        return false;
    }
}
function targetFrom(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const validSessionId = raw.sessionId === null ||
        (typeof raw.sessionId === 'string' && raw.sessionId.length > 0 && raw.sessionId.length <= 256);
    const validTabId = typeof raw.tabId === 'number' && Number.isSafeInteger(raw.tabId) && raw.tabId > 0;
    if (!validSessionId || !validTabId)
        return null;
    return {
        sessionId: raw.sessionId,
        tabId: raw.tabId,
    };
}
function resolveTargetTab(target) {
    const state = getEmbeddedBrowserManager().getState(target);
    if (state.success !== true || !Array.isArray(state.tabs))
        return null;
    const tabs = state.tabs;
    const selected = tabs.find((tab) => tab.tabId === target.tabId);
    return selected && typeof selected.tabId === 'number'
        ? { tabId: selected.tabId, url: selected.url }
        : null;
}
function selectedHttpHost(tab) {
    if (typeof tab.url !== 'string')
        return null;
    try {
        const url = new URL(tab.url);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
    }
    catch {
        return null;
    }
}
function untrustedResult() {
    return { success: false, errorCode: 'untrusted_sender' };
}
function failedImportResult(requestId, errorCode) {
    return {
        success: false,
        requestId,
        importedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        unsupportedCount: 0,
        errorCode,
    };
}
export function setupBrowserProfileImportIPC() {
    const importService = getBrowserProfileImportService();
    if (!progressForwardingInitialized) {
        progressForwardingInitialized = true;
        subscribeBrowserProfileImportProgress((progress) => {
            const owner = requestOwners.get(progress.requestId);
            if (!owner || owner.isDestroyed())
                return;
            owner.send(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_PROGRESS, progress);
        });
    }
    ipcMain.handle(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_LIST, (event, source) => {
        if (!trustedHostRenderer(event))
            return untrustedResult();
        return importService.listImportableProfiles(source === 'automatic' || source === 'manual' ? source : 'unknown');
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_START, async (event, params = {}) => {
        const requestId = typeof params.requestId === 'string' ? params.requestId : '';
        if (!trustedHostRenderer(event)) {
            return failedImportResult(requestId, 'untrusted_sender');
        }
        const profileId = typeof params.profileId === 'string' ? params.profileId : '';
        const scope = params.scope === 'current-site' ? 'current-site' : params.scope === 'all' ? 'all' : null;
        const target = targetFrom(params.target);
        if (!requestId || !profileId || !scope || !target) {
            return failedImportResult(requestId, 'invalid_request');
        }
        if (requestOwners.has(requestId)) {
            return failedImportResult(requestId, 'invalid_request');
        }
        const targetTab = resolveTargetTab(target);
        if (!targetTab) {
            return failedImportResult(requestId, scope === 'current-site' ? 'invalid_current_site' : 'invalid_request');
        }
        const currentHost = scope === 'current-site' ? selectedHttpHost(targetTab) : undefined;
        if (scope === 'current-site' && !currentHost) {
            return failedImportResult(requestId, 'invalid_current_site');
        }
        requestOwners.set(requestId, event.sender);
        try {
            const result = await importService.importCookies({
                requestId,
                profileId,
                scope,
                ...(currentHost ? { currentHost } : {}),
            });
            if (result.success && result.importedCount > 0) {
                let reloaded = false;
                try {
                    const reloadResult = (await getEmbeddedBrowserManager().reload(target));
                    reloaded = reloadResult?.success !== false;
                }
                catch {
                    reloaded = false;
                }
                reportBrowserProfileImportDiagnostic({
                    event: 'browser_reload_completed',
                    requestId,
                    success: reloaded,
                });
                return { ...result, reloaded };
            }
            return result;
        }
        finally {
            requestOwners.delete(requestId);
        }
    });
    ipcMain.handle(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_CANCEL, (event, params) => {
        if (!trustedHostRenderer(event))
            return untrustedResult();
        const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
        if (!requestId || requestOwners.get(requestId)?.id !== event.sender.id) {
            return { success: false };
        }
        return importService.cancelImport(requestId);
    });
}
