import { ipcMain } from "electron";
import { parseMiniAppWindowPatch } from "@mavis/shared/miniapp-surface";
import { IPC_CHANNELS } from "../config/constants";
import { getEmbeddedBrowserManager, syncManagedMiniAppLoopbackCredential } from "../modules/browser/embedded-browser-manager";
import { readRunningMiniAppCredential, openManagedMiniAppSurface } from "../modules/browser/miniapp-surface";
import { requestUtilityMiniApp } from "../modules/local-runtime/utility";
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
                ? { success: true, miniApps: result.miniApps }
                : { success: false, code: 'start_failed' };
        }
        catch (error) {
            return { success: false, code: normalizeErrorCode(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_OPEN, (_event, params) => openMiniApp(params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_REFRESH, (_event, params) => controlMiniApp('refresh', params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_STOP, (_event, params) => controlMiniApp('stop', params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_DETACH, (_event, params) => controlMiniApp('detach', params));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_ATTACH, (_event, params) => controlMiniApp('attach', params));
    setupMiniAppWindowHandleIPC();
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
        stage = 'utility_stop';
        const result = await requestUtilityMiniApp('stop', pluginId);
        if (!('stopped' in result)) {
            recordStopResult('stop_failed');
            return { success: false, code: 'stop_failed' };
        }
        stopAcknowledged = true;
        if (!preserveTab) {
            stage = 'destroy_tabs';
            manager.destroyMiniAppTabs(pluginId);
        }
        recordStopResult();
        return { success: true };
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
async function startMiniApp(pluginId) {
    try {
        // Utility launch coordinates stay private in Main. The process-local open
        // operation ensures this specific Mini App Node is running. MCP discovery
        // follows the existing publication path; start does not promise that every
        // declared MCP endpoint is available. It projects only the renderer-safe
        // runtime summary and creates no tab.
        const result = await requestUtilityMiniApp('open', pluginId);
        if (!('launch' in result))
            return { success: false, code: 'start_failed' };
        // Pages of this plugin already open in any session follow the run just started.
        syncManagedMiniAppLoopbackCredential(pluginId, {
            origin: result.launch.origin,
            loopbackToken: result.launch.loopbackToken,
        });
        return { success: true, miniApp: result.miniApp };
    }
    catch (error) {
        const code = normalizeErrorCode(error);
        const busyReason = code === 'busy' ? normalizeBusyReason(error) : undefined;
        return code === 'busy'
            ? { success: false, code, ...(busyReason ? { busyReason } : {}) }
            : { success: false, code };
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
    const startedAt = Date.now();
    try {
        const tab = await openManagedMiniAppSurface({ sessionId, pluginId });
        return { success: true, tab };
    }
    catch (error) {
        const code = normalizeErrorCode(error);
        const busyReason = code === 'busy' ? normalizeBusyReason(error) : undefined;
        recordManualOpenFailure({
            pluginId,
            code,
            ...(busyReason ? { busyReason } : {}),
            error,
            durationMs: Math.max(0, Date.now() - startedAt),
        });
        if (code === 'busy') {
            return { success: false, code, ...(busyReason ? { busyReason } : {}) };
        }
        return { success: false, code };
    }
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
        code === 'attach_failed'
        ? code
        : fallback;
}
function normalizeBusyReason(error) {
    const busyReason = error && typeof error === 'object' && 'busyReason' in error
        ? error.busyReason
        : undefined;
    return busyReason === 'capacity_busy' || busyReason === 'operation_busy' ? busyReason : undefined;
}
