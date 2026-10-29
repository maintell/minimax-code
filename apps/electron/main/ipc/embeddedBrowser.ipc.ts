import { getDesktopConfig } from "./storage.ipc";
import { BrowserWindow, ipcMain, nativeImage, clipboard } from "electron";
import { withTimeout, BROWSER_TIMEOUTS, browserOperationFailure } from "@mavis/browser-core";
import { LOCAL_DESKTOP_RUNTIME_ID } from "@mavis/shared/desktop-runtime";
import { getActiveShortcutOverrides } from "@mavis/shared/keyboard-shortcuts";
import { isDev } from "../config";
import { DEV_SERVER_URL, IPC_CHANNELS } from "../config/constants";
import { isBrowserPreviewScope, isBrowserPreviewLayout, isBrowserDevicePreviewRequest } from "@mavis/shared/browser-device-preview";
import { getEmbeddedBrowserManager, openEmbeddedBrowserExternally } from "../modules/browser/embedded-browser-manager";
import { normalizeCommentKeys, normalizeCommentRevisions, validateCommentKey } from "../modules/browser/embedded-browser-manager-helpers";
import { createNewEmbeddedBrowserTab } from "../modules/browser/embedded-browser-new-tab";
import { getLocalServerRegistry } from "../modules/local-servers/registry";
import { getTerminalManager } from "../modules/terminal";
import { getCategoryLogger } from "../utils/logger";
const COMMENT_THEME_PALETTE_KEYS = [
    'surface',
    'border',
    'shadow',
    'text',
    'placeholder',
    'caret',
    'primaryBg',
    'primaryHover',
    'primaryInactive',
    'primaryIcon',
    'secondaryBg',
    'secondaryHover',
    'secondaryIcon',
    'tertiaryIcon',
    'tertiaryHover',
    'markerBackground',
    'markerBorder',
    'markerText',
    'markerShadow',
];
function normalizeCommentThemePalette(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const raw = value;
    if (!COMMENT_THEME_PALETTE_KEYS.every((key) => typeof raw[key] === 'string' && Boolean(raw[key].trim()))) {
        return undefined;
    }
    return Object.fromEntries(COMMENT_THEME_PALETTE_KEYS.map((key) => [key, raw[key].trim()]));
}
const COMMENT_STRING_KEYS = [
    'propsOnlyFeedback',
    'autosaved',
    'undo',
    'pending',
    'done',
    'voice',
];
/** Copy only the known UI strings; the bridge renders them as text, never HTML. */
function normalizeCommentStrings(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const raw = value;
    const entries = COMMENT_STRING_KEYS.flatMap((key) => typeof raw[key] === 'string' ? [[key, raw[key].slice(0, 200)]] : []);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
function normalizeBounds(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
        x: typeof raw.x === 'number' ? raw.x : -10000,
        y: typeof raw.y === 'number' ? raw.y : -10000,
        width: typeof raw.width === 'number' ? Math.max(1, Math.floor(raw.width)) : 800,
        height: typeof raw.height === 'number' ? Math.max(1, Math.floor(raw.height)) : 600,
    };
}
function normalizeBrowserTarget(value) {
    const raw = value && typeof value === 'object' ? value : {};
    return {
        ...(typeof raw.tabId === 'number' ? { tabId: raw.tabId } : {}),
        ...(typeof raw.sessionId === 'string' || raw.sessionId === null
            ? { sessionId: raw.sessionId }
            : {}),
    };
}
function normalizeDestroyParams(value) {
    return normalizeBrowserTarget(value);
}
function trustedPreviewHost(event) {
    if (event.sender.isDestroyed() ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame)
        return false;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents.id !== event.sender.id)
        return false;
    try {
        const url = new URL(event.sender.getURL());
        if (url.pathname !== '/archon' && url.pathname !== '/archon/')
            return false;
        return isDev
            ? url.origin === new URL(DEV_SERVER_URL).origin
            : url.protocol === 'app:' && url.hostname === '.';
    }
    catch {
        return false;
    }
}
function validPreviewTarget(value) {
    if (!value || typeof value !== 'object')
        return false;
    const raw = value;
    return (typeof raw.sessionId === 'string' &&
        raw.sessionId.length > 0 &&
        raw.sessionId.length <= 256 &&
        typeof raw.tabId === 'number' &&
        Number.isSafeInteger(raw.tabId) &&
        raw.tabId > 0);
}
function validPreviewLayoutRequest(event, bounds, params) {
    const raw = params;
    if (raw?.previewLayout === undefined)
        return true;
    return (trustedPreviewHost(event) &&
        validPreviewTarget(params) &&
        isBrowserPreviewScope(raw.previewScope) &&
        (raw.previewLayout === null || isBrowserPreviewLayout(raw.previewLayout)) &&
        Boolean(bounds) &&
        ['x', 'y', 'width', 'height'].every((key) => {
            const value = bounds[key];
            return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 30000;
        }) &&
        bounds.width > 0 &&
        bounds.height > 0);
}
function normalizeDevicePreviewMode(value) {
    return value === 'responsive' ||
        value === 'desktop' ||
        value === 'iphone-xr' ||
        value === 'mobile' ||
        value === 'tablet'
        ? value
        : null;
}
function normalizeExecuteToolParams(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const args = raw.args && typeof raw.args === 'object' ? raw.args : {};
    const target = normalizeBrowserTarget(value);
    return {
        tool: typeof raw.tool === 'string' ? raw.tool : '',
        args: {
            ...args,
            ...(target.sessionId !== undefined ? { sessionId: target.sessionId } : {}),
            ...(target.tabId !== undefined ? { tabId: target.tabId } : {}),
        },
    };
}
function normalizeNavigateParams(value) {
    if (typeof value === 'string')
        return { url: value, target: {} };
    const raw = value && typeof value === 'object' ? value : {};
    return {
        url: typeof raw.url === 'string' ? raw.url : '',
        target: normalizeBrowserTarget(value),
    };
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function normalizeRendererViewport(value) {
    const raw = value && typeof value === 'object' ? value : null;
    if (!raw)
        return undefined;
    const width = finiteNumber(raw.width);
    const height = finiteNumber(raw.height);
    const devicePixelRatio = finiteNumber(raw.devicePixelRatio);
    const rawVisualViewport = raw.visualViewport && typeof raw.visualViewport === 'object' ? raw.visualViewport : null;
    const visualViewport = rawVisualViewport
        ? {
            ...(finiteNumber(rawVisualViewport.width) !== undefined
                ? { width: finiteNumber(rawVisualViewport.width) }
                : {}),
            ...(finiteNumber(rawVisualViewport.height) !== undefined
                ? { height: finiteNumber(rawVisualViewport.height) }
                : {}),
            ...(finiteNumber(rawVisualViewport.scale) !== undefined
                ? { scale: finiteNumber(rawVisualViewport.scale) }
                : {}),
        }
        : null;
    if (width === undefined &&
        height === undefined &&
        devicePixelRatio === undefined &&
        visualViewport === null) {
        return undefined;
    }
    return {
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(devicePixelRatio !== undefined ? { devicePixelRatio } : {}),
        ...(visualViewport !== null ? { visualViewport } : {}),
    };
}
let terminalObserverWired = false;
let nextLayoutCommandId = 1;
let nextBrowserCreateDiagnosticId = 1;
const browserInputDiagnosticLogger = getCategoryLogger('archon', 'browser-input');
const lastIpcDiagnosticByAction = new Map();
function pageIdentity(url) {
    try {
        const parsed = new URL(url);
        return { pageScheme: parsed.protocol || null, pageHost: parsed.host || null };
    }
    catch {
        return { pageScheme: null, pageHost: null };
    }
}
function logIpcReceipt(action, event, details) {
    const payload = {
        msg: '[EmbeddedBrowserInput] ipc-received',
        action,
        senderWebContentsId: event.sender.id,
        ...details,
    };
    const key = JSON.stringify(payload);
    if (lastIpcDiagnosticByAction.get(action) === key)
        return;
    lastIpcDiagnosticByAction.set(action, key);
    browserInputDiagnosticLogger.info(payload);
}
function issueLayoutCommandId() {
    const commandId = nextLayoutCommandId;
    nextLayoutCommandId += 1;
    return commandId;
}
function getHostZoomFactor(event) {
    const factor = event.sender.getZoomFactor();
    return Number.isFinite(factor) && factor > 0.25 && factor < 4 ? factor : 1;
}
function getBrowserLayoutContext(event) {
    return {
        coordinateSpace: 'host-renderer-css',
        hostWebContentsId: event.sender.id,
        hostZoomFactor: getHostZoomFactor(event),
    };
}
export function setupEmbeddedBrowserIPC() {
    const manager = getEmbeddedBrowserManager();
    manager.setShortcutOverridesProvider(() => {
        const config = getDesktopConfig();
        return getActiveShortcutOverrides(config.shortcutOverrides ?? {}, config.shortcutsEnabled !== false);
    });
    if (!terminalObserverWired) {
        terminalObserverWired = true;
        getTerminalManager().addDataObserver((event) => {
            if (event.runtimeId === LOCAL_DESKTOP_RUNTIME_ID)
                getLocalServerRegistry().ingest(event);
        });
    }
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT, (event, envelope) => manager.handleCommentBridgeEvent(event.sender, envelope));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_AGENT_CURSOR_EVENT, (event, envelope) => manager.handleAgentCursorBridgeEvent(event.sender, envelope));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_CREATE, async (event, params) => {
        const createDiagnosticId = nextBrowserCreateDiagnosticId++;
        logIpcReceipt('create', event, {
            createDiagnosticId,
            newTab: params?.newTab === true,
            restoreOnly: params?.restoreOnly === true,
            hasInitialUrl: Boolean(params?.initialUrl),
            ...pageIdentity(params?.initialUrl ?? ''),
            sessionId: typeof params?.sessionId === 'string' ? params.sessionId : null,
            visible: params?.visible !== false,
            bounds: normalizeBounds(params?.bounds),
        });
        // The invoking renderer is the window that hosts the FilePanel browser
        // viewport — attach the WebContentsView there (works for main/archon).
        manager.setHostWindow(BrowserWindow.fromWebContents(event.sender), event.sender.id, getHostZoomFactor(event));
        const viewport = normalizeRendererViewport(params?.viewport);
        const bounds = normalizeBounds(params?.bounds);
        const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : null;
        const options = {
            visible: params?.visible !== false,
            ...(params?.restoreOnly === true ? { restoreOnly: true } : {}),
            ...(typeof params?.initialUrl === 'string' ? { initialUrl: params.initialUrl } : {}),
            layoutContext: getBrowserLayoutContext(event),
            ...(viewport ? { viewport } : {}),
        };
        try {
            const result = await (params?.newTab === true
                ? createNewEmbeddedBrowserTab(manager, bounds, sessionId, options)
                : manager.createOrShow(bounds, sessionId, options));
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserInput] create-completed',
                createDiagnosticId,
                sessionId,
                tabId: result.tabId ?? null,
                selectedTabId: result.selectedTabId ?? null,
                tabIds: Array.isArray(result.tabs)
                    ? result.tabs.map((tab) => tab.tabId)
                    : undefined,
                success: result.success !== false,
                ...pageIdentity(typeof result.url === 'string' ? result.url : ''),
            });
            return result;
        }
        catch (error) {
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserInput] create-failed',
                createDiagnosticId,
                sessionId,
                errorName: error instanceof Error ? error.name : 'unknown',
            });
            throw error;
        }
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_SHOW, async (event, bounds, params) => {
        if (!validPreviewLayoutRequest(event, bounds, params))
            return { success: false, error: 'Invalid device preview layout' };
        const layoutCommandId = issueLayoutCommandId();
        manager.setHostWindow(BrowserWindow.fromWebContents(event.sender), event.sender.id, getHostZoomFactor(event));
        const normalizedBounds = normalizeBounds(bounds);
        const target = normalizeBrowserTarget(params);
        const viewport = normalizeRendererViewport(params?.viewport);
        logIpcReceipt('show', event, {
            sessionId: target.sessionId ?? null,
            tabId: target.tabId ?? null,
            bounds: normalizedBounds,
        });
        return manager.show(normalizedBounds, target, viewport, getBrowserLayoutContext(event), layoutCommandId, ...(params?.previewLayout !== undefined ? [params.previewLayout] : []));
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_SET_BOUNDS, async (event, bounds, params) => {
        if (!validPreviewLayoutRequest(event, bounds, params))
            return { success: false, error: 'Invalid device preview layout' };
        const layoutCommandId = issueLayoutCommandId();
        // Refresh the host because a hot reload/window switch can leave the
        // manager with a stale BrowserWindow even when create is not re-issued.
        manager.setHostWindow(BrowserWindow.fromWebContents(event.sender), event.sender.id, getHostZoomFactor(event));
        const normalizedBounds = normalizeBounds(bounds);
        const sessionId = typeof params?.sessionId === 'string' || params?.sessionId === null
            ? params.sessionId
            : undefined;
        const target = normalizeBrowserTarget(params);
        const viewport = normalizeRendererViewport(params?.viewport);
        const layoutOptions = {
            layoutCommandId,
            layoutContext: getBrowserLayoutContext(event),
            ...(params?.previewLayout !== undefined ? { previewLayout: params.previewLayout } : {}),
        };
        logIpcReceipt('set-bounds', event, {
            sessionId: target.sessionId ?? null,
            tabId: target.tabId ?? null,
            bounds: normalizedBounds,
        });
        return viewport
            ? manager.setBounds(normalizedBounds, sessionId, viewport, target, layoutOptions)
            : manager.setBounds(normalizedBounds, sessionId, undefined, target, layoutOptions);
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_SET_DEVICE_PREVIEW_MODE, async (_event, params) => {
        const raw = params && typeof params === 'object' ? params : {};
        const mode = normalizeDevicePreviewMode(raw.mode);
        if (!mode)
            return { success: false, error: 'Invalid device preview mode' };
        return manager.setDevicePreviewMode(mode, normalizeBrowserTarget(params));
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_UPDATE_DEVICE_PREVIEW, async (event, params) => {
        if (!trustedPreviewHost(event) || !validPreviewTarget(params)) {
            return { success: false, error: 'Invalid device preview host or target' };
        }
        const raw = params;
        if (!isBrowserPreviewScope(raw.previewScope) || !isBrowserDevicePreviewRequest(raw.request)) {
            return { success: false, error: 'Invalid local device preview request' };
        }
        return manager.updateDevicePreview(raw.request, {
            sessionId: params.sessionId,
            tabId: params.tabId,
        });
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_SET_NATIVE_OVERLAY_OCCLUSION, async (_event, params) => {
        const raw = params && typeof params === 'object' ? params : {};
        const leaseId = typeof raw.leaseId === 'string' ? raw.leaseId.trim() : '';
        if (!leaseId)
            return { success: false, error: 'leaseId is required' };
        if (leaseId.length > 200)
            return { success: false, error: 'leaseId is too long' };
        if (typeof raw.active !== 'boolean') {
            return { success: false, error: 'active must be a boolean' };
        }
        if (raw.policy !== undefined && raw.policy !== 'blocking' && raw.policy !== 'resize') {
            return { success: false, error: 'Invalid native overlay policy' };
        }
        return manager.setNativeOverlayOcclusion(leaseId, raw.active, raw.policy ?? 'blocking');
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_HIDE, async (_event, params) => {
        const layoutCommandId = issueLayoutCommandId();
        return manager.hide({ ...normalizeDestroyParams(params), ...(params?.select === true ? { select: true } : {}) }, layoutCommandId);
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_DESTROY, async (_event, params) => manager.destroy(normalizeDestroyParams(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_GET_STATE, async (_event, params) => manager.getState({
        ...normalizeBrowserTarget(params),
        ...(typeof params?.afterEventId === 'number' ? { afterEventId: params.afterEventId } : {}),
    }));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_EXECUTE_TOOL, async (_event, params) => {
        const normalized = normalizeExecuteToolParams(params);
        const tool = normalized.tool;
        if (!tool)
            return { success: false, error: 'tool is required' };
        try {
            return await withTimeout((signal) => Promise.resolve(manager.executeTool(tool, normalized.args ?? {}, signal)), BROWSER_TIMEOUTS.ipcHandler, 'EMBEDDED_BROWSER_EXECUTE_TOOL');
        }
        catch (error) {
            const failure = browserOperationFailure(error);
            if (failure)
                return failure;
            throw error;
        }
    });
    // Navigation-style actions return immediately: the manager's promises wait
    // for full page-ready (5s+), which would pin the toolbar in a busy state.
    // Progress and load errors reach the UI via the polled getState instead.
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_NAVIGATE, async (event, params) => {
        const normalized = normalizeNavigateParams(params);
        if (!normalized.url)
            return { success: false, error: 'url is required' };
        logIpcReceipt('navigate', event, {
            sessionId: normalized.target.sessionId ?? null,
            tabId: normalized.target.tabId ?? null,
            ...pageIdentity(normalized.url),
        });
        void Promise.resolve(manager.navigate(normalized.url, normalized.target)).catch(() => { });
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_SCREENSHOT, async (_event, params) => {
        const result = (await manager.executeTool('screenshot', normalizeBrowserTarget(params)));
        if (result?.success === true && typeof result.data === 'string') {
            const image = nativeImage.createFromBuffer(Buffer.from(result.data, 'base64'));
            const copied = !image.isEmpty();
            if (copied)
                clipboard.writeImage(image);
            // Keep the base64 payload in the main process; the renderer only needs
            // the outcome.
            return { success: true, copied, width: result.width, height: result.height };
        }
        return result;
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_GO_BACK, async (_event, params) => {
        void Promise.resolve(manager.goBack(normalizeBrowserTarget(params))).catch(() => { });
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_GO_FORWARD, async (_event, params) => {
        void Promise.resolve(manager.goForward(normalizeBrowserTarget(params))).catch(() => { });
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_RELOAD, async (_event, params) => {
        void Promise.resolve(manager.reload(normalizeBrowserTarget(params))).catch(() => { });
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_FORCE_RELOAD, async (_event, params) => manager.forceReload(normalizeBrowserTarget(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_SET_ZOOM, async (_event, params) => manager.setZoom(typeof params?.factor === 'number' ? params.factor : 1, normalizeBrowserTarget(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_CLEAR_COOKIES, async (_event, params) => manager.clearCookies(normalizeBrowserTarget(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_CLEAR_CACHE, async (_event, params) => manager.clearCache(normalizeBrowserTarget(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_SET_COMMENT_MODE, async (_event, params) => {
        const palette = normalizeCommentThemePalette(params?.palette);
        const strings = normalizeCommentStrings(params?.strings);
        // Only a missing field opts into legacy full-page handling.
        // Explicit malformed values must never widen the operation.
        let selectiveKeys;
        if (params && 'commentKeys' in params) {
            const result = normalizeCommentKeys(params.commentKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            if (result.selective)
                selectiveKeys = result.keys;
        }
        return manager.setCommentMode(Boolean(params?.enabled), typeof params?.placeholder === 'string' ? params.placeholder : undefined, {
            clearComments: Boolean(params?.clearComments),
            ...(params?.selectionMode === 'dom_node' || params?.selectionMode === 'free_rect'
                ? { selectionMode: params.selectionMode }
                : {}),
            ...(params?.theme === 'light' || params?.theme === 'dark' || params?.theme === 'system'
                ? { theme: params.theme }
                : {}),
            ...(palette ? { palette } : {}),
            ...(strings ? { strings } : {}),
            ...(typeof params?.locale === 'string' && params.locale
                ? { locale: params.locale.slice(0, 20) }
                : {}),
            ...(params?.markSent === true ? { markSent: true } : {}),
            ...(selectiveKeys !== undefined ? { commentKeys: selectiveKeys } : {}),
            ...(typeof params?.propsExpanded === 'boolean'
                ? { propsExpanded: params.propsExpanded }
                : {}),
            ...normalizeBrowserTarget(params),
        });
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_RESOLVE_SENT_COMMENTS, async (_event, params) => {
        let selectiveKeys;
        if (params && 'commentKeys' in params) {
            const result = normalizeCommentKeys(params.commentKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            if (result.selective)
                selectiveKeys = result.keys;
        }
        let revisions;
        if (params && 'commentRevisions' in params) {
            const result = normalizeCommentRevisions(params.commentRevisions, selectiveKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            revisions = result.revisions;
        }
        return manager.resolveSentComments(params?.status === 'done' ? 'done' : 'cancelled', normalizeBrowserTarget(params), selectiveKeys !== undefined
            ? { commentKeys: selectiveKeys, ...(revisions ? { commentRevisions: revisions } : {}) }
            : undefined);
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_REMOVE_COMMENT, async (_event, params) => {
        const commentId = Number(params?.commentId);
        if (!Number.isInteger(commentId) || commentId <= 0) {
            return { success: false, error: 'Invalid comment id' };
        }
        // An explicit bad `commentKey` must be refused outright: a stale or
        // malformed key cannot fall back to the mutable commentId, and we
        // must not silently strip it. The host should retry with a valid
        // (or omitted) key.
        let validatedKey;
        if (params && 'commentKey' in params) {
            const result = validateCommentKey(params.commentKey);
            if (!result.ok)
                return { success: false, error: result.error };
            validatedKey = result.key;
        }
        return manager.removeComment({
            commentId,
            ...(validatedKey !== undefined ? { commentKey: validatedKey } : {}),
            ...(typeof params?.selector === 'string' ? { selector: params.selector } : {}),
            ...(typeof params?.pageUrl === 'string' ? { pageUrl: params.pageUrl } : {}),
        }, normalizeBrowserTarget(params));
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_COMMENT_VOICE_UPDATE, async (_event, params) => manager.updateCommentVoice({
        state: params?.state === 'listening' || params?.state === 'transcribing'
            ? params.state
            : 'idle',
        ...(typeof params?.text === 'string' ? { text: params.text.slice(0, 4000) } : {}),
    }, normalizeBrowserTarget(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_CLEAR_COMMENTS, async (_event, params) => {
        // Only a missing field opts into legacy full-page handling. An
        // explicit malformed `commentKeys` array must fail closed without
        // ever widening into a full clear.
        let selectiveKeys;
        if (params && 'commentKeys' in params) {
            const result = normalizeCommentKeys(params.commentKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            if (result.selective)
                selectiveKeys = result.keys;
        }
        let revisions;
        if (params && 'commentRevisions' in params) {
            const result = normalizeCommentRevisions(params.commentRevisions, selectiveKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            revisions = result.revisions;
        }
        return manager.clearComments(normalizeBrowserTarget(params), {
            ...(params?.markSent === true ? { markSent: true } : {}),
            ...(selectiveKeys !== undefined ? { commentKeys: selectiveKeys } : {}),
            ...(revisions ? { commentRevisions: revisions } : {}),
        });
    });
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_ACK_COMMENT_EVENTS, async (_event, params) => manager.ackCommentEvents({
        ...normalizeBrowserTarget(params),
        ...(typeof params?.throughEventId === 'number'
            ? { throughEventId: params.throughEventId }
            : {}),
    }));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_OPEN_EXTERNAL, async (_event, params) => openEmbeddedBrowserExternally(normalizeBrowserTarget(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_CAPTURE_FRAME, async (_event, params) => manager.captureFrame(normalizeBrowserTarget(params)));
    ipcMain.handle(IPC_CHANNELS.EMBEDDED_BROWSER_LIST_LOCAL_SERVERS, async (_event, params) => ({
        success: true,
        servers: await getLocalServerRegistry().list(typeof params?.sessionId === 'string' ? params.sessionId : null),
    }));
}
