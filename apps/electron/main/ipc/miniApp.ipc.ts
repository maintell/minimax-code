import { ipcMain } from "electron";
import { beginMiniAppNavigationRevocation } from "../modules/browser/miniapp-host-navigation-permissions.js";
import { parseMiniAppPermissionId, parseMiniAppPermissionList, parseMiniAppWindowPatch } from "@mavis/shared/miniapp-surface";
import { IPC_CHANNELS } from "../config/constants";
import { getEmbeddedBrowserManager, syncManagedMiniAppLoopbackCredential } from "../modules/browser/embedded-browser-manager";
import { closeManagedMiniAppPages, readRunningMiniAppCredential, runManagedMiniAppStop, runManagedMiniAppLaunch, openManagedMiniAppSurface } from "../modules/browser/miniapp-surface";
import { requestUtilityMiniApp, setUtilityMiniAppPermission } from "../modules/local-runtime/utility";
import { readMiniAppBrokerFailureDiagnostic } from "../modules/local-runtime/utility/miniapp-broker.js";
import { getCategoryLogger } from "../utils/logger.js";
const miniAppOpenLogger = getCategoryLogger('archon', 'miniapp-open');
const miniAppControlLogger = getCategoryLogger('archon', 'miniapp-control');
const MAX_DIAGNOSTIC_PLUGIN_ID_LENGTH = 80;
const SAFE_DIAGNOSTIC_PLUGIN_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
export function setupMiniAppIPC() {
    ipcMain.handle(IPC_CHANNELS.MINIAPP_LIST, async () => {
        try {
            const result = await requestUtilityMiniApp('list');
            return 'miniApps' in result
                ? {
                    success: true,
                    miniApps: result.miniApps,
                    ...(result.capacity ? { capacity: result.capacity } : {}),
                }
                : { success: false, code: 'start_failed' };
        }
        catch (error) {
            return { success: false, code: normalizeErrorCode(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_OPEN, (_event, params) => openMiniApp(params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_REFRESH, (_event, params) => controlMiniApp('refresh', params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_STOP, (_event, params) => controlMiniApp('stop', params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_CLOSE, (_event, params) => closeMiniApp(params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_DETACH, (_event, params) => controlMiniApp('detach', params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_ATTACH, (_event, params) => controlMiniApp('attach', params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_APPLY_UPDATE, (_event, params) => applyMiniAppUpdate(params));
    setupMiniAppPermissionsIPC();
    setupMiniAppWindowHandleIPC();
}
/**
 * Plugin-detail switches; the Host renderer passes plain ids, Main re-validates them. A switch
 * changes what the Host admits from the next call on; revoked navigation observers also end.
 */
function setupMiniAppPermissionsIPC() {
    ipcMain.handle(IPC_CHANNELS.MINIAPP_PERMISSIONS_LIST, async (_event, params) => {
        if (!isRecordWithOnlyKeys(params, ['pluginId'])) {
            return { success: false, code: 'invalid_request' };
        }
        const pluginId = normalizeIdentifier(params.pluginId);
        if (!pluginId)
            return { success: false, code: 'invalid_request' };
        return permissionsResponse(() => requestUtilityMiniApp('permissions.list', pluginId));
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_PERMISSIONS_SET, async (_event, params) => {
        if (!isRecordWithOnlyKeys(params, ['pluginId', 'permission', 'enabled'])) {
            return { success: false, code: 'invalid_request' };
        }
        const pluginId = normalizeIdentifier(params.pluginId);
        const permission = parseMiniAppPermissionId(params.permission);
        if (!pluginId || !permission || typeof params.enabled !== 'boolean') {
            return { success: false, code: 'invalid_request' };
        }
        const enabled = params.enabled;
        // Revoke old observers and block new authorization until this write settles.
        // A lost reply cannot revive old subscriptions; later calls read the Runtime afresh.
        const revokeNavigation = permission.id === 'host:navigation.read' && !enabled;
        const releaseRevocation = revokeNavigation
            ? beginMiniAppNavigationRevocation(pluginId)
            : undefined;
        try {
            if (revokeNavigation) {
                getEmbeddedBrowserManager().onMiniAppPermissionChanged(pluginId, permission.id, false);
            }
            const response = await permissionsResponse(() => setUtilityMiniAppPermission({ pluginId, permission: permission.id, enabled }));
            if (response.success && !revokeNavigation) {
                getEmbeddedBrowserManager().onMiniAppPermissionChanged(pluginId, permission.id, enabled);
            }
            return response;
        }
        finally {
            // Even an unknown result releases this temporary gate. No local grant is restored:
            // successful off writes remain denied by the Runtime; failed writes leave no local deny latch.
            releaseRevocation?.();
        }
    });
}
async function permissionsResponse(request) {
    try {
        const result = await request();
        const permissions = result && typeof result === 'object' && 'permissions' in result
            ? parseMiniAppPermissionList(result.permissions)
            : null;
        return permissions
            ? { success: true, permissions }
            : { success: false, code: 'permission_failed' };
    }
    catch (error) {
        return { success: false, code: normalizeErrorCode(error, 'permission_failed') };
    }
}
/**
 * Page-facing `window.mcode.miniapp.window`. The calling tab is resolved from
 * Electron's `event.sender` / `event.senderFrame` only; nothing the page sends
 * identifies a target. Requests are re-parsed here even though the preload
 * already validated them.
 */
function setupMiniAppWindowHandleIPC() {
    ipcMain.handle(IPC_CHANNELS.MINIAPP_WINDOW_GET_STATE, (event) => {
        try {
            return getEmbeddedBrowserManager().getMiniAppWindowState(event.sender, event.senderFrame);
        }
        catch {
            return { success: false, code: 'result_unknown' };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_WINDOW_UPDATE, async (event, request) => {
        if (!isRecordWithOnlyKeys(request, ['patch', 'userActivated'])) {
            return { success: false, code: 'invalid_request' };
        }
        if (typeof request.userActivated !== 'boolean') {
            return { success: false, code: 'invalid_request' };
        }
        const parsed = parseMiniAppWindowPatch(request.patch);
        if (!parsed.ok)
            return { success: false, code: parsed.code };
        try {
            return await getEmbeddedBrowserManager().updateMiniAppWindow(event.sender, event.senderFrame, parsed.patch, request.userActivated);
        }
        catch {
            return { success: false, code: 'result_unknown' };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_WINDOW_FOCUS, (event, request) => {
        if (!isRecordWithOnlyKeys(request, ['userActivated']) ||
            typeof request.userActivated !== 'boolean') {
            return { success: false, code: 'invalid_request' };
        }
        try {
            return getEmbeddedBrowserManager().focusMiniAppWindow(event.sender, event.senderFrame, request.userActivated);
        }
        catch {
            return { success: false, code: 'result_unknown' };
        }
    });
}
function isRecordWithOnlyKeys(value, keys) {
    return (!!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) => keys.includes(key)));
}
const CONTROL_FAILURE_CODES = {
    refresh: 'refresh_failed',
    stop: 'stop_failed',
    detach: 'detach_failed',
    attach: 'attach_failed',
};
async function closeMiniApp(params) {
    const sessionId = normalizeIdentifier(params?.sessionId);
    const pluginId = normalizeIdentifier(params?.pluginId);
    if (!sessionId || !pluginId)
        return { success: false, code: 'invalid_request' };
    const startedAt = Date.now();
    try {
        const closedTabIds = closeManagedMiniAppPages(pluginId, {
            destroyTabs: (targetPluginId) => getEmbeddedBrowserManager().destroyMiniAppTabs(targetPluginId),
            stopRuntime: async () => {
                const result = await requestUtilityMiniApp('stop', pluginId);
                if (!('stopped' in result)) {
                    throw Object.assign(new Error('Mini App stop was not acknowledged'), {
                        code: 'stop_failed',
                    });
                }
                recordStopDiagnostic({
                    pluginId,
                    stage: 'utility_stop',
                    preserveTab: false,
                    stopAcknowledged: true,
                    startedAt,
                });
            },
            onStopFailure: (error) => {
                recordStopDiagnostic({
                    pluginId,
                    stage: 'utility_stop',
                    preserveTab: false,
                    stopAcknowledged: false,
                    code: normalizeErrorCode(error, 'stop_failed'),
                    error,
                    startedAt,
                });
            },
        });
        return { success: true, closedTabIds };
    }
    catch {
        miniAppControlLogger.warn({
            msg: '[MiniAppControl] page close failed',
            event: 'miniapp_close_failed',
            ...(isSafeDiagnosticPluginId(pluginId) ? { pluginId } : {}),
            surfaceCode: 'close_failed',
        });
        return { success: false, code: 'close_failed' };
    }
}
async function controlMiniApp(method, params) {
    const sessionId = normalizeIdentifier(params?.sessionId);
    const pluginId = normalizeIdentifier(params?.pluginId);
    if (!sessionId || !pluginId)
        return { success: false, code: 'invalid_request' };
    if (method === 'stop' &&
        params?.preserveTab !== undefined &&
        typeof params.preserveTab !== 'boolean') {
        return { success: false, code: 'invalid_request' };
    }
    const startedAt = Date.now();
    const preserveTab = params.preserveTab === true;
    let stage = 'prepare_control';
    let stopAcknowledged = false;
    const recordStopResult = (code, error) => {
        recordStopDiagnostic({
            pluginId,
            stage,
            preserveTab,
            stopAcknowledged,
            code,
            error,
            startedAt,
        });
    };
    try {
        const manager = getEmbeddedBrowserManager();
        if (method === 'refresh') {
            await manager.refreshMiniAppTab({
                sessionId,
                pluginId,
                readCredential: () => readRunningMiniAppCredential(pluginId),
            });
            return { success: true };
        }
        if (method === 'detach') {
            await manager.detachMiniAppTab({ sessionId, pluginId });
            return { success: true };
        }
        if (method === 'attach') {
            await manager.attachMiniAppTab({ sessionId, pluginId });
            return { success: true };
        }
        return await runManagedMiniAppStop(pluginId, async () => {
            stage = 'utility_stop';
            const result = await requestUtilityMiniApp('stop', pluginId);
            if (!('stopped' in result)) {
                recordStopResult('stop_failed');
                return { success: false, code: 'stop_failed' };
            }
            stopAcknowledged = true;
            manager.onMiniAppRuntimeStopped(pluginId);
            if (!preserveTab) {
                stage = 'destroy_tabs';
                manager.destroyMiniAppTabs(pluginId);
            }
            recordStopResult();
            return { success: true };
        });
    }
    catch (error) {
        const code = normalizeErrorCode(error, CONTROL_FAILURE_CODES[method]);
        if (method === 'stop')
            recordStopResult(code, error);
        return { success: false, code };
    }
}
function recordStopDiagnostic(input) {
    try {
        const diagnostic = readMiniAppBrokerFailureDiagnostic(input.error);
        const fields = {
            action: 'stop',
            stage: input.stage,
            ...(isSafeDiagnosticPluginId(input.pluginId) ? { pluginId: input.pluginId } : {}),
            preserveTab: input.preserveTab,
            stopAcknowledged: input.stopAcknowledged,
            ...(input.code ? { surfaceCode: input.code } : {}),
            ...(diagnostic?.brokerRequestId ? { brokerRequestId: diagnostic.brokerRequestId } : {}),
            ...(diagnostic?.hostCode ? { hostCode: diagnostic.hostCode } : {}),
            ...(diagnostic?.reasonCode ? { reasonCode: diagnostic.reasonCode } : {}),
            ...(diagnostic?.failureChain ? { failureChain: diagnostic.failureChain } : {}),
            durationMs: Math.max(0, Date.now() - input.startedAt),
        };
        if (input.code) {
            miniAppControlLogger.warn({
                msg: '[MiniAppControl] failed',
                event: 'miniapp_control_failed',
                ...fields,
            });
        }
        else {
            miniAppControlLogger.info({
                msg: '[MiniAppControl] completed',
                event: 'miniapp_control_completed',
                ...fields,
            });
        }
    }
    catch {
        // Diagnostics are best-effort and must never replace the renderer-safe result.
    }
}
/**
 * Behaves like the user pressing stop then start: the Utility restarts the Node, and only the
 * requesting session (if any) reopens its page through the regular open path.
 */
async function applyMiniAppUpdate(params) {
    const pluginId = normalizeIdentifier(params?.pluginId);
    const sessionId = params?.sessionId === undefined ? undefined : normalizeIdentifier(params.sessionId);
    if (!pluginId || sessionId === null)
        return { success: false, code: 'invalid_request' };
    try {
        return await runManagedMiniAppLaunch(pluginId, async (signal) => {
            const result = await requestUtilityMiniApp('applyUpdate', pluginId, signal);
            signal.throwIfAborted();
            if (!('launch' in result))
                return { success: false, code: 'update_failed' };
            // The service is updated from here on; a page that does not reopen is left to the user's start.
            try {
                syncManagedMiniAppLoopbackCredential(pluginId, {
                    origin: result.launch.origin,
                    loopbackToken: result.launch.loopbackToken,
                });
                if (sessionId)
                    await openManagedMiniAppSurface({ sessionId, pluginId, signal });
            }
            catch (error) {
                miniAppControlLogger.warn({
                    msg: '[MiniAppControl] reopen after update failed',
                    event: 'miniapp_update_reopen_failed',
                    ...(isSafeDiagnosticPluginId(pluginId) ? { pluginId } : {}),
                    surfaceCode: normalizeErrorCode(error),
                    errorName: error instanceof Error ? error.name : typeof error,
                });
            }
            return { success: true };
        });
    }
    catch (error) {
        // A full device stays distinguishable so the renderer can offer to free a slot.
        return failureResponse(normalizeErrorCode(error, 'update_failed'), error);
    }
}
async function startMiniApp(pluginId) {
    try {
        return await runManagedMiniAppLaunch(pluginId, async (signal) => {
            // Utility launch coordinates stay private in Main. The process-local open
            // operation ensures this specific Mini App Node is running. MCP discovery
            // follows the existing publication path; start does not promise that every
            // declared MCP endpoint is available. It projects only the renderer-safe
            // runtime summary and creates no tab.
            const result = await requestUtilityMiniApp('open', pluginId, signal);
            signal.throwIfAborted();
            if (!('launch' in result))
                return { success: false, code: 'start_failed' };
            // Pages of this plugin already open in any session follow the run just started.
            syncManagedMiniAppLoopbackCredential(pluginId, {
                origin: result.launch.origin,
                loopbackToken: result.launch.loopbackToken,
            });
            return { success: true, miniApp: result.miniApp };
        });
    }
    catch (error) {
        return failureResponse(normalizeErrorCode(error), error);
    }
}
async function openMiniApp(params) {
    const pluginId = normalizeIdentifier(params?.pluginId);
    if (!pluginId)
        return { success: false, code: 'invalid_request' };
    if (params.openPage === false)
        return startMiniApp(pluginId);
    if (params.openPage !== undefined && params.openPage !== true) {
        return { success: false, code: 'invalid_request' };
    }
    const sessionId = normalizeIdentifier(params?.sessionId);
    if (!sessionId)
        return { success: false, code: 'invalid_request' };
    const pageOptions = normalizePageOpenOptions(params);
    if (!pageOptions)
        return { success: false, code: 'invalid_request' };
    const startedAt = Date.now();
    try {
        const tab = await openManagedMiniAppSurface({ sessionId, pluginId, ...pageOptions });
        return { success: true, tab };
    }
    catch (error) {
        const failure = failureResponse(normalizeErrorCode(error), error);
        recordManualOpenFailure({
            pluginId,
            code: failure.code,
            ...(failure.busyReason ? { busyReason: failure.busyReason } : {}),
            error,
            durationMs: Math.max(0, Date.now() - startedAt),
        });
        return failure;
    }
}
function failureResponse(code, error) {
    if (code !== 'busy')
        return { success: false, code };
    const busyReason = normalizeBusyReason(error);
    return { success: false, code, ...(busyReason ? { busyReason } : {}) };
}
/** The optional page-open fields, or `undefined` when one is malformed. */
function normalizePageOpenOptions(params) {
    const { restoreTabId, keepSleepingTab } = params;
    if (restoreTabId !== undefined &&
        (typeof restoreTabId !== 'number' || !Number.isInteger(restoreTabId) || restoreTabId < 0)) {
        return undefined;
    }
    if (keepSleepingTab !== undefined && keepSleepingTab !== true)
        return undefined;
    return {
        ...(restoreTabId !== undefined ? { restoreTabId } : {}),
        ...(keepSleepingTab ? { keepSleepingTab } : {}),
    };
}
function recordManualOpenFailure(input) {
    try {
        const diagnostic = readMiniAppBrokerFailureDiagnostic(input.error);
        miniAppOpenLogger.warn({
            msg: '[MiniAppOpen] failed',
            event: 'miniapp_manual_open_failed',
            source: 'manual',
            stage: diagnostic ? 'utility_application' : 'main_surface',
            ...(isSafeDiagnosticPluginId(input.pluginId) ? { pluginId: input.pluginId } : {}),
            surfaceCode: input.code,
            ...(input.busyReason ? { busyReason: input.busyReason } : {}),
            ...(diagnostic?.brokerRequestId ? { brokerRequestId: diagnostic.brokerRequestId } : {}),
            ...(diagnostic?.hostCode ? { hostCode: diagnostic.hostCode } : {}),
            ...(diagnostic?.reasonCode ? { reasonCode: diagnostic.reasonCode } : {}),
            durationMs: input.durationMs,
        });
    }
    catch {
        // Diagnostics are best-effort and must never replace the renderer-safe result.
    }
}
function isSafeDiagnosticPluginId(value) {
    return value.length <= MAX_DIAGNOSTIC_PLUGIN_ID_LENGTH && SAFE_DIAGNOSTIC_PLUGIN_ID.test(value);
}
function normalizeIdentifier(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim();
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
        return null;
    }
    return normalized;
}
function normalizeErrorCode(error, fallback = 'start_failed') {
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return code === 'invalid_request' ||
        code === 'runtime_unavailable' ||
        code === 'not_found' ||
        code === 'busy' ||
        code === 'refresh_failed' ||
        code === 'stop_failed' ||
        code === 'start_failed' ||
        code === 'detach_failed' ||
        code === 'attach_failed' ||
        code === 'no_update' ||
        code === 'update_failed' ||
        code === 'permission_unknown' ||
        code === 'permission_failed'
        ? code
        : fallback;
}
function normalizeBusyReason(error) {
    const busyReason = error && typeof error === 'object' && 'busyReason' in error
        ? error.busyReason
        : undefined;
    return busyReason === 'capacity_busy' || busyReason === 'operation_busy' ? busyReason : undefined;
}
