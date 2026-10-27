import { BaseWindow, app, webContents as electronWebContents } from "electron";
import { sanitizeConsoleDiagnosticUrl, BROWSER_TIMEOUTS, withTimeout } from "@mavis/browser-core";
import { getConfig } from "@mavis/config";
import { randomUUID } from "node:crypto";
import { BrowserController } from "./controller";
import { BackgroundBrowserRenderHost } from "./background-browser-render-host";
import { EmbeddedBrowserToolRuntime } from "./embedded-browser-tool-runtime";
import { EMBEDDED_COMMENT_WORLD_ID, EMBEDDED_COMMENT_BRIDGE_SCRIPT, EMBEDDED_COMMENT_CONTROL_NAME, normalizeCommentBridgeMessage } from "./embedded-comment-bridge";
import { loadEmbeddedPropsPanelScript } from "./embedded-props-panel";
import { IPC_CHANNELS } from "../../config/constants";
import { captureTabScreenshotWithoutAgentCursor, withDevicePreviewLease, captureFrameWithoutAgentCursor, isAgentCursorVisible, handleAgentCursorBridgeEvent, withAgentCursorHiddenForCapture, executeWithAgentExecutionGlow, executeWithAgentCursorLease } from "./embedded-browser-agent-cursor";
import { windowManager } from "../../windows/manager";
import { getMainWindow } from "../../windows/mainWindow";
import { getCategoryLogger } from "../../utils/logger";
import { openExternalTarget } from "../../utils/open-external-target";
import { PersistentBrowserRegistry, normalizePersistedBrowserUrl, MAX_PERSISTED_BROWSER_HISTORY_ENTRIES, createPersistentBrowserRegistry } from "./persistent-browser-registry";
import { ENABLE_BROWSER_INPUT_DIAGNOSTICS, urlHost, OFFSCREEN_BOUNDS, presentationLoadError, safeError, normalizeBrowserTarget, nowMs, normalizeCommentSelectionMode, normalizeCommentKeys, normalizeCommentRevisions, normalizeUrl, HIDDEN_SWEEP_INTERVAL_MS, MAX_HIDDEN_TABS, HIDDEN_IDLE_TIMEOUT_MS, AGENT_OPERATION_KEEPALIVE_MS, HIDDEN_LOADING_GRACE_MS, finiteNumber, DEFAULT_BOUNDS, isMainDocumentNavigation, asRecord, asString, asCommentRenumberMap, asNumber, normalizeCommentPayload, PENDING_COMMENT_EVENT_LIMIT, assertBrowserTabBelongsToSession, AGENT_BROWSER_ACTIONS } from "./embedded-browser-manager-helpers";
import { setTabDevicePreviewMode, updateTabDevicePreview } from "./embedded-browser-device-preview";
import { EmbeddedBrowserResourceDiagnostics } from "./embedded-browser-resource-diagnostics";
import { EmbeddedBrowserAdaptiveBudget, memoryWeightedLruValue } from "./embedded-browser-adaptive-budget";
import { capturePageResume, restorePageResume } from "./embedded-browser-page-resume";
import { safeEmbeddedBrowserFaviconUrl } from "./embedded-browser-tab-metadata";
import { openDetachedWindow, attachDetachedTab, showDetachedPlaceholder, hideDetachedPlaceholder, closeDetachedWindow } from "./miniapp-detached-window";
import { registerMiniAppLoopbackAuth } from "./miniapp-loopback-auth";
import { MiniAppDevicePermissionGate } from "./miniapp-device-permissions";
import { readMiniAppWindowState, updateMiniAppWindow, focusMiniAppWindow, revealMiniAppWindow } from "./miniapp-window-handle";
const logger = getCategoryLogger('archon');
const browserInputDiagnosticLogger = getCategoryLogger('archon', 'browser-input');
const browserNavigationDiagnosticLogger = getCategoryLogger('archon', 'browser-navigation');
class BrowserCommentBackpressureError extends Error {
}
const MAX_PAGE_DIAGNOSTIC_TEXT_CHARS = 4096;
const BROWSER_NAVIGATION_DIAGNOSTIC_WORLD_ID = 1004;
const SECURITY_CHALLENGE_SIGNALS = [
    '访问受到安全保护',
    '访问安全验证',
    '当前请求存在风险',
    '完成安全验证后继续访问',
];
const SECURITY_CHALLENGE_REQUEST_ID_PATTERN = /(?:请求|request)\s*id\s*[:：]?\s*([a-z0-9_-]{6,64})/iu;
function sanitizeBrowserNavigationUrl(value) {
    if (/^data:/iu.test(value))
        return 'data:[REDACTED]';
    if (/^blob:/iu.test(value)) {
        return `blob:${sanitizeConsoleDiagnosticUrl(value.slice('blob:'.length))}`;
    }
    return sanitizeConsoleDiagnosticUrl(value);
}
async function readBrowserSecurityChallengeSummary(webContents, title) {
    const signal = SECURITY_CHALLENGE_SIGNALS.find((candidate) => title.includes(candidate));
    if (!signal || webContents.isDestroyed())
        return { detected: false };
    const requestIdResult = await webContents.executeJavaScriptInIsolatedWorld(BROWSER_NAVIGATION_DIAGNOSTIC_WORLD_ID, [
        {
            code: `(() => {
          const bodyText = typeof document.body?.innerText === 'string'
            ? document.body.innerText.slice(0, ${MAX_PAGE_DIAGNOSTIC_TEXT_CHARS})
            : '';
          return bodyText.match(new RegExp(${JSON.stringify(SECURITY_CHALLENGE_REQUEST_ID_PATTERN.source)}, 'iu'))?.[1] ?? null;
        })()`,
        },
    ], false);
    const requestId = typeof requestIdResult === 'string' && /^[a-z0-9_-]{6,64}$/iu.test(requestIdResult)
        ? requestIdResult
        : undefined;
    return { detected: true, signal, ...(requestId ? { requestId } : {}) };
}
const MAX_IN_MEMORY_HISTORY_PAGE_STATE_BYTES = 4 * 1024 * 1024;
export class EmbeddedBrowserManager {
    setShortcutOverridesProvider(provider) {
        this.getShortcutOverrides = provider;
    }
    constructor(options = {}) {
        this.tabs = new Map();
        this.sessions = new Map();
        this.activeTabId = null;
        this.latestShowLayoutCommandId = 0;
        this.hostWindow = null;
        this.hostWebContentsId = null;
        this.hostZoomFactor = 1;
        this.hostWindowDisposers = [];
        this.lastGetStateDiagnosticKey = null;
        this.lastBoundsDiagnosticKey = null;
        this.lastNativeLayerDiagnosticKey = null;
        this.hiddenSweepTimer = null;
        /** Depth of in-flight agent tool executions; marks tab operations as agent-driven. */
        this.agentToolCallDepth = 0;
        this.destroyingTabIds = new Set();
        this.suspendingTabIds = new Set();
        this.coldResumeSnapshots = new Map();
        this.suspendedTabs = new Map();
        this.resumingTabs = new Map();
        this.ensuringSessionTabs = new Map();
        this.creatingTabs = new Map();
        this.miniAppOperationTails = new Map();
        this.miniAppOperationControllers = new Map();
        this.miniAppOperationEpochs = new Map();
        this.miniAppLoopbackAuth = new Map();
        this.miniAppLoopbackAuthSessions = new WeakSet();
        this.miniAppDevicePermissionSessions = new WeakSet();
        this.nativeOverlayOcclusionLeases = new Set();
        this.nativeResizeLeases = new Set();
        this.navigationDiagnostics = new Map();
        this.nextTabId = 1;
        this.nextCommentEventId = 1;
        /** Whether the property inspector opens expanded; shared by every tab. */
        this.propsPanelExpanded = false;
        /** The page reported a toggle this run; renderer seeds no longer apply. */
        this.propsPanelPreferenceKnown = false;
        this.getShortcutOverrides = () => ({});
        this.lastResourceDiagnosticPressure = 'normal';
        this.registry = options.registry ?? new PersistentBrowserRegistry();
        this.backgroundRenderHost = options.backgroundRenderHost ?? new BackgroundBrowserRenderHost();
        this.isAgentCursorEnabled = options.isAgentCursorEnabled ?? (() => true);
        this.controllerFactory =
            options.controllerFactory ??
                (() => new BrowserController({
                    getShortcutOverrides: () => this.getShortcutOverrides(),
                }));
        this.miniAppDevicePermissions = new MiniAppDevicePermissionGate({
            resolvePlugin: (contents) => this.identifyMiniAppPage(contents),
            // Dynamic for the same reason as `loadWindowMemory`: the Utility bridge must not be
            // loaded just by importing this module.
            switches: options.miniAppPermissionSwitches ?? {
                isEnabled: async (pluginId, permission) => (await import('./miniapp-permission-switches'))
                    .createUtilityMiniAppPermissionSwitches()
                    .isEnabled(pluginId, permission),
            },
        });
        this.detachedWindowHost = {
            detachedWindowFactory: options.detachedWindowFactory ?? ((windowOptions) => new BaseWindow(windowOptions)),
            // Dynamic: `window-state/miniapp-bounds` pulls in desktop storage, which
            // generic browser-tab code must never eagerly load just by importing this
            // module (see "Embedded browser module boundary" in the test suite).
            loadWindowMemory: () => import('../window-state/miniapp-bounds'),
            claimForeground: (tab) => this.backgroundRenderHost.claimForeground(tab.controller),
            requireCurrentTab: (tab) => {
                if (this.tabs.get(tab.tabId) !== tab)
                    throw miniAppTabNotFoundError();
            },
            getHostWindow: () => this.getHostWindow(),
            markTabHidden: (tab) => this.markTabHidden(tab),
            parkOtherVisibleInlineTabs: (tab, reason) => {
                this.parkOtherVisibleInlineTabs(tab, reason);
            },
            isAppQuitting: () => windowManager.isAppQuitting(),
        };
        this.adaptiveBudget = options.adaptiveBudget ?? new EmbeddedBrowserAdaptiveBudget();
        this.browserResourceDiagnostics = new EmbeddedBrowserResourceDiagnostics({
            getTabs: () => Array.from(this.tabs.values()).map((tab) => ({
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                hidden: tab.hiddenAt !== null,
                operationCount: tab.operationCount ?? 0,
                webContents: this.getWebContents(tab),
            })),
            log: (snapshot) => browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserResource] sample',
                ...snapshot,
            }),
            // Full snapshots enumerate every Electron process and WebContents. Keep
            // the interval for unpackaged diagnostics only; packaged builds still
            // sample lifecycle events, crashes and memory-pressure transitions.
            periodicSamplingEnabled: !app.isPackaged && ENABLE_BROWSER_INPUT_DIAGNOSTICS,
        });
        this.toolRuntime = new EmbeddedBrowserToolRuntime({
            requireBrowserTab: (target, runtimeOptions) => this.requireBrowserTab(target, runtimeOptions),
            resolveBrowserTab: (target, runtimeOptions) => this.resolveBrowserTab(target, runtimeOptions),
            goBack: (target, signal) => this.goBack(target, signal),
            goForward: (target, signal) => this.goForward(target, signal),
            reload: (target, signal) => this.reload(target, signal),
            withTabOperation: (tab, label, operation, runtimeOptions) => this.withTabOperation(tab, label, operation, runtimeOptions),
            refreshTabState: (tab) => this.refreshTabState(tab),
            clearRequestedUrlForNavigation: (tab, nextUrl) => this.clearRequestedUrlForNavigation(tab, nextUrl),
            getWebContents: (tab) => this.getWebContents(tab),
            captureTabScreenshot: (tab, params) => captureTabScreenshotWithoutAgentCursor(tab, params ?? {}, (target) => this.getWebContents(target)),
        });
    }
    /**
     * Opens a Plugin-owned Mini App in the existing native Browser surface.
     * The renderer receives only the safe tab summary; loopback launch
     * coordinates remain in Electron main.
     */
    async openMiniAppTab(input) {
        input.signal?.throwIfAborted();
        assertMiniAppGenerationCurrent(input.isGenerationCurrent);
        const sessionId = input.sessionId.trim();
        if (!sessionId)
            throw new Error('Mini App requires an active session');
        const pluginId = input.miniApp.pluginId.trim();
        if (!pluginId)
            throw new Error('Mini App requires a plugin');
        return this.runMiniAppTargetOperation({
            sessionId,
            pluginId,
            signal: input.signal,
            isGenerationCurrent: input.isGenerationCurrent,
        }, (revocationSignal) => this.openMiniAppTabOnce(input, sessionId, revocationSignal));
    }
    async refreshMiniAppTab(input) {
        const sessionId = input.sessionId.trim();
        const pluginId = input.pluginId.trim();
        return this.runMiniAppTargetOperation({ sessionId, pluginId }, async (signal) => {
            const tab = this.requireMiniAppTabBySession(sessionId, pluginId);
            // Read the credential once this operation is actually dequeued, not when refresh was
            // requested, so a restart that finished while this waited is picked up. The read and the
            // sync below run back-to-back inside this serialized per-target operation; a restart
            // landing in that microsecond gap is corrected by the next open/refresh.
            const credential = await input.readCredential?.();
            if (credential)
                this.syncMiniAppLoopbackCredential(pluginId, credential);
            tab.lastLoadError = null;
            await this.withTabOperation(tab, 'miniapp-refresh', () => tab.controller.reload(), {
                signal,
            });
            this.refreshTabState(tab);
            return this.miniAppTabSummary(tab);
        });
    }
    /** Moves the existing Mini App WebContents into its own window; repeated calls are no-ops. */
    async detachMiniAppTab(input) {
        const sessionId = input.sessionId.trim();
        const pluginId = input.pluginId.trim();
        return this.runMiniAppTargetOperation({ sessionId, pluginId }, async (signal) => {
            const tab = this.requireMiniAppTabBySession(sessionId, pluginId);
            if (!tab.detachedWindow) {
                await openDetachedWindow(this.detachedWindowHost, tab, signal, input.initialSize, input.userActivated);
            }
            return this.miniAppTabSummary(tab);
        });
    }
    /** Returns a detached Mini App page to the File Panel host; repeated calls are no-ops. */
    async attachMiniAppTab(input) {
        const sessionId = input.sessionId.trim();
        const pluginId = input.pluginId.trim();
        return this.runMiniAppTargetOperation({ sessionId, pluginId }, async () => {
            const tab = this.requireMiniAppTabBySession(sessionId, pluginId);
            attachDetachedTab(this.detachedWindowHost, tab);
            return this.miniAppTabSummary(tab);
        });
    }
    requireMiniAppTabBySession(sessionId, pluginId) {
        const tab = this.resolveMiniAppTabBySession(sessionId, pluginId);
        if (!tab?.miniApp)
            throw miniAppTabNotFoundError();
        return tab;
    }
    /**
     * The managed Mini App tab whose own main frame sent an IPC, or null. The
     * origin comes from Electron, never from a field the page supplies.
     */
    resolveMiniAppSenderTab(sender, senderFrame) {
        try {
            if (sender.isDestroyed() ||
                !senderFrame ||
                senderFrame.detached ||
                senderFrame !== sender.mainFrame) {
                return null;
            }
            const tab = Array.from(this.tabs.values()).find((candidate) => this.getWebContents(candidate) === sender);
            if (!tab?.miniApp ||
                new URL(senderFrame.url).origin !== tab.miniApp.origin ||
                new URL(sender.getURL()).origin !== tab.miniApp.origin) {
                return null;
            }
            return tab;
        }
        catch {
            // Reading a frame or WebContents can race with Chromium teardown.
            return null;
        }
    }
    /**
     * The Mini App whose page a WebContents shows, judged like a page IPC sender: its main frame
     * must still be on the launch origin. Null for a plain browser tab or a navigated-away page.
     */
    identifyMiniAppPage(contents) {
        if (!contents)
            return null;
        try {
            // `mainFrame` itself throws once the WebContents is destroyed.
            const tab = this.resolveMiniAppSenderTab(contents, contents.mainFrame);
            return tab?.miniApp ? { pluginId: tab.miniApp.miniApp.pluginId } : null;
        }
        catch {
            return null;
        }
    }
    /** The Host renderer switched a Mini App permission; only the microphone has page-side state. */
    onMiniAppPermissionChanged(pluginId, permission, enabled) {
        if (!enabled && permission === 'device:microphone') {
            this.miniAppDevicePermissions.revokeMicrophone(pluginId);
        }
    }
    /** Identify the managed page once; Session and Host availability are independent targets. */
    captureMiniAppComposerSource(sender, senderFrame) {
        const tab = this.resolveMiniAppSenderTab(sender, senderFrame);
        if (!tab?.miniApp)
            return null;
        let ownerWebContents = null;
        let ownerFrame = null;
        try {
            const ownerWindow = this.hostWindow;
            if (ownerWindow && !ownerWindow.isDestroyed()) {
                const contents = ownerWindow.webContents;
                if (!contents.isDestroyed()) {
                    ownerWebContents = contents;
                    const frame = contents.mainFrame;
                    ownerFrame = frame && !frame.detached ? frame : null;
                }
            }
        }
        catch {
            // Host teardown does not change the already identified MiniApp caller.
            ownerWebContents = null;
            ownerFrame = null;
        }
        return {
            pluginId: tab.miniApp.miniApp.pluginId,
            pluginName: tab.miniApp.miniApp.displayName ?? tab.miniApp.miniApp.pluginId,
            runId: tab.miniApp.runId,
            sessionId: tab.sessionId,
            ownerWebContents,
            ownerFrame,
        };
    }
    /**
     * Where a Host prompt for `pluginId` can be shown: the Host window's main frame when the user
     * can see it, or when the plugin has an open Mini App page (inline or detached), in which case
     * the Host window is brought forward. `null` when neither holds.
     */
    resolveMiniAppPromptTarget(pluginId) {
        const page = Array.from(this.tabs.values()).find((tab) => tab.miniApp?.miniApp.pluginId === pluginId);
        try {
            const window = this.hostWindow;
            if (!window || window.isDestroyed())
                return null;
            const visible = window.isVisible() && !window.isMinimized();
            if (!visible && !page)
                return null;
            const host = window.webContents;
            const frame = host.isDestroyed() ? null : host.mainFrame;
            if (!frame || frame.detached)
                return null;
            if (!visible) {
                if (window.isMinimized())
                    window.restore();
                window.show();
            }
            return {
                host,
                frame,
                pluginName: page?.miniApp?.miniApp.displayName ?? pluginId,
            };
        }
        catch {
            // Host teardown races Chromium; no target.
            return null;
        }
    }
    /** `window.mcode.miniapp.window.getState()` for the calling page. */
    getMiniAppWindowState(sender, senderFrame) {
        const tab = this.resolveMiniAppSenderTab(sender, senderFrame);
        if (!tab)
            return { success: false, code: 'not_found' };
        return { success: true, state: readMiniAppWindowState(tab) };
    }
    /** `window.mcode.miniapp.window.update(patch)`; the patch is already allowlist-parsed. */
    async updateMiniAppWindow(sender, senderFrame, patch, userActivated) {
        const tab = this.resolveMiniAppSenderTab(sender, senderFrame);
        if (!tab)
            return { success: false, code: 'not_found' };
        return updateMiniAppWindow(tab, patch, { userActivated, host: this.miniAppWindowHost() });
    }
    /** `window.mcode.miniapp.window.focus()` for the calling page. */
    focusMiniAppWindow(sender, senderFrame, userActivated) {
        const tab = this.resolveMiniAppSenderTab(sender, senderFrame);
        if (!tab)
            return { success: false, code: 'not_found' };
        return focusMiniAppWindow(tab, { userActivated, host: this.miniAppWindowHost() });
    }
    miniAppWindowHost() {
        const target = (tab) => {
            const pluginId = tab.miniApp?.miniApp.pluginId;
            if (typeof tab.sessionId !== 'string' || !pluginId)
                throw miniAppTabNotFoundError();
            return { sessionId: tab.sessionId, pluginId };
        };
        return {
            detach: async (tab, initialSize, userActivated) => {
                await this.detachMiniAppTab({ ...target(tab), initialSize, userActivated });
            },
            attach: async (tab) => {
                await this.attachMiniAppTab(target(tab));
            },
            selectInline: (tab) => {
                const host = this.getHostWindow();
                if (host && !host.isDestroyed())
                    host.focus();
                this.markTabSelected(tab);
            },
        };
    }
    destroyMiniAppTabs(pluginId) {
        this.revokeMiniAppTargetOperations(pluginId);
        const tabs = Array.from(this.tabs.values()).filter((tab) => tab.miniApp?.miniApp.pluginId === pluginId);
        for (const tab of tabs)
            this.destroyTab(tab, 'explicit');
        return tabs.map((tab) => tab.tabId);
    }
    resolveMiniAppTabBySession(sessionId, pluginId) {
        return (Array.from(this.tabs.values()).find((candidate) => candidate.sessionId === sessionId && candidate.miniApp?.miniApp.pluginId === pluginId) ?? null);
    }
    isUncommittedMiniAppTab(tab) {
        return Boolean(tab.miniApp && this.creatingTabs.has(tab.tabId));
    }
    async runMiniAppTargetOperation(input, operation) {
        if (!input.sessionId || !input.pluginId) {
            throw Object.assign(new Error('Mini App operation requires a session and plugin'), {
                code: 'not_found',
            });
        }
        const key = miniAppTargetKey(input.sessionId, input.pluginId);
        const epoch = this.miniAppOperationEpochs.get(key) ?? 0;
        const controller = new AbortController();
        const bucket = this.miniAppOperationControllers.get(key) ?? {
            sessionId: input.sessionId,
            pluginId: input.pluginId,
            controllers: new Set(),
        };
        bucket.controllers.add(controller);
        this.miniAppOperationControllers.set(key, bucket);
        const previous = this.miniAppOperationTails.get(key);
        const result = (previous ?? Promise.resolve()).then(async () => {
            input.signal?.throwIfAborted();
            controller.signal.throwIfAborted();
            assertMiniAppGenerationCurrent(input.isGenerationCurrent);
            this.assertMiniAppTargetEpochCurrent(key, epoch);
            try {
                const value = await operation(controller.signal);
                assertMiniAppGenerationCurrent(input.isGenerationCurrent);
                this.assertMiniAppTargetEpochCurrent(key, epoch);
                return value;
            }
            catch (error) {
                // Preserve the stronger Utility-generation error when both revocation
                // sources race. Otherwise a stopped/replaced target must fail closed.
                assertMiniAppGenerationCurrent(input.isGenerationCurrent);
                this.assertMiniAppTargetEpochCurrent(key, epoch);
                throw error;
            }
        });
        const tail = result.then(() => undefined, () => undefined);
        this.miniAppOperationTails.set(key, tail);
        try {
            return await result;
        }
        finally {
            bucket.controllers.delete(controller);
            if (bucket.controllers.size === 0 && this.miniAppOperationControllers.get(key) === bucket) {
                this.miniAppOperationControllers.delete(key);
            }
            if (this.miniAppOperationTails.get(key) === tail)
                this.miniAppOperationTails.delete(key);
        }
    }
    assertMiniAppTargetEpochCurrent(key, expectedEpoch) {
        if ((this.miniAppOperationEpochs.get(key) ?? 0) !== expectedEpoch) {
            throw Object.assign(new Error('Mini App surface changed during operation'), {
                code: 'stale_surface',
            });
        }
    }
    revokeMiniAppTargetOperations(pluginId, sessionId) {
        const entries = Array.from(this.miniAppOperationControllers.entries()).filter(([, value]) => (pluginId === undefined || value.pluginId === pluginId) &&
            (sessionId === undefined || value.sessionId === sessionId));
        for (const [key, value] of entries) {
            this.miniAppOperationEpochs.set(key, (this.miniAppOperationEpochs.get(key) ?? 0) + 1);
            this.miniAppOperationTails.delete(key);
            const reason = Object.assign(new Error('Mini App surface was stopped'), {
                code: 'stale_surface',
            });
            for (const controller of value.controllers)
                controller.abort(reason);
        }
    }
    /** Revokes every native tab owned by the current Utility generation. */
    destroyAllMiniAppTabs() {
        this.revokeMiniAppTargetOperations();
        const tabs = Array.from(this.tabs.values()).filter((tab) => tab.miniApp !== undefined);
        for (const tab of tabs)
            this.destroyTab(tab, 'explicit');
        return tabs.map((tab) => tab.tabId);
    }
    /**
     * Rotates the loopback credential of every tab of one plugin that still points at the
     * credential's origin, in any session. Launch identity (`runId`, URL) is left unchanged so
     * a later open still navigates a page loaded against an older run.
     */
    syncMiniAppLoopbackCredential(pluginId, credential) {
        for (const tab of this.tabs.values()) {
            const miniApp = tab.miniApp;
            if (miniApp?.miniApp.pluginId !== pluginId || miniApp.origin !== credential.origin)
                continue;
            if (miniApp.loopbackToken === credential.loopbackToken)
                continue;
            tab.miniApp = { ...miniApp, loopbackToken: credential.loopbackToken };
            this.syncMiniAppLoopbackAuth(tab);
        }
    }
    /** Keeps the WebContents-keyed loopback credential in step with the tab's current launch. */
    syncMiniAppLoopbackAuth(tab) {
        this.revokeMiniAppLoopbackAuth(tab);
        const miniApp = tab.miniApp;
        const contents = miniApp ? this.getWebContents(tab) : null;
        if (!miniApp || !contents)
            return;
        const session = contents.session;
        if (session && !this.miniAppLoopbackAuthSessions.has(session)) {
            registerMiniAppLoopbackAuth(session, this.miniAppLoopbackAuth);
            this.miniAppLoopbackAuthSessions.add(session);
        }
        if (session && !this.miniAppDevicePermissionSessions.has(session)) {
            this.miniAppDevicePermissions.register(session);
            this.miniAppDevicePermissionSessions.add(session);
        }
        this.miniAppLoopbackAuth.set(contents.id, {
            tabId: tab.tabId,
            origin: miniApp.origin,
            token: miniApp.loopbackToken,
        });
    }
    revokeMiniAppLoopbackAuth(tab) {
        for (const [webContentsId, entry] of this.miniAppLoopbackAuth) {
            if (entry.tabId === tab.tabId)
                this.miniAppLoopbackAuth.delete(webContentsId);
        }
    }
    async openMiniAppTabOnce(input, sessionId, revocationSignal) {
        const { url, runId } = input;
        const origin = new URL(url).origin;
        // Read the credential once this operation is actually dequeued, not when open was
        // requested, mirroring refreshMiniAppTab. A launch that no longer matches the run
        // currently serving the plugin must not write its token into any tab.
        const current = await input.readCredential?.();
        if (current && (current.runId !== runId || current.origin !== origin)) {
            throw Object.assign(new Error('Mini App launch is stale'), { code: 'stale_launch' });
        }
        const loopbackToken = current ? current.loopbackToken : input.loopbackToken;
        // Tabs of the same plugin in other sessions share the origin's current credential.
        this.syncMiniAppLoopbackCredential(input.miniApp.pluginId, { origin, loopbackToken });
        const existing = Array.from(this.tabs.values()).find((tab) => tab.sessionId === sessionId && tab.miniApp?.miniApp.pluginId === input.miniApp.pluginId);
        if (existing) {
            input.signal?.throwIfAborted();
            assertMiniAppGenerationCurrent(input.isGenerationCurrent);
            const launchChanged = existing.miniApp?.runId !== runId ||
                (input.preserveCurrentUrl ? urlHost(existing.url) !== urlHost(url) : existing.url !== url);
            const previousMiniApp = existing.miniApp;
            const previousLastLoadError = existing.lastLoadError;
            existing.miniApp = {
                miniApp: input.miniApp,
                runId,
                origin,
                loopbackToken,
                // The page's WebContents (and the argv carrying this id) is reused.
                surfaceId: previousMiniApp?.surfaceId ?? randomUUID(),
                ...(input.window ? { window: input.window } : {}),
            };
            this.syncMiniAppLoopbackAuth(existing);
            existing.lastLoadError = null;
            if (launchChanged) {
                try {
                    const result = await this.withTabOperation(existing, 'miniapp-restart', (operationSignal) => existing.controller.navigate({ url }, miniAppNavigationOptions(input.signal, operationSignal)), { signal: revocationSignal });
                    assertMiniAppNavigationSucceeded(result);
                    assertMiniAppGenerationCurrent(input.isGenerationCurrent);
                    this.refreshTabState(existing);
                }
                catch (error) {
                    // Roll back the launch identity only. When the failed relaunch kept the origin, another
                    // session may have rotated that origin's credential meanwhile; the newest token survives.
                    const attempted = existing.miniApp;
                    existing.miniApp =
                        previousMiniApp &&
                            attempted?.origin === previousMiniApp.origin &&
                            attempted.loopbackToken !== previousMiniApp.loopbackToken
                            ? { ...previousMiniApp, loopbackToken: attempted.loopbackToken }
                            : previousMiniApp;
                    this.syncMiniAppLoopbackAuth(existing);
                    existing.lastLoadError = previousLastLoadError;
                    throw error;
                }
            }
            assertMiniAppGenerationCurrent(input.isGenerationCurrent);
            this.markTabSessionSelected(existing);
            // An `open` of an already-detached Mini App is a request to see it.
            const detachedWindow = existing.detachedWindow;
            if (detachedWindow && !detachedWindow.isDestroyed())
                revealMiniAppWindow(detachedWindow);
            return this.miniAppTabSummary(existing);
        }
        const tab = await this.openTab({
            url,
            active: false,
            bounds: OFFSCREEN_BOUNDS,
            sessionId,
            miniApp: {
                miniApp: input.miniApp,
                runId,
                origin,
                loopbackToken,
                surfaceId: randomUUID(),
                ...(input.window ? { window: input.window } : {}),
            },
            ...(input.signal ? { signal: input.signal } : {}),
            operationSignal: revocationSignal,
        });
        try {
            assertMiniAppGenerationCurrent(input.isGenerationCurrent);
            this.markTabSessionSelected(tab);
        }
        catch (error) {
            if (this.tabs.has(tab.tabId)) {
                this.destroyTab(tab, 'explicit', { revokeMiniAppOperation: false });
            }
            throw error;
        }
        return this.miniAppTabSummary(tab);
    }
    async createOrShow(bounds, sessionId, options) {
        const normalizedSessionId = sessionId ?? null;
        const visible = options?.visible !== false;
        const revealAllowed = visible && !this.hasBlockingNativeOverlay();
        const existingSessionTab = this.resolveTabBySession(normalizedSessionId);
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserLifecycle] restore-request',
            sessionId: normalizedSessionId,
            restoreOnly: options?.restoreOnly === true,
            hasInitialUrl: Boolean(options?.initialUrl),
            existingTabId: existingSessionTab?.tabId ?? null,
            pendingCreation: this.ensuringSessionTabs.has(normalizedSessionId),
            sessionTabIds: typeof normalizedSessionId === 'string'
                ? (this.sessions.get(normalizedSessionId)?.tabIds ?? [])
                : [],
            selectedTabId: typeof normalizedSessionId === 'string'
                ? (this.sessions.get(normalizedSessionId)?.selectedTabId ?? null)
                : null,
            persistedTabId: typeof normalizedSessionId === 'string'
                ? (this.registry.getSelectedTab(normalizedSessionId)?.persistentTabId ?? null)
                : null,
        });
        // External links create their own tab after restoration; an empty session
        // must not acquire an unrelated blank tab as a side effect of mounting.
        if (options?.restoreOnly &&
            !existingSessionTab &&
            !this.ensuringSessionTabs.has(normalizedSessionId) &&
            !(typeof normalizedSessionId === 'string' &&
                (this.sessions
                    .get(normalizedSessionId)
                    ?.tabIds.some((tabId) => tabId === this.sessions.get(normalizedSessionId)?.selectedTabId &&
                    this.suspendedTabs.get(tabId)?.sessionId === normalizedSessionId) ||
                    this.registry.getSelectedTab(normalizedSessionId)))) {
            return this.getState({ sessionId: normalizedSessionId });
        }
        const normalizedBounds = this.normalizeBounds(bounds, options?.viewport, options?.layoutContext);
        const initialUrl = normalizePersistedBrowserUrl(options?.initialUrl);
        // Page execution and FilePanel presentation are independent. Hidden
        // restoration is rendered through BackgroundBrowserRenderHost instead of
        // briefly attaching the tab to the user's foreground window. When another
        // tab is already visible, keep a cold target offscreen through its
        // presentation load and leave it non-selected until the staged handoff
        // commits both native visibility and routing state.
        const hasVisiblePredecessor = !existingSessionTab && Array.from(this.tabs.values()).some(isShownInPanel);
        const restoreBounds = revealAllowed && !hasVisiblePredecessor ? normalizedBounds : OFFSCREEN_BOUNDS;
        const tab = await this.ensureTabForSession(restoreBounds, normalizedSessionId, initialUrl && initialUrl !== 'about:blank' ? initialUrl : undefined, 'presentation', !hasVisiblePredecessor);
        const shouldShowNativeView = revealAllowed;
        if (shouldShowNativeView) {
            await this.backgroundRenderHost.claimForeground(tab.controller);
        }
        else {
            await this.backgroundRenderHost.waitForTarget(tab.controller);
        }
        if (shouldShowNativeView) {
            // Existing hidden tabs need to be attached before an explicit navigation;
            // newly restored tabs were already created with real viewport bounds.
            const committed = await this.showTabExclusive(tab, normalizedBounds);
            if (!committed && this.hasBlockingNativeOverlay()) {
                this.markTabSessionSelected(tab);
                return { ...this.tabSummary(tab), deferred: 'blocking-overlay' };
            }
        }
        else if (!existingSessionTab || existingSessionTab.tabId !== tab.tabId) {
            tab.controller.setBounds(OFFSCREEN_BOUNDS);
            tab.bounds = OFFSCREEN_BOUNDS;
            this.markTabHidden(tab);
        }
        if (initialUrl && initialUrl !== 'about:blank' && existingSessionTab?.tabId === tab.tabId) {
            // A newly restored tab already attempted the explicit entry URL inside
            // openTab. Existing tabs re-read it because the same URL can represent
            // updated local content, but a failed cold load must not be retried here.
            tab.lastLoadError = null;
            const result = await this.withTabOperation(tab, tab.url === initialUrl ? 'initial-reload' : 'initial-navigate', () => tab.controller.loadForPresentation({ url: initialUrl }));
            tab.lastLoadError = presentationLoadError(tab.lastLoadError, result, initialUrl);
            this.refreshTabState(tab);
        }
        tab.sessionId = normalizedSessionId;
        // Hidden restore completion must not undo a newer foreground/blank-tab selection.
        if (visible)
            this.markTabSelected(tab);
        return {
            ...this.tabSummary(tab),
            ...(visible && !revealAllowed ? { deferred: 'blocking-overlay' } : {}),
        };
    }
    hasBlockingNativeOverlay() {
        return this.nativeOverlayOcclusionLeases.size > 0;
    }
    async setNativeOverlayOcclusion(leaseId, active, policy = 'blocking') {
        if (policy === 'resize') {
            if (active)
                this.nativeResizeLeases.add(leaseId);
            else
                this.nativeResizeLeases.delete(leaseId);
            return { success: true };
        }
        if (active)
            this.nativeOverlayOcclusionLeases.add(leaseId);
        else
            this.nativeOverlayOcclusionLeases.delete(leaseId);
        if (active) {
            const visibleTabs = Array.from(this.tabs.values()).filter((tab) => !tab.detachedWindow && tab.bounds.x >= 0 && tab.bounds.y >= 0);
            await Promise.all(visibleTabs.map(async (tab) => {
                tab.lastForegroundBounds = tab.bounds;
                await tab.controller.setBounds(OFFSCREEN_BOUNDS);
                tab.bounds = OFFSCREEN_BOUNDS;
                this.markTabHidden(tab);
            }));
        }
        return {
            success: true,
            active: this.hasBlockingNativeOverlay(),
            leaseCount: this.nativeOverlayOcclusionLeases.size,
        };
    }
    async setBounds(bounds, sessionId, _viewport, target, layoutOptions) {
        // Session-keyed like hide(): position the calling session's own tab rather
        // than whichever tab happens to be active, so a setBounds from session A can
        // never reposition session B's view. Falls back to the active tab when no
        // sessionId is supplied (resolveTabBySession returns null for undefined).
        let tab;
        try {
            tab = await this.requireBrowserTab({
                ...(target ?? {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
            }, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (tab.detachedWindow) {
            return showDetachedPlaceholder(this.detachedWindowHost, tab, this.normalizeBounds(bounds, _viewport, layoutOptions?.layoutContext));
        }
        if (this.hasBlockingNativeOverlay()) {
            const normalizedBounds = this.normalizeBounds(bounds, _viewport, layoutOptions?.layoutContext);
            tab.lastForegroundBounds = normalizedBounds;
            if (tab.bounds.x >= 0 && tab.bounds.y >= 0) {
                await tab.controller.setBounds(OFFSCREEN_BOUNDS);
                tab.bounds = OFFSCREEN_BOUNDS;
                this.markTabHidden(tab);
            }
            return { success: true, tabId: tab.tabId, deferred: 'blocking-overlay' };
        }
        if (tab.hiddenAt != null || tab.bounds.x < 0 || tab.bounds.y < 0) {
            return { success: true, tabId: tab.tabId, ignored: 'hidden-tab' };
        }
        // Geometry cannot reveal a hidden native view. Ignore it without advancing
        // the visibility command watermark: a show() may currently be waiting for
        // an in-flight background action and must remain authoritative.
        if (!this.claimLayoutCommand(tab, layoutOptions?.layoutCommandId)) {
            return { success: true, tabId: tab.tabId, ignored: 'stale-layout-command' };
        }
        const normalizedBounds = this.normalizeBounds(bounds, _viewport, layoutOptions?.layoutContext);
        const webContents = this.getWebContents(tab);
        const focusedBefore = webContents && typeof webContents.isFocused === 'function' ? webContents.isFocused() : null;
        const nativePreviewLayout = this.toNativePreviewLayout(layoutOptions?.previewLayout, layoutOptions?.layoutContext);
        if (nativePreviewLayout === undefined)
            await tab.controller.setBounds(normalizedBounds);
        else
            await tab.controller.setBounds(normalizedBounds, nativePreviewLayout);
        // A blocking overlay can acquire its lease while the native bounds write
        // is in flight. Recheck after the await so a late real-bounds completion
        // cannot undo the overlay's earlier offscreen write.
        if (this.hasBlockingNativeOverlay()) {
            await tab.controller.setBounds(OFFSCREEN_BOUNDS);
            tab.bounds = OFFSCREEN_BOUNDS;
            tab.lastForegroundBounds = normalizedBounds;
            this.markTabHidden(tab);
            return { success: true, tabId: tab.tabId, deferred: 'blocking-overlay' };
        }
        tab.bounds = normalizedBounds;
        tab.lastForegroundBounds = normalizedBounds;
        const focusedAfter = webContents && typeof webContents.isFocused === 'function' ? webContents.isFocused() : null;
        this.logNativeLayerDiagnostic(tab, focusedAfter, layoutOptions?.layoutContext?.hostWebContentsId);
        if (tab.commentModeEnabled) {
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserInput] bounds-sync',
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                pageHost: urlHost(tab.url),
                focusedBefore,
                focusedAfter,
                bounds: normalizedBounds,
            });
        }
        this.logBoundsDiagnostic(tab, bounds, _viewport, normalizedBounds, layoutOptions?.layoutContext);
        return { success: true, tabId: tab.tabId };
    }
    async setDevicePreviewMode(mode, target) {
        let tab;
        try {
            tab = await this.requireBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        return withDevicePreviewLease(tab, async () => {
            await tab.controller.hideAgentCursor?.();
            return setTabDevicePreviewMode(tab, mode);
        });
    }
    async updateDevicePreview(request, target) {
        let tab;
        try {
            tab = await this.requireBrowserTab(target);
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (tab.miniApp || tab.detachedWindow)
            return { success: false, error: 'Device preview is only available for browser tabs' };
        return this.withTabOperation(tab, 'device-preview', () => withDevicePreviewLease(tab, async () => {
            await tab.controller.hideAgentCursor();
            return updateTabDevicePreview(tab, request);
        }),
        // Applying emulation changes page state without needing a compositor slot.
        // Closing the picker reveals the page and cancels background render leases;
        // keep this transaction alive until its actual result (including rollback).
        { requiresBackgroundRender: false });
    }
    async show(bounds, target, viewport, layoutContext, layoutCommandId, previewLayout) {
        const normalizedTarget = normalizeBrowserTarget(target);
        const requestedTabId = normalizedTarget.tabId;
        if (!this.claimShowLayoutCommand(layoutCommandId)) {
            return {
                success: true,
                ...(typeof requestedTabId === 'number' ? { tabId: requestedTabId } : {}),
                ignored: 'stale-layout-command',
            };
        }
        let tab;
        try {
            tab = this.resolveBrowserTab(normalizedTarget, { allowLegacyActive: true });
            if (!tab && typeof requestedTabId === 'number') {
                tab = await this.resumeSuspendedTab(requestedTabId, normalizedTarget.sessionId);
            }
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        if (tab.detachedWindow) {
            return showDetachedPlaceholder(this.detachedWindowHost, tab, this.normalizeBounds(bounds, viewport, layoutContext));
        }
        if (!this.isLatestShowLayoutCommand(layoutCommandId)) {
            return { success: true, tabId: tab.tabId, ignored: 'stale-layout-command' };
        }
        if (!this.claimLayoutCommand(tab, layoutCommandId)) {
            return { success: true, tabId: tab.tabId, ignored: 'stale-layout-command' };
        }
        const normalizedBounds = this.normalizeBounds(bounds, viewport, layoutContext);
        tab.lastForegroundBounds = normalizedBounds;
        if (this.hasBlockingNativeOverlay()) {
            this.markTabSessionSelected(tab);
            if (tab.bounds.x >= 0 && tab.bounds.y >= 0) {
                await tab.controller.setBounds(OFFSCREEN_BOUNDS);
                tab.bounds = OFFSCREEN_BOUNDS;
                this.markTabHidden(tab);
            }
            return { success: true, tabId: tab.tabId, deferred: 'blocking-overlay' };
        }
        await this.backgroundRenderHost.claimForeground(tab.controller);
        // A failed creation or a close can destroy the target while foreground
        // acquisition awaits. Never reattach that stale tab to its session.
        if (this.tabs.get(tab.tabId) !== tab) {
            return { success: false, tabId: tab.tabId, error: 'Browser tab was closed' };
        }
        // A newer hide/show command can arrive while an in-flight background
        // action drains. Recheck before attaching the native view.
        if (!this.claimLayoutCommand(tab, layoutCommandId) ||
            !this.isLatestShowLayoutCommand(layoutCommandId)) {
            return { success: true, tabId: tab.tabId, ignored: 'stale-layout-command' };
        }
        const committed = await this.showTabExclusive(tab, normalizedBounds, {
            bringToFront: true,
            previewLayout: this.toNativePreviewLayout(previewLayout, layoutContext),
            shouldCommit: () => this.claimLayoutCommand(tab, layoutCommandId) &&
                this.isLatestShowLayoutCommand(layoutCommandId),
        });
        if (!committed) {
            if (tab.detachedWindow) {
                return { success: true, tabId: tab.tabId, ignored: 'detached-window' };
            }
            return this.hasBlockingNativeOverlay()
                ? { success: true, tabId: tab.tabId, deferred: 'blocking-overlay' }
                : { success: true, tabId: tab.tabId, ignored: 'stale-layout-command' };
        }
        this.logNativeLayerDiagnostic(tab, this.getWebContents(tab)?.isFocused?.() ?? null, layoutContext?.hostWebContentsId);
        this.logBoundsDiagnostic(tab, bounds, viewport, normalizedBounds, layoutContext);
        return { success: true, tabId: tab.tabId };
    }
    hide(params, layoutCommandId) {
        let tab;
        try {
            tab = this.resolveBrowserTab(params, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (params?.select === true) {
            if (!this.claimShowLayoutCommand(layoutCommandId))
                return { success: true, ignored: 'stale-layout-command' };
            if (tab)
                this.markTabSelected(tab);
            else if (typeof params.tabId === 'number') {
                const suspended = this.suspendedTabs.get(params.tabId);
                if (!suspended ||
                    (typeof params.sessionId === 'string' && suspended.sessionId !== params.sessionId)) {
                    return { success: false, error: 'No embedded tab is available' };
                }
                const session = this.sessions.get(suspended.sessionId);
                if (session)
                    session.selectedTabId = suspended.tabId;
                this.registry.selectTab(suspended.sessionId, suspended.persistentTabId);
            }
        }
        if (!tab)
            return { success: true };
        if (tab.detachedWindow)
            return hideDetachedPlaceholder(tab);
        if (!this.claimLayoutCommand(tab, layoutCommandId)) {
            return { success: true, tabId: tab.tabId, ignored: 'stale-layout-command' };
        }
        tab.controller.setBounds(OFFSCREEN_BOUNDS);
        tab.bounds = OFFSCREEN_BOUNDS;
        this.markTabHidden(tab);
        return { success: true, tabId: tab.tabId };
    }
    destroy(params) {
        const normalized = typeof params === 'number' ? { tabId: params } : (params ?? {});
        let targetIds;
        let suspendedTargetIds = [];
        try {
            if (typeof normalized.tabId === 'number') {
                const creation = this.creatingTabs.get(normalized.tabId);
                if (creation &&
                    typeof normalized.sessionId === 'string' &&
                    creation.sessionId !== normalized.sessionId) {
                    throw new Error(`Embedded browser tab ${normalized.tabId} does not belong to session ${normalized.sessionId}`);
                }
                const tab = this.resolveBrowserTab(normalized, { allowLegacyActive: true });
                targetIds = tab ? [tab.tabId] : [];
                const suspended = this.suspendedTabs.get(normalized.tabId);
                if (suspended) {
                    if (typeof normalized.sessionId === 'string' &&
                        suspended.sessionId !== normalized.sessionId) {
                        throw new Error(`Embedded browser tab ${normalized.tabId} does not belong to session ${normalized.sessionId}`);
                    }
                    suspendedTargetIds = [suspended.tabId];
                }
            }
            else if (normalized.sessionId !== undefined) {
                targetIds = Array.from(this.tabs.values())
                    .filter((tab) => tab.sessionId === normalized.sessionId)
                    .map((tab) => tab.tabId);
                suspendedTargetIds = Array.from(this.suspendedTabs.values())
                    .filter((tab) => tab.sessionId === normalized.sessionId)
                    .map((tab) => tab.tabId);
            }
            else {
                targetIds = [this.activeTabId].filter((id) => id !== null);
            }
        }
        catch (error) {
            return { success: false, error: safeError(error), tabIds: [] };
        }
        const targetSessionId = normalized.sessionId !== undefined
            ? normalized.sessionId
            : (this.tabs.get(targetIds[0] ?? -1)?.sessionId ??
                this.suspendedTabs.get(suspendedTargetIds[0] ?? -1)?.sessionId);
        for (const [tabId, creation] of this.creatingTabs) {
            if (typeof normalized.tabId === 'number'
                ? tabId === normalized.tabId
                : normalized.sessionId !== undefined
                    ? creation.sessionId === normalized.sessionId
                    : tabId === this.activeTabId) {
                creation.cancelled = true;
            }
        }
        if (normalized.sessionId !== undefined && normalized.tabId === undefined) {
            this.ensuringSessionTabs.delete(normalized.sessionId);
        }
        for (const targetId of targetIds) {
            const tab = this.tabs.get(targetId);
            if (tab)
                this.destroyTab(tab, 'explicit');
        }
        for (const targetId of suspendedTargetIds) {
            const tab = this.suspendedTabs.get(targetId);
            if (tab)
                this.destroySuspendedTab(tab, 'explicit');
        }
        const remainingTabs = [...this.tabs.values(), ...this.suspendedTabs.values()].filter((tab) => tab.sessionId === targetSessionId);
        const hasPendingTabs = [...this.creatingTabs.values()].some((creation) => creation.sessionId === targetSessionId && !creation.cancelled);
        const sessionClosed = targetSessionId !== undefined && remainingTabs.length === 0 && !hasPendingTabs;
        if (typeof targetSessionId === 'string' && sessionClosed) {
            this.ensuringSessionTabs.delete(targetSessionId);
            this.registry.removeSession(targetSessionId);
            const prefix = `${targetSessionId}\u0000`;
            for (const key of this.coldResumeSnapshots.keys()) {
                if (key.startsWith(prefix))
                    this.coldResumeSnapshots.delete(key);
            }
        }
        this.registry.flush();
        return {
            success: true,
            tabIds: [...targetIds, ...suspendedTargetIds],
            sessionClosed,
            ...(targetSessionId === undefined
                ? {}
                : { state: this.getState({ sessionId: targetSessionId }) }),
        };
    }
    destroySuspendedTab(tab, reason) {
        this.suspendedTabs.delete(tab.tabId);
        this.coldResumeSnapshots.delete(this.coldResumeKey(tab));
        const session = this.sessions.get(tab.sessionId);
        if (session) {
            session.tabIds = session.tabIds.filter((tabId) => tabId !== tab.tabId);
            if (session.selectedTabId === tab.tabId)
                session.selectedTabId = session.tabIds[0] ?? null;
            if (session.visibleTabId === tab.tabId)
                session.visibleTabId = null;
            session.updatedAt = nowMs();
            if (session.tabIds.length === 0)
                this.sessions.delete(tab.sessionId);
        }
        if (reason === 'explicit')
            this.registry.removeTab(tab.sessionId, tab.persistentTabId);
    }
    destroyTab(tab, reason = 'explicit', options = {}) {
        if (this.destroyingTabIds.has(tab.tabId))
            return;
        this.destroyingTabIds.add(tab.tabId);
        this.revokeMiniAppLoopbackAuth(tab);
        if (options.revokeMiniAppOperation !== false &&
            tab.miniApp &&
            typeof tab.sessionId === 'string') {
            this.revokeMiniAppTargetOperations(tab.miniApp.miniApp.pluginId, tab.sessionId);
        }
        this.browserResourceDiagnostics.onTabDestroying();
        if (reason === 'explicit')
            this.deleteColdResumeSnapshot(tab);
        else if (typeof tab.sessionId === 'string' && typeof tab.persistentTabId === 'string') {
            const key = this.coldResumeKey(tab);
            if (!this.coldResumeSnapshots.has(key)) {
                this.coldResumeSnapshots.set(key, {
                    navigationHistory: this.captureNavigationSnapshot(tab),
                    pageResume: null,
                });
            }
        }
        this.clearTabOverlayBeforeDestroy(tab, reason);
        this.clearAgentKeepaliveTimer(tab);
        this.navigationDiagnostics.delete(tab.tabId);
        this.logTabLifecycle('destroyed', tab, { reason });
        for (const dispose of tab.disposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Ignore listener cleanup races during WebContents teardown.
            }
        }
        try {
            tab.controller.destroy();
            this.tabs.delete(tab.tabId);
            if (options.preserveLogicalTab) {
                if (typeof tab.sessionId === 'string') {
                    const session = this.sessions.get(tab.sessionId);
                    if (session?.visibleTabId === tab.tabId)
                        session.visibleTabId = null;
                }
            }
            else {
                this.detachTabFromSession(tab);
            }
            if (reason === 'explicit' &&
                typeof tab.sessionId === 'string' &&
                typeof tab.persistentTabId === 'string') {
                this.registry.removeTab(tab.sessionId, tab.persistentTabId);
            }
            if (this.activeTabId === tab.tabId) {
                this.activeTabId =
                    Array.from(this.tabs.values()).find((candidate) => !this.isUncommittedMiniAppTab(candidate))?.tabId ?? null;
            }
        }
        finally {
            // Even when controller teardown throws, the window must not outlive its tab.
            closeDetachedWindow(tab);
            this.destroyingTabIds.delete(tab.tabId);
        }
        this.stopHiddenSweepTimerIfIdle();
        this.browserResourceDiagnostics.onTabDestroyed();
    }
    destroyAllTabs() {
        this.revokeMiniAppTargetOperations();
        for (const creation of this.creatingTabs.values())
            creation.cancelled = true;
        this.ensuringSessionTabs.clear();
        for (const tab of Array.from(this.tabs.values())) {
            this.destroyTab(tab, 'host-teardown');
        }
        this.suspendedTabs.clear();
        this.resumingTabs.clear();
        this.activeTabId = null;
        this.sessions.clear();
        this.registry.flush();
        this.stopHiddenSweepTimerIfIdle();
    }
    clearTabOverlayBeforeDestroy(tab, reason) {
        tab.commentModeEnabled = false;
        if (tab.commentEvents.length > 0) {
            this.logCommentEventsCleared(tab, `destroy:${reason}`, tab.commentEvents.length);
            tab.commentEvents = [];
        }
        const wc = this.getWebContents(tab);
        if (!wc || wc.isDestroyed())
            return;
        void this.installCommentBridge(tab)
            .then(() => Promise.all([
            this.postCommentBridgeMessage(tab, { type: 'set-enabled', enabled: false }),
            this.postCommentBridgeMessage(tab, { type: 'clear-comments' }),
        ]))
            .catch((error) => {
            logger.warn(`[EmbeddedBrowser] overlay clear before destroy failed: ${safeError(error)}`);
        });
    }
    getState(params) {
        const startedAt = nowMs();
        const hasRequestedSession = params && Object.prototype.hasOwnProperty.call(params, 'sessionId');
        let tab;
        try {
            tab = this.resolveBrowserTab(params, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error), activeTabId: null, tabs: [] };
        }
        if (tab && this.isUncommittedMiniAppTab(tab))
            tab = null;
        const afterEventId = typeof params?.afterEventId === 'number' ? params.afterEventId : 0;
        const commentEvents = tab
            ? tab.commentEvents.filter((event) => event.eventId > afterEventId)
            : [];
        const requestedSessionId = typeof params?.sessionId === 'string'
            ? params.sessionId
            : typeof tab?.sessionId === 'string'
                ? tab.sessionId
                : undefined;
        const sessionState = requestedSessionId ? this.sessions.get(requestedSessionId) : undefined;
        const liveTabs = Array.from(this.tabs.values()).filter((item) => {
            if (this.isUncommittedMiniAppTab(item))
                return false;
            if (!hasRequestedSession)
                return true;
            return item.sessionId === params?.sessionId;
        });
        const suspendedTabs = Array.from(this.suspendedTabs.values()).filter((item) => {
            if (!hasRequestedSession)
                return true;
            return item.sessionId === params?.sessionId;
        });
        const liveById = new Map(liveTabs.map((item) => [item.tabId, item]));
        const suspendedById = new Map(suspendedTabs.map((item) => [item.tabId, item]));
        const orderedTabIds = sessionState?.tabIds ?? [
            ...liveTabs.map((item) => item.tabId),
            ...suspendedTabs.map((item) => item.tabId),
        ];
        this.logGetStateDiagnostic({
            requestedSessionId: hasRequestedSession ? params.sessionId : undefined,
            tab,
            commentEvents,
            durationMs: nowMs() - startedAt,
        });
        const stateTabs = orderedTabIds.flatMap((tabId) => {
            const live = liveById.get(tabId);
            if (live)
                return [this.tabSummary(live)];
            const suspended = suspendedById.get(tabId);
            return suspended ? [this.suspendedTabSummary(suspended)] : [];
        });
        const requestedSuspendedTab = typeof params?.tabId === 'number' ? this.suspendedTabs.get(params.tabId) : undefined;
        return {
            success: true,
            activeTabId: tab?.tabId ?? requestedSuspendedTab?.tabId ?? null,
            selectedTabId: sessionState?.selectedTabId ?? tab?.tabId ?? null,
            visibleTabId: typeof tab?.sessionId === 'string'
                ? (sessionState?.visibleTabId ?? null)
                : (tab?.tabId ?? null),
            tabs: stateTabs,
            annotationEnabled: tab?.commentModeEnabled ?? false,
            commentEvents,
            maxCommentEventId: tab
                ? tab.commentEvents.reduce((max, event) => Math.max(max, event.eventId), 0)
                : 0,
            zoomFactor: tab?.controller.getZoomFactor() ?? 1,
        };
    }
    /** Capture a frozen DOM backdrop above the native browser view. */
    async captureFrame(target) {
        return captureFrameWithoutAgentCursor({
            target,
            resolveTab: (nextTarget) => this.requireBrowserTab(nextTarget, { allowLegacyActive: true }),
            getWebContents: (tab) => this.getWebContents(tab),
            withTabOperation: (tab, label, operation) => this.withTabOperation(tab, label, operation),
            safeError: safeError,
        });
    }
    async goBack(target, signal) {
        const tab = await this.requireBrowserTab(target, {
            allowLegacyActive: true,
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        tab.lastLoadError = null;
        return this.withTabOperation(tab, 'go-back', () => tab.controller.goBack(), { signal });
    }
    async goForward(target, signal) {
        const tab = await this.requireBrowserTab(target, {
            allowLegacyActive: true,
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        tab.lastLoadError = null;
        return this.withTabOperation(tab, 'go-forward', () => tab.controller.goForward(), { signal });
    }
    async reload(target, signal) {
        const tab = await this.requireBrowserTab(target, {
            allowLegacyActive: true,
            createIfMissing: true,
            bounds: OFFSCREEN_BOUNDS,
        });
        tab.lastLoadError = null;
        return this.withTabOperation(tab, 'reload', () => tab.controller.reload(), { signal });
    }
    async forceReload(target) {
        let tab;
        try {
            tab = this.resolveBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        const wc = this.getWebContents(tab);
        if (!wc)
            return { success: false, error: 'WebContents not available' };
        tab.lastLoadError = null;
        wc.reloadIgnoringCache();
        return { success: true, tabId: tab.tabId };
    }
    async setZoom(factor, target) {
        let tab;
        try {
            tab = this.resolveBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        const nextFactor = Math.min(3, Math.max(0.25, factor));
        const result = await tab.controller.setZoomFactor(nextFactor);
        return {
            ...result,
            tabId: tab.tabId,
            zoomFactor: tab.controller.getZoomFactor(),
        };
    }
    async clearCookies(target) {
        let tab;
        try {
            tab = await this.requireBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        const wc = this.getWebContents(tab);
        if (!wc)
            return { success: false, error: 'WebContents not available' };
        await this.withTabOperation(tab, 'clear-cookies', () => wc.session.clearStorageData({ storages: ['cookies'] }));
        return { success: true, tabId: tab.tabId };
    }
    async clearCache(target) {
        let tab;
        try {
            tab = await this.requireBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        const wc = this.getWebContents(tab);
        if (!wc)
            return { success: false, error: 'WebContents not available' };
        await this.withTabOperation(tab, 'clear-cache', () => wc.session.clearCache());
        return { success: true, tabId: tab.tabId };
    }
    async setCommentMode(enabled, placeholder, options) {
        let tab;
        try {
            tab = this.resolveBrowserTab(options, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserInput] comment-mode-request',
            requestedTabId: options?.tabId ?? null,
            requestedSessionId: options?.sessionId ?? null,
            resolvedTabId: tab?.tabId ?? null,
            resolvedSessionId: tab?.sessionId ?? null,
            globalActiveTabId: this.activeTabId,
            enabled,
            targetAvailable: Boolean(tab),
            targetSuspended: typeof options?.tabId === 'number' ? this.suspendedTabs.has(options.tabId) : false,
        });
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        if (typeof placeholder === 'string' && placeholder.trim()) {
            tab.commentPlaceholder = placeholder;
        }
        if (options?.selectionMode) {
            tab.commentSelectionMode = normalizeCommentSelectionMode(options.selectionMode);
        }
        if (options?.theme) {
            tab.commentTheme = options.theme;
        }
        if (options?.palette) {
            tab.commentThemePalette = options.palette;
        }
        if (options?.strings)
            tab.commentStrings = options.strings;
        if (options?.locale)
            tab.commentLocale = options.locale;
        if (typeof options?.propsExpanded === 'boolean' && !this.propsPanelPreferenceKnown) {
            this.propsPanelExpanded = options.propsExpanded;
        }
        // Runtime defence in depth: the typed `commentKeys?: string[]` is
        // trusted, but a non-array runtime value must never silently turn
        // into a full clear. The shared helper fails closed: an explicit
        // malformed array is rejected with an error, while a missing field
        // keeps the legacy full-clear path.
        let selectiveKeys;
        if (options && 'commentKeys' in options) {
            const result = normalizeCommentKeys(options.commentKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            if (result.selective)
                selectiveKeys = result.keys;
        }
        const generation = tab.navigationGeneration ?? 0;
        await this.withTabOperation(tab, 'install-comment-bridge', () => this.installCommentBridge(tab));
        if (generation !== (tab.navigationGeneration ?? 0)) {
            return { success: false, error: 'Browser navigated before comment mode could be changed' };
        }
        if (options?.clearComments) {
            this.recordCommentClear(tab, selectiveKeys);
            // Selective path is taken whenever the host supplies `commentKeys`,
            // even if the list is empty. Only the absence of the field falls
            // back to the legacy full clear. The selective path filters out
            // only events about the listed keys, so a comment the user just
            // created or edited while a send was in flight survives untouched;
            // the legacy path drops the entire queue because the page has been
            // wiped.
            const selective = Array.isArray(options.commentKeys);
            if (selective && selectiveKeys && selectiveKeys.length > 0) {
                const clearedKeys = new Set(selectiveKeys);
                const before = tab.commentEvents.length;
                tab.commentEvents = tab.commentEvents.filter((event) => {
                    if (event.type === 'comment-added') {
                        const key = event.payload?.commentKey;
                        return !(typeof key === 'string' && clearedKeys.has(key));
                    }
                    if (event.type === 'comment-removed') {
                        return !(typeof event.commentKey === 'string' && clearedKeys.has(event.commentKey));
                    }
                    // `comments-renumbered` events apply to all survivors; keep
                    // them so the host's projection stays consistent.
                    return true;
                });
                this.logCommentEventsCleared(tab, 'set-comment-mode-selective', before - tab.commentEvents.length);
            }
            else if (!selective) {
                this.logCommentEventsCleared(tab, 'set-comment-mode', tab.commentEvents.length);
                tab.commentEvents = [];
            }
            else {
                // Explicit empty commentKeys is a no-op selective clear: the
                // queue and any in-flight events are preserved so the host's
                // projection stays consistent with the page.
                this.logCommentEventsCleared(tab, 'set-comment-mode-empty-selective', 0);
            }
            await this.withTabOperation(tab, 'clear-comment-overlay', () => this.postCommentBridgeMessage(tab, {
                type: 'clear-comments',
                ...(options.markSent ? { sent: true } : {}),
                ...(selective ? { commentKeys: selectiveKeys ?? [] } : {}),
            }));
        }
        tab.commentModeEnabled = enabled;
        await this.withTabOperation(tab, 'set-comment-mode', () => this.postCommentBridgeMessage(tab, {
            type: 'set-enabled',
            enabled,
            selectionMode: tab.commentSelectionMode ?? 'dom_node',
            theme: tab.commentTheme ?? 'system',
            ...(tab.commentThemePalette ? { palette: tab.commentThemePalette } : {}),
            ...(tab.commentPlaceholder ? { placeholder: tab.commentPlaceholder } : {}),
            ...(tab.commentStrings ? { strings: tab.commentStrings } : {}),
            ...(tab.commentLocale ? { locale: tab.commentLocale } : {}),
            propsExpanded: this.propsPanelExpanded,
        }));
        return {
            success: true,
            tabId: tab.tabId,
            annotationEnabled: enabled,
            propsExpanded: this.propsPanelExpanded,
        };
    }
    /** Relays the app's ASR state/transcript into the page composer. */
    async updateCommentVoice(update, target) {
        let tab;
        try {
            tab = this.resolveBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        await this.postCommentBridgeMessage(tab, {
            type: 'voice-update',
            state: update.state,
            ...(typeof update.text === 'string' ? { text: update.text } : {}),
        });
        return { success: true, tabId: tab.tabId };
    }
    /** The Agent turn that received the sent comments ended: settle their bubbles. */
    async resolveSentComments(status, target, options) {
        let tab;
        try {
            tab = this.resolveBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        // Runtime validation: a malformed key must never silently widen the
        // operation into a full resolve. The shared helper fails closed and
        // only a missing field opts into the legacy full resolve path.
        let selectiveKeys;
        if (options && 'commentKeys' in options) {
            const result = normalizeCommentKeys(options.commentKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            if (result.selective)
                selectiveKeys = result.keys;
        }
        let revisions;
        if (options && 'commentRevisions' in options) {
            const result = normalizeCommentRevisions(options.commentRevisions, selectiveKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            revisions = result.revisions;
        }
        const resolvedTab = tab;
        await this.withTabOperation(resolvedTab, 'resolve-sent-comments', () => this.postCommentBridgeMessage(resolvedTab, {
            type: 'resolve-sent',
            status,
            ...(selectiveKeys ? { commentKeys: selectiveKeys } : {}),
            ...(revisions ? { commentRevisions: revisions } : {}),
        }));
        return { success: true, tabId: resolvedTab.tabId };
    }
    /** The chat composer dropped one comment: remove it and roll back its preview. */
    async removeComment(comment, target) {
        let tab;
        try {
            tab = this.resolveBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        // Runtime validation: a malformed commentKey must not be forwarded
        // to the page where it could silently no-op (or, worse, be coerced
        // into a different key). The IPC layer already rejects bad input
        // at the boundary; this is defence in depth for direct callers.
        if ('commentKey' in comment) {
            if (typeof comment.commentKey !== 'string') {
                return { success: false, error: 'commentKey must be a string' };
            }
            if (comment.commentKey.length === 0 || comment.commentKey.length > 200) {
                return { success: false, error: 'commentKey must be a non-empty ≤200 char string' };
            }
            if (comment.commentKey !== comment.commentKey.trim()) {
                return { success: false, error: 'commentKey must not have surrounding whitespace' };
            }
        }
        const resolvedTab = tab;
        await this.withTabOperation(resolvedTab, 'remove-comment', () => this.postCommentBridgeMessage(resolvedTab, { type: 'remove-comment', ...comment }));
        return { success: true, tabId: resolvedTab.tabId };
    }
    /**
     * Clear comment overlay state without touching annotation intent.
     *
     * Three paths share this entry point:
     * 1. **Legacy full clear** (no `options`, or `options` with no
     *    `commentKeys` field): drops the whole event queue, posts a bare
     *    `clear-comments` to the page, and keeps the existing semantics
     *    that other code paths rely on.
     * 2. **Selective clear** (`options.commentKeys` is an array): the
     *    queue is filtered to the listed keys, the bridge gets a
     *    `clear-comments` with `commentKeys` plus an optional `sent` flag,
     *    and unrelated events (sibling comments, renumber rows) survive.
     *    An explicit empty array is a no-op on both sides.
     * 3. **Fail-closed malformed keys**: an explicit but malformed
     *    `commentKeys` returns `{ success: false, error }` without ever
     *    mutating state.
     *
     * Crucially, this method MUST NOT change `tab.commentModeEnabled`,
     * MUST NOT post a `set-enabled` message, and MUST NOT touch the
     * selection mode. The accepted-send path uses it to settle just the
     * sent bubbles while a sibling composer keeps its own draft — flipping
     * the mode to disabled here would destroy the sibling draft.
     */
    async clearComments(target, options) {
        let tab;
        try {
            tab = this.resolveBrowserTab(target, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        // Runtime defence in depth, shared with the IPC layer: a malformed
        // explicit array must never silently widen into a full clear.
        let selectiveKeys;
        let selective = null;
        if (options && 'commentKeys' in options) {
            const result = normalizeCommentKeys(options.commentKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            selective = result.selective;
            if (result.selective)
                selectiveKeys = result.keys;
        }
        let revisions;
        if (options && 'commentRevisions' in options) {
            const result = normalizeCommentRevisions(options.commentRevisions, selectiveKeys);
            if (!result.ok)
                return { success: false, error: result.error };
            revisions = result.revisions;
        }
        const generation = tab.navigationGeneration ?? 0;
        await this.withTabOperation(tab, 'install-comment-bridge', () => this.installCommentBridge(tab));
        if (generation !== (tab.navigationGeneration ?? 0)) {
            return { success: false, error: 'Browser navigated before comments could be cleared' };
        }
        if (selective === true && selectiveKeys && selectiveKeys.length > 0) {
            // Fence asynchronous screenshots and later IPC deliveries before changing either projection.
            // A newer saved revision remains editable on the page and can still enter the event queue.
            this.recordCommentClear(tab, selectiveKeys, revisions);
            const clearedKeys = new Set(selectiveKeys);
            const before = tab.commentEvents.length;
            tab.commentEvents = tab.commentEvents.filter((event) => {
                if (event.type === 'comment-added') {
                    return !event.payload || !this.isCommentRevisionCleared(tab, event.payload);
                }
                if (event.type === 'comment-removed') {
                    // A real page deletion can belong to a newer revision; keep it for versioned sends.
                    const key = event.commentKey;
                    return !(typeof key === 'string' &&
                        clearedKeys.has(key) &&
                        !(revisions && Object.prototype.hasOwnProperty.call(revisions, key)));
                }
                return true;
            });
            this.logCommentEventsCleared(tab, 'clear-comments-selective', before - tab.commentEvents.length);
            await this.withTabOperation(tab, 'clear-comment-overlay', () => this.postCommentBridgeMessage(tab, {
                type: 'clear-comments',
                ...(options?.markSent === true ? { sent: true } : {}),
                commentKeys: selectiveKeys,
                ...(revisions ? { commentRevisions: revisions } : {}),
            }));
        }
        else if (selective === true) {
            // Explicit empty commentKeys: the queue and the page are left
            // untouched so a sibling composer's in-flight edits are preserved.
            this.logCommentEventsCleared(tab, 'clear-comments-empty-selective', 0);
        }
        else {
            // Legacy full clear also invalidates messages admitted before this boundary.
            this.recordCommentClear(tab);
            this.logCommentEventsCleared(tab, 'clear-comments', tab.commentEvents.length);
            tab.commentEvents = [];
            await this.withTabOperation(tab, 'clear-comment-overlay', () => this.postCommentBridgeMessage(tab, {
                type: 'clear-comments',
                ...(options?.markSent === true ? { sent: true } : {}),
            }));
        }
        return { success: true, tabId: tab.tabId };
    }
    ackCommentEvents(params) {
        let tab;
        try {
            tab = this.resolveBrowserTab(params, { allowLegacyActive: true });
        }
        catch (error) {
            return { success: false, error: safeError(error) };
        }
        if (!tab)
            return { success: false, error: 'No embedded tab is available' };
        const throughEventId = Math.max(0, Math.floor(params?.throughEventId ?? 0));
        if (throughEventId <= 0) {
            return {
                success: true,
                tabId: tab.tabId,
                throughEventId,
                ackedCount: 0,
                pendingCount: tab.commentEvents.length,
            };
        }
        const before = tab.commentEvents.length;
        tab.commentEvents = tab.commentEvents.filter((event) => event.eventId > throughEventId);
        const ackedCount = before - tab.commentEvents.length;
        logger.info({
            msg: '[EmbeddedBrowserComment] comment-events-acked',
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            throughEventId,
            ackedCount,
            pendingCount: tab.commentEvents.length,
            pageHost: urlHost(tab.url),
        });
        if (ackedCount > 0) {
            this.ensureHiddenSweepTimer();
        }
        return {
            success: true,
            tabId: tab.tabId,
            throughEventId,
            ackedCount,
            pendingCount: tab.commentEvents.length,
        };
    }
    async navigate(url, target) {
        return this.executeTool('navigate', { ...(target ?? {}), url: normalizeUrl(url) });
    }
    getActiveTab() {
        return this.activeTabId === null ? null : (this.tabs.get(this.activeTabId) ?? null);
    }
    async withTabOperation(tab, label, operation, options = {}) {
        const previousOperationCount = Math.max(0, tab.operationCount ?? 0);
        tab.operationCount = previousOperationCount + 1;
        if (this.agentToolCallDepth > 0) {
            tab.lastAgentOperationAt = nowMs();
            this.clearAgentKeepaliveTimer(tab);
        }
        if (previousOperationCount === 0) {
            tab.controller.setBackgroundThrottlingAllowed(false);
        }
        tab.lastUsedAt = nowMs();
        const startedAt = nowMs();
        const hiddenAtStart = tab.hiddenAt != null || tab.bounds.x < 0 || tab.bounds.y < 0;
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserOperation] start',
            label,
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            hidden: hiddenAtStart,
            operationCount: tab.operationCount,
        });
        let outcome = 'success';
        let operationPromise;
        let operationSettled = true;
        let releaseWhenSettled = false;
        let operationReleased = false;
        const releaseOperation = () => {
            if (operationReleased)
                return;
            operationReleased = true;
            tab.operationCount = Math.max(0, (tab.operationCount ?? 1) - 1);
            const withinAgentKeepalive = tab.operationCount === 0 && this.isWithinAgentKeepalive(tab);
            if (tab.operationCount === 0 && !withinAgentKeepalive) {
                tab.controller.setBackgroundThrottlingAllowed(true);
            }
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserOperation] settled',
                label,
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                hidden: hiddenAtStart,
                outcome,
                durationMs: nowMs() - startedAt,
                operationCount: tab.operationCount,
                agentKeepalive: withinAgentKeepalive,
            });
            if (tab.operationCount === 0) {
                if (withinAgentKeepalive) {
                    // Keep the tab responsive between consecutive agent actions:
                    // suspending here destroys the WebContents and cold-resumes the
                    // page, which drops SPA state and invalidates element refs the
                    // model still holds; re-throttling freezes page timers while the
                    // panel is hidden or the host window is occluded.
                    this.scheduleAgentKeepaliveExpiry(tab);
                }
                else if (tab.hiddenAt != null && this.activeTabId !== tab.tabId) {
                    void this.suspendTab(tab, 'background-tab-operation-settled');
                }
            }
            this.ensureHiddenSweepTimer();
        };
        const markOperationSettled = () => {
            operationSettled = true;
            if (releaseWhenSettled)
                releaseOperation();
        };
        try {
            if (options.signal?.aborted)
                throw new Error('ABORTED: Browser action was cancelled');
            const hidden = tab.hiddenAt != null || tab.bounds.x < 0 || tab.bounds.y < 0;
            if (hidden && options.requiresBackgroundRender !== false) {
                const lastForegroundBounds = tab.lastForegroundBounds;
                const renderOptions = {
                    ...(options.signal ? { signal: options.signal } : {}),
                    schedulingKey: typeof tab.sessionId === 'string' ? tab.sessionId : `browser-tab:${tab.tabId}`,
                    ...(options.operationTimeoutMs ? { operationTimeoutMs: options.operationTimeoutMs } : {}),
                    ...(lastForegroundBounds
                        ? {
                            bounds: {
                                x: 0,
                                y: 0,
                                width: lastForegroundBounds.width,
                                height: lastForegroundBounds.height,
                            },
                        }
                        : {}),
                };
                return Object.keys(renderOptions).length > 0
                    ? await this.backgroundRenderHost.run(tab.controller, (signal) => operation(signal), renderOptions)
                    : await this.backgroundRenderHost.run(tab.controller, (signal) => operation(signal));
            }
            const operationTimeoutMs = options.operationTimeoutMs ?? BROWSER_TIMEOUTS.tabOperation;
            return await withTimeout((operationSignal) => {
                operationSettled = false;
                operationPromise = Promise.resolve().then(() => operation(operationSignal));
                void operationPromise.then(markOperationSettled, markOperationSettled);
                return operationPromise;
            }, operationTimeoutMs, `withTabOperation[${label}]`, { signal: options.signal });
        }
        catch (error) {
            outcome = 'error';
            browserInputDiagnosticLogger.warn({
                msg: '[EmbeddedBrowserOperation] failed',
                label,
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                hidden: hiddenAtStart,
                durationMs: nowMs() - startedAt,
                error: safeError(error),
            });
            throw error;
        }
        finally {
            // A deadline settles the caller before a non-cooperative task necessarily stops. Keep the
            // tab lease and throttling state until that task acknowledges abort and actually settles.
            if (operationPromise && !operationSettled)
                releaseWhenSettled = true;
            else
                releaseOperation();
        }
    }
    isAgentCursorVisible(tab) {
        return isAgentCursorVisible({
            tab,
            activeTabId: this.activeTabId,
            session: typeof tab.sessionId === 'string' ? this.sessions.get(tab.sessionId) : undefined,
            hostWindow: this.hostWindow,
        });
    }
    getOrCreateSession(sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing)
            return existing;
        const now = nowMs();
        const session = {
            sessionId,
            tabIds: [],
            selectedTabId: null,
            visibleTabId: null,
            createdAt: now,
            updatedAt: now,
        };
        this.sessions.set(sessionId, session);
        return session;
    }
    attachTabToSession(tab) {
        if (typeof tab.sessionId !== 'string')
            return;
        const session = this.getOrCreateSession(tab.sessionId);
        if (!session.tabIds.includes(tab.tabId))
            session.tabIds.push(tab.tabId);
        if (session.selectedTabId === null)
            session.selectedTabId = tab.tabId;
        session.updatedAt = nowMs();
    }
    detachTabFromSession(tab) {
        if (typeof tab.sessionId !== 'string')
            return;
        const session = this.sessions.get(tab.sessionId);
        if (!session)
            return;
        session.tabIds = session.tabIds.filter((tabId) => tabId !== tab.tabId);
        if (session.selectedTabId === tab.tabId)
            session.selectedTabId = session.tabIds[0] ?? null;
        if (session.visibleTabId === tab.tabId)
            session.visibleTabId = null;
        session.updatedAt = nowMs();
        if (session.tabIds.length === 0)
            this.sessions.delete(tab.sessionId);
    }
    markTabSelected(tab) {
        this.activeTabId = tab.tabId;
        this.markTabSessionSelected(tab);
    }
    markTabSessionSelected(tab) {
        tab.lastUsedAt = nowMs();
        if (typeof tab.sessionId !== 'string')
            return;
        const session = this.getOrCreateSession(tab.sessionId);
        if (!session.tabIds.includes(tab.tabId))
            session.tabIds.push(tab.tabId);
        session.selectedTabId = tab.tabId;
        session.updatedAt = nowMs();
        if (tab.persistentTabId)
            this.registry.selectTab(tab.sessionId, tab.persistentTabId);
    }
    markTabVisible(tab) {
        const previousHiddenAt = tab.hiddenAt ?? null;
        const hiddenMs = previousHiddenAt === null ? 0 : nowMs() - previousHiddenAt;
        this.markTabSelected(tab);
        tab.controller.setAudioMuted(false);
        tab.hiddenAt = null;
        if (typeof tab.sessionId !== 'string')
            return;
        const session = this.getOrCreateSession(tab.sessionId);
        session.visibleTabId = tab.tabId;
        session.updatedAt = nowMs();
        if (hiddenMs > 0)
            this.logTabLifecycle('shown', tab, { hiddenMs });
    }
    markTabHidden(tab) {
        tab.controller.setAudioMuted(true);
        this.backgroundRenderHost.releaseForeground(tab.controller);
        void tab.controller.hideAgentCursor?.();
        const wasVisible = tab.hiddenAt == null;
        tab.hiddenAt = tab.hiddenAt ?? nowMs();
        if (typeof tab.sessionId === 'string') {
            const session = this.sessions.get(tab.sessionId);
            if (session) {
                if (session.visibleTabId === tab.tabId)
                    session.visibleTabId = null;
                session.updatedAt = nowMs();
            }
        }
        if (wasVisible)
            this.logTabLifecycle('hidden', tab);
        this.ensureHiddenSweepTimer();
    }
    claimLayoutCommand(tab, layoutCommandId) {
        if (typeof layoutCommandId !== 'number')
            return true;
        const previousCommandId = tab.lastLayoutCommandId ?? 0;
        if (layoutCommandId < previousCommandId) {
            logger.info({
                msg: '[EmbeddedBrowserBounds] stale-layout-command-ignored',
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                layoutCommandId,
                previousCommandId,
            });
            return false;
        }
        tab.lastLayoutCommandId = layoutCommandId;
        return true;
    }
    claimShowLayoutCommand(layoutCommandId) {
        if (typeof layoutCommandId !== 'number')
            return true;
        if (layoutCommandId < this.latestShowLayoutCommandId)
            return false;
        this.latestShowLayoutCommandId = layoutCommandId;
        return true;
    }
    isLatestShowLayoutCommand(layoutCommandId) {
        return (typeof layoutCommandId !== 'number' || layoutCommandId === this.latestShowLayoutCommandId);
    }
    ensureHiddenSweepTimer() {
        if (this.hiddenSweepTimer)
            return;
        if (!Array.from(this.tabs.values()).some((tab) => tab.hiddenAt != null))
            return;
        const timer = setInterval(() => void this.sweepHiddenTabs(), HIDDEN_SWEEP_INTERVAL_MS);
        timer.unref?.();
        this.hiddenSweepTimer = timer;
    }
    stopHiddenSweepTimerIfIdle() {
        if (!this.hiddenSweepTimer)
            return;
        if (Array.from(this.tabs.values()).some((tab) => tab.hiddenAt != null))
            return;
        clearInterval(this.hiddenSweepTimer);
        this.hiddenSweepTimer = null;
    }
    sweepHiddenTabs() {
        const hiddenTabs = Array.from(this.tabs.values()).filter((tab) => tab.hiddenAt != null);
        if (hiddenTabs.length === 0) {
            this.stopHiddenSweepTimerIfIdle();
            return;
        }
        const budget = this.adaptiveBudget.sample(hiddenTabs.map((tab) => ({ tabId: tab.tabId, webContents: this.getWebContents(tab) })));
        if (budget.pressure !== this.lastResourceDiagnosticPressure) {
            this.lastResourceDiagnosticPressure = budget.pressure;
            this.browserResourceDiagnostics.sample(`memory-pressure:${budget.pressure}`);
        }
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserResource] adaptive-budget',
            pressure: budget.pressure,
            deviceCap: budget.deviceCap,
            hiddenTabBudget: budget.hiddenTabBudget,
            hiddenTabCount: hiddenTabs.length,
            availableMemoryMiB: Math.round(budget.availableBytes / 1024 ** 2),
            totalMemoryGiB: Math.round((budget.totalBytes / 1024 ** 3) * 10) / 10,
        });
        hiddenTabs.sort((a, b) => memoryWeightedLruValue(a.lastUsedAt ?? a.hiddenAt ?? 0, budget.estimatedWorkingSetKiBByTabId.get(a.tabId) ?? 0) -
            memoryWeightedLruValue(b.lastUsedAt ?? b.hiddenAt ?? 0, budget.estimatedWorkingSetKiBByTabId.get(b.tabId) ?? 0));
        const reclaimableTabs = hiddenTabs.filter((tab) => this.canDestroyHiddenTab(tab));
        const hiddenTabBudget = Math.min(MAX_HIDDEN_TABS, budget.hiddenTabBudget);
        const overBudgetCount = Math.max(0, reclaimableTabs.length - hiddenTabBudget);
        const overBudgetTabIds = new Set(reclaimableTabs.slice(0, overBudgetCount).map((tab) => tab.tabId));
        const now = nowMs();
        for (const tab of hiddenTabs) {
            const hiddenMs = now - (tab.hiddenAt ?? now);
            const overIdleLimit = hiddenMs >= HIDDEN_IDLE_TIMEOUT_MS;
            const overCountLimit = overBudgetTabIds.has(tab.tabId);
            if (!overIdleLimit && !overCountLimit)
                continue;
            // Protection state can change between candidate selection and teardown.
            // Recheck immediately before destruction so a newly-started action/load
            // always wins the race against the periodic sweep.
            if (!this.canDestroyHiddenTab(tab))
                continue;
            void this.suspendTab(tab, overIdleLimit ? 'hidden-idle-timeout' : `hidden-tab-limit:${budget.pressure}`);
        }
        this.stopHiddenSweepTimerIfIdle();
    }
    async suspendTab(tab, reason) {
        if (this.suspendingTabIds.has(tab.tabId) || !this.canDestroyHiddenTab(tab))
            return;
        this.suspendingTabIds.add(tab.tabId);
        try {
            const pageResume = await Promise.race([
                capturePageResume(tab.controller),
                new Promise((resolve) => {
                    const timer = setTimeout(() => resolve(null), 250);
                    timer.unref?.();
                }),
            ]).catch(() => null);
            if (!this.tabs.has(tab.tabId) || !this.canDestroyHiddenTab(tab))
                return;
            const navigationHistory = this.captureNavigationSnapshot(tab);
            if (typeof tab.sessionId === 'string' && typeof tab.persistentTabId === 'string') {
                this.coldResumeSnapshots.set(this.coldResumeKey(tab), {
                    navigationHistory,
                    pageResume,
                });
                this.suspendedTabs.set(tab.tabId, {
                    tabId: tab.tabId,
                    persistentTabId: tab.persistentTabId,
                    sessionId: tab.sessionId,
                    createdAt: tab.createdAt,
                    lastUsedAt: tab.lastUsedAt,
                    title: tab.title,
                    url: tab.url,
                    ...(tab.requestedUrl ? { requestedUrl: tab.requestedUrl } : {}),
                    ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
                    ...(tab.lastForegroundBounds ? { lastForegroundBounds: tab.lastForegroundBounds } : {}),
                    lastLoadError: tab.lastLoadError,
                    zoomFactor: tab.controller.getZoomFactor(),
                    devicePreviewMode: tab.controller.getDevicePreviewMode(),
                    devicePreviewState: tab.controller.getDevicePreviewState(),
                });
            }
            this.destroyTab(tab, reason, { preserveLogicalTab: this.suspendedTabs.has(tab.tabId) });
        }
        finally {
            this.suspendingTabIds.delete(tab.tabId);
        }
    }
    isWithinAgentKeepalive(tab) {
        return (tab.lastAgentOperationAt != null &&
            nowMs() - tab.lastAgentOperationAt < AGENT_OPERATION_KEEPALIVE_MS);
    }
    clearAgentKeepaliveTimer(tab) {
        if (tab.agentKeepaliveTimer) {
            clearTimeout(tab.agentKeepaliveTimer);
            tab.agentKeepaliveTimer = null;
        }
    }
    scheduleAgentKeepaliveExpiry(tab) {
        this.clearAgentKeepaliveTimer(tab);
        const elapsedMs = tab.lastAgentOperationAt == null
            ? AGENT_OPERATION_KEEPALIVE_MS
            : nowMs() - tab.lastAgentOperationAt;
        const delayMs = Math.max(0, AGENT_OPERATION_KEEPALIVE_MS - elapsedMs);
        const timer = setTimeout(() => {
            tab.agentKeepaliveTimer = null;
            if (this.tabs.get(tab.tabId) !== tab)
                return;
            if ((tab.operationCount ?? 0) > 0)
                return;
            if (this.isWithinAgentKeepalive(tab)) {
                // A newer agent operation refreshed the window after this timer was armed.
                this.scheduleAgentKeepaliveExpiry(tab);
                return;
            }
            tab.controller.setBackgroundThrottlingAllowed(true);
            if (tab.hiddenAt != null && this.activeTabId !== tab.tabId) {
                void this.suspendTab(tab, 'agent-keepalive-expired');
            }
        }, delayMs);
        timer.unref?.();
        tab.agentKeepaliveTimer = timer;
    }
    canDestroyHiddenTab(tab) {
        if (tab.miniApp)
            return false;
        if (tab.hiddenAt == null || (tab.operationCount ?? 0) > 0 || tab.commentEvents.length > 0) {
            return false;
        }
        // An agent mid-turn still holds refs into this page; destroying it would
        // cold-resume the tab and silently invalidate every outstanding handle.
        if (this.isWithinAgentKeepalive(tab))
            return false;
        try {
            const hiddenMs = nowMs() - tab.hiddenAt;
            return tab.controller.getState().isLoading !== true || hiddenMs >= HIDDEN_LOADING_GRACE_MS;
        }
        catch {
            // Reclamation is optional. If the renderer state cannot be read, keep
            // the tab and retry on a later sweep instead of racing its teardown.
            return false;
        }
    }
    logTabLifecycle(event, tab, extra) {
        browserInputDiagnosticLogger.info({
            msg: `[EmbeddedBrowserLifecycle] ${event}`,
            event,
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            pageHost: urlHost(tab.url),
            webContentsId: this.getWebContents(tab)?.id ?? null,
            aliveMs: nowMs() - tab.createdAt,
            hiddenMs: extra?.hiddenMs ?? (tab.hiddenAt == null ? 0 : nowMs() - tab.hiddenAt),
            operationCount: tab.operationCount ?? 0,
            pendingCommentEventCount: tab.commentEvents.length,
            reason: extra?.reason ?? null,
        });
    }
    bindWebContentsResourceAudit(tab) {
        const contents = this.getWebContents(tab);
        if (!contents)
            return;
        const webContentsId = contents.id;
        let rendererPid = null;
        try {
            rendererPid = contents.getOSProcessId();
        }
        catch {
            // A renderer can disappear between creation and diagnostic binding.
        }
        const onRenderProcessGone = (_event, details) => {
            this.browserResourceDiagnostics.onRenderProcessGone();
            browserInputDiagnosticLogger.warn({
                msg: '[EmbeddedBrowserLifecycle] render-process-gone',
                event: 'render-process-gone',
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                webContentsId,
                rendererPid,
                reason: details?.reason ?? null,
            });
            this.browserResourceDiagnostics.sample('render-process-gone');
            if (this.tabs.get(tab.tabId) === tab) {
                this.destroyTab(tab, `render-process-gone:${details?.reason ?? 'unknown'}`);
            }
        };
        this.addTabListener(tab, contents, 'render-process-gone', onRenderProcessGone);
        const once = contents.once;
        if (typeof once !== 'function')
            return;
        once.call(contents, 'destroyed', () => {
            const expected = this.destroyingTabIds.has(tab.tabId) || this.tabs.get(tab.tabId) !== tab;
            this.browserResourceDiagnostics.onWebContentsDestroyed();
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserLifecycle] web-contents-destroyed',
                event: 'web-contents-destroyed',
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                webContentsId,
                rendererPid,
                expected,
            });
            if (!expected) {
                this.destroyTab(tab, 'web-contents-destroyed');
                return;
            }
            this.browserResourceDiagnostics.sample('web-contents-destroyed');
        });
    }
    getHostWindow() {
        if (this.hostWindow && !this.hostWindow.isDestroyed())
            return this.hostWindow;
        return this.resolveParentWindow();
    }
    getHostRendererViewOffset(hostWebContentsId) {
        const bounds = this.getHostRendererViewBounds(hostWebContentsId);
        return {
            x: bounds ? (finiteNumber(bounds.x) ?? 0) : 0,
            y: bounds ? (finiteNumber(bounds.y) ?? 0) : 0,
        };
    }
    getHostRendererViewBounds(hostWebContentsIdOverride) {
        const hostWindow = this.getHostWindow();
        if (!hostWindow || hostWindow.isDestroyed())
            return null;
        const hostWebContentsId = hostWebContentsIdOverride ?? this.hostWebContentsId ?? hostWindow.webContents.id;
        const children = hostWindow.contentView?.children ?? [];
        for (const child of children) {
            const view = child;
            if (view.webContents?.id !== hostWebContentsId || typeof view.getBounds !== 'function') {
                continue;
            }
            return view.getBounds();
        }
        return null;
    }
    getContentViewChildDiagnostics(hostWebContentsIdOverride) {
        const hostWindow = this.getHostWindow();
        if (!hostWindow || hostWindow.isDestroyed())
            return [];
        const hostWebContentsId = hostWebContentsIdOverride ?? this.hostWebContentsId ?? hostWindow.webContents.id;
        const children = hostWindow.contentView?.children ?? [];
        return children.map((child, index) => {
            const view = child;
            const webContentsId = typeof view.webContents?.id === 'number' ? view.webContents.id : null;
            return {
                index,
                type: view.constructor?.name ?? 'View',
                webContentsId,
                isHostRenderer: webContentsId === hostWebContentsId,
                bounds: typeof view.getBounds === 'function' ? view.getBounds() : null,
            };
        });
    }
    logBoundsDiagnostic(tab, rendererBounds, viewport, nativeBounds, layoutContext) {
        const hostWindow = this.getHostWindow();
        const hostWebContentsId = layoutContext?.hostWebContentsId ??
            this.hostWebContentsId ??
            hostWindow?.webContents.id ??
            null;
        const hostZoomFactor = layoutContext?.hostZoomFactor ?? this.hostZoomFactor;
        const hostRendererBounds = this.getHostRendererViewBounds(hostWebContentsId);
        const offset = this.getHostRendererViewOffset(hostWebContentsId);
        const children = this.getContentViewChildDiagnostics(hostWebContentsId);
        const nativeView = tab.controller.getNativeViewDiagnostics?.() ?? null;
        const key = JSON.stringify({
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            rendererBounds,
            nativeBounds,
            viewportWidth: viewport?.width ?? null,
            viewportHeight: viewport?.height ?? null,
            visualViewportWidth: viewport?.visualViewport?.width ?? null,
            visualViewportHeight: viewport?.visualViewport?.height ?? null,
            hostWebContentsId,
            hostZoomFactor,
            hostRendererBounds,
            childCount: children.length,
            childBounds: children.map((child) => ({
                webContentsId: child.webContentsId,
                isHostRenderer: child.isHostRenderer,
                bounds: child.bounds,
            })),
            nativeView,
        });
        if (this.lastBoundsDiagnosticKey === key)
            return;
        this.lastBoundsDiagnosticKey = key;
        logger.info({
            msg: '[EmbeddedBrowserBounds] set-bounds',
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            activeTabId: this.activeTabId,
            hostWindowId: hostWindow?.id ?? null,
            hostWindowWebContentsId: hostWindow?.webContents.id ?? null,
            hostWebContentsId,
            hostZoomFactor,
            rendererBounds,
            viewport: viewport ?? null,
            hostRendererBounds,
            coordinateSpace: 'renderer-css-to-native-dip',
            offset,
            nativeBounds,
            nativeView,
            contentViewChildren: children,
        });
    }
    logNativeLayerDiagnostic(tab, browserFocused, hostWebContentsIdOverride) {
        const hostWindow = this.getHostWindow();
        if (!hostWindow || hostWindow.isDestroyed())
            return;
        const children = this.getContentViewChildDiagnostics(hostWebContentsIdOverride);
        const webContents = this.getWebContents(tab);
        const browserWebContentsId = webContents?.id ?? null;
        const hostRendererWebContentsId = hostWebContentsIdOverride ?? this.hostWebContentsId ?? hostWindow.webContents.id;
        const browserChildIndex = children.findIndex((child) => child.webContentsId === browserWebContentsId);
        const hostRendererChildIndex = children.findIndex((child) => child.webContentsId === hostRendererWebContentsId);
        const topmostChildIndex = children.length - 1;
        const browserIsTopmost = browserChildIndex >= 0 && browserChildIndex === topmostChildIndex;
        const hostDevToolsOpened = typeof hostWindow.webContents.isDevToolsOpened === 'function'
            ? hostWindow.webContents.isDevToolsOpened()
            : null;
        const browserDevToolsOpened = webContents && typeof webContents.isDevToolsOpened === 'function'
            ? webContents.isDevToolsOpened()
            : null;
        const diagnostic = {
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            browserWebContentsId,
            hostRendererWebContentsId,
            childCount: children.length,
            browserChildIndex,
            hostRendererChildIndex,
            topmostChildIndex,
            browserIsTopmost,
            browserAttached: browserChildIndex >= 0,
            browserFocused,
            hostDevToolsOpened,
            browserDevToolsOpened,
            commentModeEnabled: tab.commentModeEnabled,
            browserBounds: tab.controller.getNativeViewDiagnostics?.().actualBounds ?? null,
            childOrder: children.map((child) => ({
                index: child.index,
                type: child.type,
                webContentsId: child.webContentsId,
                isHostRenderer: child.isHostRenderer,
            })),
        };
        const key = JSON.stringify(diagnostic);
        if (this.lastNativeLayerDiagnosticKey === key)
            return;
        this.lastNativeLayerDiagnosticKey = key;
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserInput] native-layer-state',
            ...diagnostic,
        });
    }
    toNativePreviewLayout(layout, context) {
        if (!layout)
            return layout;
        const zoom = context?.hostZoomFactor ?? this.hostZoomFactor;
        return {
            offset: { x: Math.round(layout.offset.x * zoom), y: Math.round(layout.offset.y * zoom) },
            available: { width: layout.available.width * zoom, height: layout.available.height * zoom },
            hostZoomFactor: zoom,
        };
    }
    toContentViewBounds(bounds, layoutContext) {
        if (bounds.x < 0 || bounds.y < 0)
            return bounds;
        const scale = layoutContext?.hostZoomFactor ?? this.hostZoomFactor;
        const offset = this.getHostRendererViewOffset(layoutContext?.hostWebContentsId);
        if (scale === 1 && offset.x === 0 && offset.y === 0)
            return bounds;
        return {
            ...bounds,
            x: bounds.x * scale + offset.x,
            y: bounds.y * scale + offset.y,
            width: bounds.width * scale,
            height: bounds.height * scale,
        };
    }
    normalizeBounds(bounds, _viewport, layoutContext) {
        const contentViewBounds = this.toContentViewBounds(bounds, layoutContext);
        return {
            x: Math.round(contentViewBounds.x),
            y: Math.round(contentViewBounds.y),
            width: Math.max(1, Math.round(contentViewBounds.width)),
            height: Math.max(1, Math.round(contentViewBounds.height)),
        };
    }
    /**
     * Sweeps every other inline (non-detached) tab that is still occupying the
     * panel offscreen, releases it in the background, and returns the tabs it
     * parked. Used both when committing a normal tab switch and when the
     * selected target turns out to be a detached Mini App: a detached window's
     * page is display-owned by its own BrowserWindow, but the File Panel's
     * WebContentsView for the *previous* inline tab is still attached and must
     * not keep painting over the panel's placeholder. A non-selected tab must
     * not keep timers, media decoders, or video playback alive in the
     * background either way, so parking always schedules a suspend.
     */
    parkOtherVisibleInlineTabs(target, reason) {
        const previouslyVisibleTabs = Array.from(this.tabs.values()).filter((other) => other.tabId !== target.tabId &&
            !other.detachedWindow &&
            !(other.bounds.x === OFFSCREEN_BOUNDS.x && other.bounds.y === OFFSCREEN_BOUNDS.y));
        for (const other of previouslyVisibleTabs) {
            other.controller.setBounds(OFFSCREEN_BOUNDS);
            other.bounds = OFFSCREEN_BOUNDS;
            this.markTabHidden(other);
            void this.suspendTab(other, reason);
        }
        return previouslyVisibleTabs;
    }
    /**
     * Single-visible invariant: stage the target at its real bounds and raise it,
     * then sweep every OTHER tab offscreen before completing the transition. A
     * stale or duplicate setBounds for one session can therefore never leave
     * another session's view painted over the panel. bringToFront only runs for
     * an actual visibility or tab transition. Periodic bounds verification must
     * not detach, reattach, or rewrite unchanged native bounds because those
     * operations can clear focus, interrupt IME composition, or cancel pointer
     * capture.
     */
    async showTabExclusive(target, bounds, options = {}) {
        if (this.tabs.get(target.tabId) !== target || target.detachedWindow)
            return false;
        const handoffStartedAt = nowMs();
        const targetWasHidden = target.bounds.x === OFFSCREEN_BOUNDS.x && target.bounds.y === OFFSCREEN_BOUNDS.y;
        const foregroundHost = this.getHostWindow();
        if (foregroundHost)
            target.controller.addToParent(foregroundHost);
        if (options.previewLayout === undefined)
            await target.controller.setBounds(bounds);
        else
            await target.controller.setBounds(bounds, options.previewLayout);
        // A detach can finish while the bounds write is in flight; the page now
        // belongs to its own window and panel coordinates must not reach it.
        if (this.tabs.get(target.tabId) !== target || target.detachedWindow)
            return false;
        if (this.hasBlockingNativeOverlay()) {
            await target.controller.setBounds(OFFSCREEN_BOUNDS);
            target.bounds = OFFSCREEN_BOUNDS;
            target.lastForegroundBounds = bounds;
            this.markTabHidden(target);
            return false;
        }
        if (options.shouldCommit && !options.shouldCommit()) {
            if (targetWasHidden) {
                await target.controller.setBounds(OFFSCREEN_BOUNDS);
                target.bounds = OFFSCREEN_BOUNDS;
                this.markTabHidden(target);
            }
            return false;
        }
        target.bounds = bounds;
        target.lastForegroundBounds = bounds;
        if (options.bringToFront !== false)
            target.controller.bringToFront();
        this.markTabVisible(target);
        // Keep the previous native surface in place until the target has accepted
        // its real bounds and has been raised. This avoids a blank compositor gap
        // without adding a fixed sleep to the live-to-live switch path.
        const previouslyVisibleTabs = this.parkOtherVisibleInlineTabs(target, 'background-tab-switch');
        if (previouslyVisibleTabs.length > 0) {
            browserInputDiagnosticLogger.info({
                msg: '[EmbeddedBrowserLifecycle] staged-handoff',
                event: 'staged-handoff',
                sourceTabIds: previouslyVisibleTabs.map((tab) => tab.tabId),
                targetTabId: target.tabId,
                sessionId: target.sessionId,
                durationMs: nowMs() - handoffStartedAt,
            });
        }
        try {
            this.getWebContents(target)?.invalidate();
        }
        catch {
            // The tab may be destroyed between foreground attachment and repaint.
        }
        return true;
    }
    async ensureActiveTab(bounds, sessionId) {
        const existing = this.getActiveTab();
        if (existing) {
            if (sessionId)
                existing.sessionId = sessionId;
            return existing;
        }
        return this.openTab({ active: true, bounds, sessionId });
    }
    async ensureTabForSession(bounds, sessionId, initialUrl, loadMode = 'agent', active = true) {
        const pending = this.ensuringSessionTabs.get(sessionId);
        if (pending)
            return pending;
        const existing = this.resolveTabBySession(sessionId);
        if (existing)
            return existing;
        if (typeof sessionId === 'string') {
            const selectedTabId = this.sessions.get(sessionId)?.selectedTabId;
            if (typeof selectedTabId === 'number' && this.suspendedTabs.has(selectedTabId)) {
                const resumed = await this.resumeSuspendedTab(selectedTabId, sessionId);
                if (resumed)
                    return resumed;
            }
        }
        return this.ensureSessionTabCreation(sessionId, () => this.openPersistedOrBlankTab({ active, bounds, sessionId, initialUrl, loadMode }));
    }
    async ensureSessionTabCreation(sessionId, create) {
        const pending = this.ensuringSessionTabs.get(sessionId);
        if (pending)
            return pending;
        const creation = create();
        this.ensuringSessionTabs.set(sessionId, creation);
        try {
            return await creation;
        }
        finally {
            if (this.ensuringSessionTabs.get(sessionId) === creation) {
                this.ensuringSessionTabs.delete(sessionId);
            }
        }
    }
    async openPersistedOrBlankTab(args) {
        const persisted = typeof args.sessionId === 'string' ? this.registry.getSelectedTab(args.sessionId) : null;
        const coldResume = persisted && typeof args.sessionId === 'string'
            ? this.coldResumeSnapshots.get(this.coldResumeKey({
                sessionId: args.sessionId,
                persistentTabId: persisted.persistentTabId,
            }))
            : undefined;
        const navigationHistory = args.initialUrl
            ? undefined
            : (coldResume?.navigationHistory ??
                (persisted?.navigationHistory
                    ? {
                        activeIndex: persisted.navigationHistory.activeIndex,
                        entries: persisted.navigationHistory.entries.map((entry) => ({ ...entry })),
                    }
                    : undefined));
        const tab = await this.openTab({
            ...args,
            ...(navigationHistory ? { navigationHistory } : {}),
            ...(!args.initialUrl && coldResume?.pageResume ? { pageResume: coldResume.pageResume } : {}),
            ...(persisted
                ? {
                    persistentTabId: persisted.persistentTabId,
                    ...(persisted.requestedUrl ? { requestedUrl: persisted.requestedUrl } : {}),
                    url: args.initialUrl ?? persisted.url,
                }
                : args.initialUrl
                    ? { url: args.initialUrl }
                    : {}),
        });
        if (coldResume) {
            this.coldResumeSnapshots.delete(this.coldResumeKey({
                sessionId: args.sessionId,
                persistentTabId: persisted?.persistentTabId ?? null,
            }));
        }
        return tab;
    }
    async openPageTab(source, rawUrl) {
        const url = normalizePersistedBrowserUrl(rawUrl);
        if (!url ||
            this.tabs.get(source.tabId) !== source ||
            (url.startsWith('file:') && !source.url.startsWith('file:'))) {
            return;
        }
        // Do not let a slow page open override a newer user selection or a hide.
        const showLayoutCommandId = this.latestShowLayoutCommandId;
        let opened;
        // A detached source's own bounds are window-local (always >= 0); reveal
        // the new page into the panel at the position the source last held there.
        const panelBounds = () => source.detachedWindow ? source.lastForegroundBounds : source.bounds;
        const canReveal = () => opened !== undefined &&
            this.tabs.get(opened.tabId) === opened &&
            this.tabs.get(source.tabId) === source &&
            // A detached source has no panel-visible bounds/hiddenAt of its own; the
            // panel slot's own visibility is tracked separately (bot P1 regression).
            (source.detachedWindow
                ? source.detachedPanelVisible === true && source.lastForegroundBounds !== undefined
                : isShownInPanel(source)) &&
            this.activeTabId === source.tabId &&
            (typeof source.sessionId !== 'string' ||
                this.sessions.get(source.sessionId)?.selectedTabId === source.tabId) &&
            this.latestShowLayoutCommandId === showLayoutCommandId;
        try {
            opened = await this.openTab({
                active: false,
                bounds: OFFSCREEN_BOUNDS,
                sessionId: source.sessionId,
                requestedUrl: url,
            });
            const target = opened;
            // Hold the new tab through the foreground handoff; finishing its load
            // must not make the hidden-tab sweeper reclaim it between awaits.
            target.operationCount += 1;
            target.controller.setBackgroundThrottlingAllowed(false);
            const result = await this.withTabOperation(target, 'page-open', () => target.controller.loadForPresentation({ url }));
            target.lastLoadError = presentationLoadError(target.lastLoadError, result, url);
            this.refreshTabState(target);
            if (!canReveal() || this.hasBlockingNativeOverlay())
                return;
            await this.backgroundRenderHost.claimForeground(target.controller);
            if (canReveal()) {
                const bounds = panelBounds();
                // canReveal() already confirmed this is defined; re-narrow for TS.
                if (bounds)
                    await this.showTabExclusive(target, bounds, { shouldCommit: canReveal });
            }
        }
        catch {
            if (opened && this.tabs.get(opened.tabId) === opened)
                this.destroyTab(opened, 'explicit');
            logger.warn({
                msg: '[EmbeddedBrowser] page-open failed',
                sourceTabId: source.tabId,
                sessionId: source.sessionId,
            });
        }
        finally {
            if (opened) {
                opened.operationCount = Math.max(0, opened.operationCount - 1);
                if (this.tabs.get(opened.tabId) === opened &&
                    !this.tabs.has(source.tabId) &&
                    !this.suspendedTabs.has(source.tabId)) {
                    this.destroyTab(opened, 'explicit');
                }
                if (opened.operationCount === 0 && this.tabs.get(opened.tabId) === opened) {
                    opened.controller.setBackgroundThrottlingAllowed(true);
                    if (opened.hiddenAt != null)
                        void this.suspendTab(opened, 'page-open-background');
                }
            }
        }
    }
    async openTab(args) {
        args.signal?.throwIfAborted();
        args.operationSignal?.throwIfAborted();
        const parentWindow = this.resolveParentWindow();
        if (!parentWindow)
            throw new Error('Main window not found');
        const tabId = args.tabId ?? this.nextTabId++;
        if (this.tabs.has(tabId))
            throw new Error(`Embedded browser tab already exists: tabId=${tabId}`);
        this.nextTabId = Math.max(this.nextTabId, tabId + 1);
        const creation = { sessionId: args.sessionId ?? null, cancelled: false };
        this.creatingTabs.set(tabId, creation);
        const controller = this.controllerFactory();
        const bounds = args.bounds ?? DEFAULT_BOUNDS;
        try {
            const created = await controller
                .create(parentWindow, bounds, {
                skipInitialLoad: Boolean(args.navigationHistory),
                devicePreviewMode: args.devicePreviewMode,
                devicePreviewState: args.devicePreviewState,
                surfaceKind: args.miniApp ? 'miniapp' : 'browser',
                ...(args.miniApp ? { miniAppSurfaceId: args.miniApp.surfaceId } : {}),
                onOpenTab: (url) => {
                    const source = this.tabs.get(tabId);
                    if (source?.controller === controller)
                        return this.openPageTab(source, url);
                },
            })
                .catch((error) => {
                controller.destroy();
                throw error;
            });
            if (!created.success) {
                controller.destroy();
                throw new Error(created.error ?? 'Failed to create embedded browser');
            }
            if (creation.cancelled || args.signal?.aborted || args.operationSignal?.aborted) {
                controller.destroy();
                args.operationSignal?.throwIfAborted();
                args.signal?.throwIfAborted();
                throw new Error('Embedded browser tab creation was cancelled');
            }
            const normalizedSessionId = args.sessionId ?? null;
            const persistedTab = typeof normalizedSessionId === 'string' && !args.miniApp
                ? this.registry.createTab(normalizedSessionId, {
                    ...(args.persistentTabId ? { persistentTabId: args.persistentTabId } : {}),
                    ...(args.requestedUrl ? { requestedUrl: args.requestedUrl } : {}),
                })
                : null;
            const tab = {
                tabId,
                persistentTabId: persistedTab?.persistentTabId ?? null,
                controller,
                createdAt: nowMs(),
                lastUsedAt: nowMs(),
                hiddenAt: bounds.x === OFFSCREEN_BOUNDS.x && bounds.y === OFFSCREEN_BOUNDS.y ? nowMs() : null,
                operationCount: 0,
                presentationRevision: 0,
                sessionId: normalizedSessionId,
                bounds,
                ...(bounds.x >= 0 && bounds.y >= 0 ? { lastForegroundBounds: bounds } : {}),
                title: '',
                url: 'about:blank',
                ...(args.requestedUrl ? { requestedUrl: args.requestedUrl } : {}),
                commentModeEnabled: false,
                commentSelectionMode: 'dom_node',
                commentTheme: 'system',
                commentEvents: [],
                navigationGeneration: 0,
                devicePreviewTaskTail: Promise.resolve(),
                commentTaskTail: Promise.resolve(),
                inFlightCommentMessages: new Map(),
                processedCommentMessageIds: new Set(),
                disposers: [],
                lastLoadError: null,
                ...(args.pageResume ? { pendingPageResume: args.pageResume } : {}),
                ...(args.miniApp ? { miniApp: args.miniApp } : {}),
            };
            controller.configureAgentCursor?.({
                isEnabled: () => !tab.miniApp && this.isAgentCursorEnabled(),
                identity: () => typeof tab.sessionId === 'string' ? { sessionId: tab.sessionId, tabId: tab.tabId } : null,
                isVisible: () => this.isAgentCursorVisible(tab),
                diagnose: (reason) => browserInputDiagnosticLogger.info({
                    msg: '[EmbeddedBrowserAgentCursor] degraded',
                    reason,
                    tabId: tab.tabId,
                    sessionId: tab.sessionId,
                    pageHost: urlHost(tab.url),
                }),
            });
            this.tabs.set(tabId, tab);
            // Register before the first navigation so the initial page load is authenticated.
            if (args.miniApp)
                this.syncMiniAppLoopbackAuth(tab);
            // MiniApps join the Session after their first load succeeds. Keep the
            // internal record above so stop and teardown can still find them.
            if (!args.miniApp) {
                this.attachTabToSession(tab);
                if (args.active !== false)
                    this.markTabSelected(tab);
                else if (args.selectInSession === true)
                    this.markTabSessionSelected(tab);
            }
            this.bindWebContentsEvents(tab);
            this.bindWebContentsResourceAudit(tab);
            this.logTabLifecycle('created', tab);
            this.ensureHiddenSweepTimer();
            this.browserResourceDiagnostics.onTabCreated();
            const historyRestored = args.navigationHistory
                ? await this.restoreNavigationSnapshot(tab, args.navigationHistory)
                : false;
            if (args.url && !historyRestored) {
                const url = normalizeUrl(args.url);
                try {
                    const result = await this.withTabOperation(tab, 'open-navigate', (operationSignal) => args.loadMode === 'presentation'
                        ? controller.loadForPresentation({ url })
                        : controller.navigate({ url }, miniAppNavigationOptions(args.miniApp ? args.signal : undefined, operationSignal)), args.operationSignal ? { signal: args.operationSignal } : {});
                    if (args.miniApp)
                        assertMiniAppNavigationSucceeded(result);
                    if (args.loadMode === 'presentation') {
                        tab.lastLoadError = presentationLoadError(tab.lastLoadError, result, url);
                    }
                    this.refreshTabState(tab);
                }
                catch (error) {
                    if (args.miniApp && this.tabs.has(tab.tabId)) {
                        this.destroyTab(tab, 'explicit', { revokeMiniAppOperation: false });
                    }
                    throw error;
                }
            }
            if (creation.cancelled)
                throw new Error('Embedded browser tab creation was cancelled');
            return tab;
        }
        finally {
            if (this.creatingTabs.get(tabId) === creation)
                this.creatingTabs.delete(tabId);
        }
    }
    async resumeSuspendedTab(tabId, requestedSessionId) {
        const live = this.tabs.get(tabId);
        if (live)
            return live;
        const suspended = this.suspendedTabs.get(tabId);
        if (!suspended)
            return null;
        if (typeof requestedSessionId === 'string' && suspended.sessionId !== requestedSessionId) {
            throw new Error(`Embedded browser tab ${tabId} does not belong to session ${requestedSessionId}`);
        }
        const existingResume = this.resumingTabs.get(tabId);
        if (existingResume)
            return existingResume;
        const resume = this.rehydrateSuspendedTab(suspended);
        this.resumingTabs.set(tabId, resume);
        try {
            return await resume;
        }
        finally {
            if (this.resumingTabs.get(tabId) === resume)
                this.resumingTabs.delete(tabId);
        }
    }
    async rehydrateSuspendedTab(suspended) {
        const persisted = this.registry
            .getSession(suspended.sessionId)
            ?.tabs.find((tab) => tab.persistentTabId === suspended.persistentTabId);
        const resumeKey = this.coldResumeKey(suspended);
        const coldResume = this.coldResumeSnapshots.get(resumeKey);
        const navigationHistory = coldResume?.navigationHistory ??
            (persisted?.navigationHistory
                ? {
                    activeIndex: persisted.navigationHistory.activeIndex,
                    entries: persisted.navigationHistory.entries.map((entry) => ({ ...entry })),
                }
                : undefined);
        const fallbackUrl = persisted?.url ?? suspended.url;
        const tab = await this.openTab({
            tabId: suspended.tabId,
            active: false,
            bounds: OFFSCREEN_BOUNDS,
            sessionId: suspended.sessionId,
            persistentTabId: suspended.persistentTabId,
            devicePreviewMode: suspended.devicePreviewMode,
            devicePreviewState: suspended.devicePreviewState,
            ...(suspended.requestedUrl || persisted?.requestedUrl
                ? { requestedUrl: suspended.requestedUrl ?? persisted?.requestedUrl }
                : {}),
            ...(navigationHistory
                ? { navigationHistory }
                : fallbackUrl && fallbackUrl !== 'about:blank'
                    ? { url: fallbackUrl, loadMode: 'presentation' }
                    : {}),
            ...(coldResume?.pageResume ? { pageResume: coldResume.pageResume } : {}),
        });
        if (this.suspendedTabs.get(suspended.tabId) !== suspended) {
            this.destroyTab(tab, 'explicit');
            throw new Error(`Embedded browser tab was closed while resuming: tabId=${suspended.tabId}`);
        }
        this.suspendedTabs.delete(suspended.tabId);
        this.coldResumeSnapshots.delete(resumeKey);
        return tab;
    }
    coldResumeKey(tab) {
        return `${tab.sessionId ?? ''}\u0000${tab.persistentTabId ?? ''}`;
    }
    deleteColdResumeSnapshot(tab) {
        if (typeof tab.sessionId !== 'string' || typeof tab.persistentTabId !== 'string')
            return;
        this.coldResumeSnapshots.delete(this.coldResumeKey(tab));
    }
    captureNavigationSnapshot(tab, includePageState = true) {
        if (typeof tab.sessionId !== 'string' || typeof tab.persistentTabId !== 'string')
            return null;
        const wc = this.getWebContents(tab);
        if (!wc || wc.isDestroyed())
            return null;
        try {
            const entries = wc.navigationHistory.getAllEntries();
            if (entries.length === 0)
                return null;
            const sourceActiveIndex = Math.max(0, Math.min(entries.length - 1, wc.navigationHistory.getActiveIndex()));
            const start = Math.min(Math.max(0, sourceActiveIndex - Math.floor(MAX_PERSISTED_BROWSER_HISTORY_ENTRIES / 2)), Math.max(0, entries.length - MAX_PERSISTED_BROWSER_HISTORY_ENTRIES));
            const boundedEntries = entries.slice(start, start + MAX_PERSISTED_BROWSER_HISTORY_ENTRIES);
            const activeIndex = sourceActiveIndex - start;
            this.registry.updateNavigationHistory(tab.sessionId, tab.persistentTabId, {
                activeIndex,
                entries: boundedEntries.map((entry) => ({ url: entry.url, title: entry.title })),
            });
            if (!includePageState)
                return null;
            let remainingPageStateBytes = MAX_IN_MEMORY_HISTORY_PAGE_STATE_BYTES;
            return {
                activeIndex,
                entries: boundedEntries.map((entry) => {
                    const pageStateBytes = typeof entry.pageState === 'string' ? Buffer.byteLength(entry.pageState, 'utf8') : 0;
                    if (pageStateBytes === 0 || pageStateBytes <= remainingPageStateBytes) {
                        remainingPageStateBytes -= pageStateBytes;
                        return { ...entry };
                    }
                    return { url: entry.url, title: entry.title };
                }),
            };
        }
        catch {
            return null;
        }
    }
    async restoreNavigationSnapshot(tab, snapshot) {
        const wc = this.getWebContents(tab);
        if (!wc || wc.isDestroyed() || snapshot.entries.length === 0)
            return false;
        try {
            await this.withTabOperation(tab, 'restore-navigation-history', () => wc.navigationHistory.restore({
                entries: snapshot.entries.map((entry) => ({ ...entry })),
                index: snapshot.activeIndex,
            }));
            await tab.controller.completeDeferredInitialization();
            this.refreshTabState(tab);
            return true;
        }
        catch (error) {
            logger.warn(`[EmbeddedBrowser] navigation history restore failed: ${safeError(error)}`);
            try {
                if (!wc.isDestroyed() && !wc.getURL())
                    await wc.loadURL('about:blank');
                await tab.controller.completeDeferredInitialization();
            }
            catch (initializationError) {
                logger.warn(`[EmbeddedBrowser] history fallback initialization failed: ${safeError(initializationError)}`);
            }
            return false;
        }
    }
    /**
     * Remember the renderer window that drives the FilePanel browser UI so
     * tabs attach to it regardless of the active window type (main/archon).
     */
    setHostWindow(window, hostWebContentsId, hostZoomFactor) {
        const nextWindow = window && !window.isDestroyed() ? window : null;
        const nextZoomFactor = typeof hostZoomFactor === 'number' &&
            Number.isFinite(hostZoomFactor) &&
            hostZoomFactor > 0.25 &&
            hostZoomFactor < 4
            ? hostZoomFactor
            : 1;
        if (this.hostWindow === nextWindow) {
            if (hostWebContentsId !== undefined && hostWebContentsId !== this.hostWebContentsId) {
                this.nativeResizeLeases.clear();
            }
            if (hostWebContentsId !== undefined)
                this.hostWebContentsId = hostWebContentsId;
            this.hostZoomFactor = nextZoomFactor;
            return;
        }
        this.clearHostWindowListeners();
        this.nativeResizeLeases.clear();
        this.hostWindow = nextWindow;
        this.hostWebContentsId = hostWebContentsId ?? null;
        this.hostZoomFactor = nextZoomFactor;
        if (!nextWindow)
            return;
        for (const tab of this.tabs.values()) {
            if (!isShownInPanel(tab))
                continue;
            tab.controller.addToParent(nextWindow);
        }
        const disposeForHostTeardown = () => {
            this.clearHostWindowListeners();
            // Renderer-owned modal leases cannot be released after a navigation,
            // crash, or window teardown. Drop them with their owner so a stale lease
            // cannot keep future Browser views parked forever.
            this.nativeOverlayOcclusionLeases.clear();
            this.nativeResizeLeases.clear();
            for (const tab of this.tabs.values()) {
                if (!isShownInPanel(tab))
                    continue;
                tab.controller.setBounds(OFFSCREEN_BOUNDS);
                tab.bounds = OFFSCREEN_BOUNDS;
                this.markTabHidden(tab);
            }
            if (this.hostWindow === nextWindow) {
                this.hostWindow = null;
                this.hostWebContentsId = null;
                this.hostZoomFactor = 1;
            }
        };
        const onDidStartNavigation = (...args) => {
            if (isMainDocumentNavigation(args))
                disposeForHostTeardown();
        };
        const onWillNavigate = () => disposeForHostTeardown();
        const onRenderProcessGone = () => disposeForHostTeardown();
        const verifyVisibleBounds = () => {
            for (const tab of this.tabs.values()) {
                if (!isShownInPanel(tab))
                    continue;
                tab.controller.setBounds(tab.bounds);
            }
        };
        this.addHostWindowListener(nextWindow.webContents, 'did-start-navigation', onDidStartNavigation);
        this.addHostWindowListener(nextWindow.webContents, 'will-navigate', onWillNavigate);
        this.addHostWindowListener(nextWindow.webContents, 'render-process-gone', onRenderProcessGone);
        // Detach while the window is still alive. Waiting for `closed` can let
        // Electron destroy child WebContentsView renderers with their UI host.
        this.addHostWindowListener(nextWindow, 'close', disposeForHostTeardown);
        this.addHostWindowListener(nextWindow.webContents, 'input-event', (_event, input) => {
            if (input?.type === 'mouseUp')
                this.nativeResizeLeases.clear();
        });
        this.addHostWindowListener(nextWindow, 'blur', () => {
            this.nativeResizeLeases.clear();
        });
        for (const event of ['focus', 'resize', 'restore', 'maximize', 'unmaximize']) {
            this.addHostWindowListener(nextWindow, event, verifyVisibleBounds);
        }
    }
    /** Observe committed Host document endings independently of early native-view detachment. */
    observeHostDocumentEnd(host, onEnd) {
        const dispose = () => {
            host.removeListener('did-navigate', end);
            host.removeListener('destroyed', end);
            host.removeListener('render-process-gone', end);
        };
        const end = () => {
            dispose();
            onEnd();
        };
        host.on('did-navigate', end);
        host.on('destroyed', end);
        host.on('render-process-gone', end);
        return dispose;
    }
    /** Observe the end of a Mini App page document: main-frame navigation, reload, crash or close. */
    observeMiniAppPageEnd(page, onEnd) {
        const onNavigation = (...args) => {
            if (isMainDocumentNavigation(args))
                end();
        };
        const dispose = () => {
            page.removeListener('did-start-navigation', onNavigation);
            page.removeListener('destroyed', end);
            page.removeListener('render-process-gone', end);
        };
        const end = () => {
            dispose();
            onEnd();
        };
        page.on('did-start-navigation', onNavigation);
        page.on('destroyed', end);
        page.on('render-process-gone', end);
        return dispose;
    }
    addHostWindowListener(source, event, listener) {
        source.on(event, listener);
        this.hostWindowDisposers.push(() => {
            try {
                source.removeListener(event, listener);
            }
            catch {
                // Ignore listener cleanup races while the host window is navigating away.
            }
        });
    }
    clearHostWindowListeners() {
        for (const dispose of this.hostWindowDisposers.splice(0)) {
            dispose();
        }
    }
    resolveParentWindow() {
        if (this.hostWindow && !this.hostWindow.isDestroyed())
            return this.hostWindow;
        return windowManager.getWindowByType('archon') || getMainWindow();
    }
    bindWebContentsEvents(tab) {
        const wc = this.getWebContents(tab);
        if (!wc)
            return;
        // WebContentsView mouse events do not bubble to the host document. During
        // a panel drag, route them back instead of hiding/capturing the live page.
        this.addTabListener(tab, wc, 'before-mouse-event', (event, input) => {
            if (this.nativeResizeLeases.size === 0)
                return;
            const host = this.getHostWindow();
            if (this.hasBlockingNativeOverlay() ||
                tab.detachedWindow ||
                tab.bounds.x < 0 ||
                tab.bounds.y < 0 ||
                !host ||
                host.isDestroyed())
                return;
            const renderer = this.hostWebContentsId == null || this.hostWebContentsId === host.webContents.id
                ? host.webContents
                : electronWebContents.fromId(this.hostWebContentsId);
            if (!renderer || renderer.isDestroyed()) {
                this.nativeResizeLeases.clear();
                return;
            }
            const mouse = input;
            event.preventDefault();
            if (mouse.type !== 'mouseMove' && mouse.type !== 'mouseUp')
                return;
            // Both before-mouse-event and sendInputEvent use native view DIP, so no
            // page zoom or host renderer CSS scaling belongs in this translation.
            const nativeView = tab.controller.getNativeViewDiagnostics?.();
            const bounds = nativeView?.hostRelativeBounds ?? nativeView?.actualBounds ?? tab.bounds;
            const offset = this.getHostRendererViewOffset(this.hostWebContentsId ?? undefined);
            renderer.sendInputEvent({
                ...mouse,
                // Electron 42 omits modifiers when serializing WebMouseEvent. Its
                // button still distinguishes mouseDragged from an unpressed move.
                modifiers: mouse.type === 'mouseMove' && mouse.button === 'left' ? ['leftbuttondown'] : [],
                x: Math.round(bounds.x + mouse.x - offset.x),
                y: Math.round(bounds.y + mouse.y - offset.y),
            });
            if (mouse.type === 'mouseUp')
                this.nativeResizeLeases.clear();
        });
        this.addTabListener(tab, wc, 'page-title-updated', () => this.refreshTabState(tab));
        this.addTabListener(tab, wc, 'page-favicon-updated', (_event, favicons) => {
            const faviconUrl = Array.isArray(favicons)
                ? (favicons.map(safeEmbeddedBrowserFaviconUrl).find(Boolean) ?? null)
                : null;
            if (faviconUrl) {
                tab.faviconUrl = faviconUrl;
            }
        });
        if (!tab.miniApp) {
            this.addTabListener(tab, wc, 'will-navigate', (...args) => {
                if (isMainDocumentNavigation(args))
                    this.clearRequestedUrl(tab);
            });
        }
        this.addTabListener(tab, wc, 'did-navigate', (...args) => {
            this.refreshTabState(tab);
            const state = this.navigationDiagnostics.get(tab.tabId);
            const rawUrl = typeof args[1] === 'string' ? args[1] : tab.url;
            const status = typeof args[2] === 'number' ? args[2] : undefined;
            if (state && state.generation === tab.navigationGeneration) {
                state.url = sanitizeBrowserNavigationUrl(rawUrl);
                if (status !== undefined)
                    state.status = status;
            }
        });
        this.addTabListener(tab, wc, 'did-navigate-in-page', () => this.refreshTabState(tab));
        this.addTabListener(tab, wc, 'did-start-navigation', (...args) => {
            if (!isMainDocumentNavigation(args))
                return;
            tab.controller.handleAgentSurfaceNavigationStarted?.();
            void tab.controller.resetAgentCursor?.();
            tab.navigationGeneration = (tab.navigationGeneration ?? 0) + 1;
            const details = asRecord(args[1]);
            const rawUrl = typeof args[1] === 'string' ? args[1] : asString(details.url, tab.url || 'about:blank');
            const diagnosticState = {
                generation: tab.navigationGeneration,
                startedAt: nowMs(),
                url: sanitizeBrowserNavigationUrl(rawUrl),
                userAgent: typeof wc.getUserAgent === 'function' ? wc.getUserAgent().slice(0, 512) : null,
            };
            this.navigationDiagnostics.set(tab.tabId, diagnosticState);
            tab.commentTaskTail = Promise.resolve();
            tab.clearedCommentRevisions?.clear();
            tab.commentClearEpoch = 0;
            tab.processedCommentMessageIds?.clear();
            tab.agentSnapshots?.clear();
            tab.agentSnapshots = undefined;
            // Reloads and same-site navigation may not emit a new favicon event.
            // Keep the current site icon until a replacement arrives.
            try {
                const next = new URL(rawUrl);
                const previous = new URL(tab.url);
                if (next.href !== previous.href &&
                    (next.origin === 'null' || next.origin !== previous.origin)) {
                    delete tab.faviconUrl;
                }
            }
            catch {
                delete tab.faviconUrl;
            }
        });
        this.addTabListener(tab, wc, 'did-finish-load', () => {
            // did-finish-load is Electron's successful main-document completion signal.
            // Clear a failure retained from an earlier navigation only here; clearing on
            // did-start-loading would hide the failure while Chromium renders its
            // internal error page.
            tab.lastLoadError = null;
            this.refreshTabState(tab);
            const diagnosticState = this.navigationDiagnostics.get(tab.tabId);
            if (diagnosticState && diagnosticState.generation === tab.navigationGeneration) {
                const completeNavigation = (challenge) => {
                    const current = this.navigationDiagnostics.get(tab.tabId);
                    if (!current || current.generation !== diagnosticState.generation)
                        return;
                    this.navigationDiagnostics.delete(tab.tabId);
                    const payload = {
                        msg: '[EmbeddedBrowserNavigation] navigation-complete',
                        tabId: tab.tabId,
                        sessionId: tab.sessionId,
                        navigationGeneration: diagnosticState.generation,
                        url: diagnosticState.url,
                        status: diagnosticState.status ?? null,
                        durationMs: Math.max(0, nowMs() - diagnosticState.startedAt),
                        userAgent: diagnosticState.userAgent,
                        outcome: challenge.detected ? 'security-challenge' : 'success',
                        ...(challenge.detected
                            ? {
                                signal: challenge.signal ?? null,
                                requestId: challenge.requestId ?? null,
                            }
                            : {}),
                    };
                    if (challenge.detected) {
                        browserNavigationDiagnosticLogger.warn(payload);
                    }
                    else {
                        browserNavigationDiagnosticLogger.info(payload);
                    }
                };
                void readBrowserSecurityChallengeSummary(wc, tab.title)
                    .then(completeNavigation)
                    .catch(() => completeNavigation({ detected: false }));
            }
            const pageResume = tab.pendingPageResume;
            if (pageResume) {
                delete tab.pendingPageResume;
                void restorePageResume(tab.controller, pageResume).catch((error) => {
                    logger.warn(`[EmbeddedBrowser] page resume failed: ${safeError(error)}`);
                });
            }
            if (!tab.miniApp &&
                (this.isAgentCursorEnabled() || (tab.agentExecutionGlowLeases ?? 0) > 0)) {
                void tab.controller.installAgentCursorBridge?.();
            }
            if (tab.hiddenAt == null && tab.bounds.x >= 0 && tab.bounds.y >= 0) {
                try {
                    wc.invalidate();
                }
                catch {
                    // The view may be torn down between did-finish-load and repaint.
                }
            }
            if (tab.commentModeEnabled || ENABLE_BROWSER_INPUT_DIAGNOSTICS) {
                browserInputDiagnosticLogger.info({
                    msg: '[EmbeddedBrowserInput] page-load',
                    tabId: tab.tabId,
                    sessionId: tab.sessionId,
                    pageHost: urlHost(tab.url),
                    commentModeEnabled: tab.commentModeEnabled,
                    diagnosticsEnabled: ENABLE_BROWSER_INPUT_DIAGNOSTICS,
                });
                void this.installCommentBridge(tab)
                    .then(() => {
                    if (!tab.commentModeEnabled)
                        return;
                    return this.postCommentBridgeMessage(tab, {
                        type: 'set-enabled',
                        enabled: true,
                        selectionMode: tab.commentSelectionMode ?? 'dom_node',
                        theme: tab.commentTheme ?? 'system',
                        ...(tab.commentThemePalette ? { palette: tab.commentThemePalette } : {}),
                        ...(tab.commentPlaceholder ? { placeholder: tab.commentPlaceholder } : {}),
                    });
                })
                    .catch((error) => {
                    logger.warn(`[EmbeddedBrowser] comment bridge reapply failed: ${safeError(error)}`);
                });
            }
        });
        this.addTabListener(tab, wc, 'devtools-opened', () => {
            void tab.controller.hideAgentCursor?.();
        });
        // NOTE: lastLoadError is cleared by explicit navigation actions or a later
        // successful did-finish-load, not by did-start-loading. After a failure,
        // Chromium loads its internal chrome-error page and fires did-start-loading;
        // clearing there would wipe the error before the UI ever saw it.
        this.addTabListener(tab, wc, 'did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            // ERR_ABORTED (-3) covers cancelled/replaced loads; only main-frame
            // failures should surface as the UI error page.
            if (isMainFrame && errorCode !== -3 && errorCode !== 0) {
                tab.lastLoadError = {
                    code: errorCode,
                    description: String(errorDescription ?? ''),
                    url: String(validatedURL ?? ''),
                    ts: nowMs(),
                };
                const diagnosticState = this.navigationDiagnostics.get(tab.tabId);
                if (diagnosticState?.generation === tab.navigationGeneration) {
                    this.navigationDiagnostics.delete(tab.tabId);
                }
                browserNavigationDiagnosticLogger.warn({
                    msg: '[EmbeddedBrowserNavigation] navigation-complete',
                    tabId: tab.tabId,
                    sessionId: tab.sessionId,
                    navigationGeneration: tab.navigationGeneration,
                    url: sanitizeBrowserNavigationUrl(String(validatedURL ?? diagnosticState?.url ?? '')),
                    status: diagnosticState?.status ?? null,
                    userAgent: diagnosticState?.userAgent ??
                        (typeof wc.getUserAgent === 'function' ? wc.getUserAgent().slice(0, 512) : null),
                    outcome: 'load-failed',
                    errorCode,
                    errorDescription: String(errorDescription ?? '').slice(0, 256),
                    durationMs: diagnosticState ? Math.max(0, nowMs() - diagnosticState.startedAt) : null,
                });
            }
        });
    }
    getWebContents(tab) {
        return tab.controller.getWebContents();
    }
    refreshTabState(tab) {
        const state = tab.controller.getState();
        const changed = tab.url !== state.url || tab.title !== state.title;
        tab.url = state.url;
        tab.title = state.title;
        if (changed)
            this.commitTabState(tab);
    }
    clearRequestedUrlForNavigation(tab, nextUrl) {
        if (!tab.requestedUrl || normalizeUrl(tab.requestedUrl) === nextUrl)
            return;
        this.clearRequestedUrl(tab);
    }
    clearRequestedUrl(tab) {
        if (!tab.requestedUrl)
            return;
        delete tab.requestedUrl;
        if (typeof tab.sessionId !== 'string' || typeof tab.persistentTabId !== 'string')
            return;
        this.registry.updateTab(tab.sessionId, tab.persistentTabId, { requestedUrl: null });
    }
    commitTabState(tab) {
        if (typeof tab.sessionId !== 'string' || typeof tab.persistentTabId !== 'string')
            return;
        const persistedSession = this.registry.getSession(tab.sessionId);
        const persistedTab = persistedSession?.tabs.find((item) => item.persistentTabId === tab.persistentTabId);
        const normalizedUrl = normalizePersistedBrowserUrl(tab.url);
        const keepRestorableUrl = normalizedUrl === 'about:blank' && persistedTab && persistedTab.url !== 'about:blank';
        this.registry.updateTab(tab.sessionId, tab.persistentTabId, {
            ...(!keepRestorableUrl && normalizedUrl ? { url: normalizedUrl } : {}),
            title: tab.title,
        });
        // Chromium can temporarily expose an about:blank stack after a failed
        // history restore. Keep both the last restorable URL and its matching
        // persisted history so the next cold open does not prefer a blank stack.
        if (!keepRestorableUrl)
            this.captureNavigationSnapshot(tab, false);
    }
    async installPropsPanel(tab) {
        const script = loadEmbeddedPropsPanelScript();
        if (!script)
            return;
        try {
            const result = await tab.controller.evaluateInIsolatedWorld(EMBEDDED_COMMENT_WORLD_ID, script);
            if (result.success === false) {
                logger.warn({
                    msg: '[EmbeddedBrowserComment] props-panel-install-failed',
                    tabId: tab.tabId,
                    error: asString(result.error).slice(0, 240),
                });
            }
        }
        catch (error) {
            logger.warn({
                msg: '[EmbeddedBrowserComment] props-panel-install-failed',
                tabId: tab.tabId,
                error: String(error).slice(0, 240),
            });
        }
    }
    async installCommentBridge(tab) {
        // The property inspector is optional: annotations keep working without it.
        await this.installPropsPanel(tab);
        const result = await tab.controller.evaluateInIsolatedWorld(EMBEDDED_COMMENT_WORLD_ID, EMBEDDED_COMMENT_BRIDGE_SCRIPT);
        const resultPayload = asRecord(result.result);
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserInput] bridge-install',
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            pageHost: urlHost(tab.url),
            commentModeEnabled: tab.commentModeEnabled,
            success: result.success !== false,
            bridgeVersion: asString(resultPayload.bridgeVersion, 'unknown'),
            error: result.success === false ? asString(result.error).slice(0, 240) : null,
        });
        if (result.success === false) {
            throw new Error(result.error ?? 'Failed to install browser comment bridge');
        }
        logger.info({
            msg: '[EmbeddedBrowserComment] comment-bridge-installed',
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            pageHost: urlHost(tab.url),
            bridgeVersion: asString(asRecord(result.result).bridgeVersion, 'unknown'),
        });
    }
    async postCommentBridgeMessage(tab, message) {
        const result = await tab.controller.evaluateInIsolatedWorld(EMBEDDED_COMMENT_WORLD_ID, `(() => {
        const control = globalThis[${JSON.stringify(EMBEDDED_COMMENT_CONTROL_NAME)}];
        if (typeof control !== 'function') return false;
        return control(${JSON.stringify(message)});
      })()`);
        if (result.success === false) {
            throw new Error(result.error ?? 'Failed to post browser comment bridge message');
        }
    }
    recordCommentClear(tab, keys, revisions) {
        if (!keys) {
            tab.commentClearEpoch = (tab.commentClearEpoch ?? 0) + 1;
            return;
        }
        if (keys.length === 0)
            return;
        tab.clearedCommentRevisions ?? (tab.clearedCommentRevisions = new Map());
        for (const key of keys) {
            const revision = revisions && Object.prototype.hasOwnProperty.call(revisions, key)
                ? (revisions[key] ?? Number.POSITIVE_INFINITY)
                : Number.POSITIVE_INFINITY;
            tab.clearedCommentRevisions.set(key, Math.max(tab.clearedCommentRevisions.get(key) ?? 0, revision));
        }
    }
    isCommentRevisionCleared(tab, payload) {
        const cleared = payload.commentKey
            ? tab.clearedCommentRevisions?.get(payload.commentKey)
            : undefined;
        return cleared !== undefined && (payload.commentRevision ?? 0) <= cleared;
    }
    async handleCommentBridgeMessage(tab, message, generation, clearEpoch) {
        if (message.type === 'diagnostic') {
            this.logBrowserInputDiagnostic(tab, message.payload);
            return {};
        }
        if (message.type === 'ready')
            return {};
        if (message.type === 'props-preference') {
            this.propsPanelExpanded = asRecord(message.payload).expanded === true;
            this.propsPanelPreferenceKnown = true;
            return {};
        }
        if (message.type === 'voice-request') {
            const action = asRecord(message.payload).action;
            if (action !== 'start' && action !== 'stop' && action !== 'cancel')
                return {};
            // The ASR session lives in the app window that owns this tab.
            const host = this.getHostWindow();
            if (host && !host.isDestroyed() && !host.webContents.isDestroyed()) {
                host.webContents.send(IPC_CHANNELS.EMBEDDED_BROWSER_COMMENT_VOICE_REQUEST, {
                    sessionId: tab.sessionId ?? null,
                    tabId: tab.tabId,
                    action,
                });
            }
            return {};
        }
        if (message.type === 'comments-renumbered') {
            const payload = asRecord(message.payload);
            const comments = asCommentRenumberMap(payload.comments);
            if (comments.length === 0)
                return {};
            const event = {
                eventId: this.nextCommentEventId++,
                type: 'comments-renumbered',
                tabId: tab.tabId,
                pageUrl: tab.url,
                comments,
                ts: nowMs(),
            };
            this.enqueueCommentEvent(tab, event);
            return {};
        }
        if (message.type === 'comment-removed') {
            const payload = asRecord(message.payload);
            const commentId = asNumber(payload.commentId);
            if (!commentId)
                return {};
            const commentKey = typeof payload.commentKey === 'string' && payload.commentKey
                ? payload.commentKey.slice(0, 200)
                : null;
            const event = {
                eventId: this.nextCommentEventId++,
                type: 'comment-removed',
                tabId: tab.tabId,
                commentId,
                ...(commentKey ? { commentKey } : {}),
                pageUrl: tab.url,
                ts: nowMs(),
            };
            this.enqueueCommentEvent(tab, event);
            return {};
        }
        const payload = normalizeCommentPayload(message.payload);
        if (!payload) {
            logger.info({
                msg: '[EmbeddedBrowserComment] comment-event-dropped',
                reason: 'invalid-payload',
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                globalActiveTabId: this.activeTabId,
                pageHost: urlHost(tab.url),
            });
            return {};
        }
        if (clearEpoch !== (tab.commentClearEpoch ?? 0) ||
            this.isCommentRevisionCleared(tab, payload)) {
            return { dropped: 'comment-cleared' };
        }
        payload.pageUrl = tab.url;
        const screenshotStartedAt = nowMs();
        const screenshotDataUrl = await this.withTabOperation(tab, 'comment-screenshot', () => this.captureCommentScreenshot(tab, payload));
        const screenshotMs = nowMs() - screenshotStartedAt;
        if (generation !== tab.navigationGeneration)
            return { dropped: 'stale-navigation' };
        if (!tab.commentModeEnabled)
            return { dropped: 'comment-mode-disabled' };
        if (clearEpoch !== (tab.commentClearEpoch ?? 0) ||
            this.isCommentRevisionCleared(tab, payload)) {
            return { dropped: 'comment-cleared' };
        }
        const eventPayload = {
            ...payload,
            ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
        };
        const event = {
            eventId: this.nextCommentEventId++,
            type: 'comment-added',
            tabId: tab.tabId,
            commentId: eventPayload.commentId,
            ...(eventPayload.commentKey ? { commentKey: eventPayload.commentKey } : {}),
            pageUrl: eventPayload.pageUrl,
            payload: eventPayload,
            ts: nowMs(),
        };
        this.enqueueCommentEvent(tab, event, {
            screenshotMs,
            hasScreenshot: Boolean(screenshotDataUrl),
        });
        return {};
    }
    async handleCommentBridgeEvent(sender, envelope) {
        const tab = Array.from(this.tabs.values()).find((candidate) => {
            const webContents = this.getWebContents(candidate);
            return Boolean(sender && webContents && webContents === sender);
        });
        if (!tab)
            return { success: false, error: 'Invalid embedded browser event sender' };
        const message = normalizeCommentBridgeMessage(envelope);
        if (!message)
            return { success: false, error: 'Invalid embedded browser event envelope' };
        let envelopeSize = Number.POSITIVE_INFINITY;
        try {
            envelopeSize = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
        }
        catch {
            // Non-serializable input is not a valid IPC envelope.
        }
        if (envelopeSize > 256 * 1024) {
            return { success: false, error: 'Embedded browser event envelope is too large' };
        }
        tab.navigationGeneration ?? (tab.navigationGeneration = 0);
        const generation = tab.navigationGeneration;
        const clearEpoch = tab.commentClearEpoch ?? 0;
        const messageKey = `${generation}:${message.messageId ?? `unkeyed-${nowMs()}`}`;
        tab.commentTaskTail ?? (tab.commentTaskTail = Promise.resolve());
        tab.inFlightCommentMessages ?? (tab.inFlightCommentMessages = new Map());
        tab.processedCommentMessageIds ?? (tab.processedCommentMessageIds = new Set());
        if (tab.processedCommentMessageIds.has(messageKey)) {
            return { success: true, tabId: tab.tabId, duplicate: true };
        }
        const inFlight = tab.inFlightCommentMessages.get(messageKey);
        if (inFlight)
            return inFlight;
        const task = tab.commentTaskTail
            .catch(() => undefined)
            .then(async () => {
            if (generation !== tab.navigationGeneration) {
                return { success: true, tabId: tab.tabId, dropped: 'stale-navigation' };
            }
            const mutation = message.type === 'comment-added' || message.type === 'comment-removed';
            // A renumber is a notification, not a user mutation. The page emits
            // it synchronously from clear-comments and the trailing event is
            // delivered after the manager has flipped commentModeEnabled to
            // false; accepting the renumber keeps the host's display numbers
            // in sync with whatever survived the selective clear.
            if (mutation && !tab.commentModeEnabled) {
                return { success: false, tabId: tab.tabId, error: 'Browser comment mode is disabled' };
            }
            try {
                this.logCommentBridgeMessage(tab, message, 'preload-ipc');
                const outcome = await this.handleCommentBridgeMessage(tab, message, generation, clearEpoch);
                tab.processedCommentMessageIds.add(messageKey);
                if (tab.processedCommentMessageIds.size > 1000) {
                    tab.processedCommentMessageIds = new Set(Array.from(tab.processedCommentMessageIds).slice(-500));
                }
                return { success: true, tabId: tab.tabId, ...outcome };
            }
            catch (error) {
                logger.warn({
                    msg: '[EmbeddedBrowserComment] preload bridge event failed',
                    tabId: tab.tabId,
                    sessionId: tab.sessionId,
                    pageHost: urlHost(tab.url),
                    error: safeError(error),
                });
                return {
                    success: false,
                    tabId: tab.tabId,
                    error: safeError(error),
                    ...(error instanceof BrowserCommentBackpressureError ? { retryable: true } : {}),
                };
            }
        });
        tab.commentTaskTail = task.then(() => undefined, () => undefined);
        tab.inFlightCommentMessages.set(messageKey, task);
        void task.finally(() => {
            if (tab.inFlightCommentMessages.get(messageKey) === task) {
                tab.inFlightCommentMessages.delete(messageKey);
            }
        });
        return task;
    }
    async handleAgentCursorBridgeEvent(sender, envelope) {
        return handleAgentCursorBridgeEvent({
            sender,
            envelope,
            getTab: (tabId) => {
                const tab = this.tabs.get(tabId);
                return tab?.miniApp ? undefined : tab;
            },
            getWebContents: (tab) => this.getWebContents(tab),
        });
    }
    enqueueCommentEvent(tab, event, extra) {
        if (tab.commentEvents.length >= PENDING_COMMENT_EVENT_LIMIT) {
            logger.error({
                msg: '[EmbeddedBrowserComment] comment-event-dropped',
                reason: 'pending-limit-exceeded',
                eventId: event.eventId,
                type: event.type,
                tabId: tab.tabId,
                sessionId: tab.sessionId,
                pendingCount: tab.commentEvents.length,
                pageHost: urlHost(event.pageUrl ?? tab.url),
            });
            throw new BrowserCommentBackpressureError('Browser comment event backlog is full');
        }
        tab.commentEvents = [...tab.commentEvents, event];
        this.logCommentEventEnqueued(tab, event, extra);
    }
    logCommentEventEnqueued(tab, event, extra) {
        logger.info({
            msg: '[EmbeddedBrowserComment] comment-event-enqueued',
            eventId: event.eventId,
            type: event.type,
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            globalActiveTabId: this.activeTabId,
            commentId: event.commentId ?? null,
            eventCount: tab.commentEvents.length,
            pageHost: urlHost(event.pageUrl ?? tab.url),
            ...(extra?.screenshotMs !== undefined ? { screenshotMs: extra.screenshotMs } : {}),
            ...(extra?.hasScreenshot !== undefined ? { hasScreenshot: extra.hasScreenshot } : {}),
        });
    }
    logCommentEventsCleared(tab, reason, countBefore) {
        if (countBefore === 0)
            return;
        logger.info({
            msg: '[EmbeddedBrowserComment] comment-events-cleared',
            reason,
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            globalActiveTabId: this.activeTabId,
            countBefore,
            pageHost: urlHost(tab.url),
        });
    }
    logCommentBridgeMessage(tab, message, transport) {
        if (message.type === 'diagnostic')
            return;
        const payload = asRecord(message.payload);
        logger.info({
            msg: message.type === 'ready'
                ? '[EmbeddedBrowserComment] comment-bridge-ready'
                : '[EmbeddedBrowserComment] comment-bridge-message',
            type: message.type,
            transport,
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            globalActiveTabId: this.activeTabId,
            commentModeEnabled: tab.commentModeEnabled,
            commentId: asNumber(payload.commentId) ?? null,
            pageHost: urlHost(asString(payload.pageUrl, tab.url)),
            pendingCount: tab.commentEvents.length,
        });
    }
    logBrowserInputDiagnostic(tab, payloadValue) {
        const payload = asRecord(payloadValue);
        const stringField = (key) => typeof payload[key] === 'string' ? String(payload[key]).slice(0, 120) : null;
        const booleanField = (key) => typeof payload[key] === 'boolean' ? Boolean(payload[key]) : null;
        const numberField = (key) => typeof payload[key] === 'number' && Number.isFinite(payload[key])
            ? Number(payload[key])
            : null;
        browserInputDiagnosticLogger.info({
            msg: '[EmbeddedBrowserInput] diagnostic',
            tabId: tab.tabId,
            sessionId: tab.sessionId,
            pageHost: urlHost(tab.url),
            event: stringField('event'),
            bridgeVersion: stringField('bridgeVersion'),
            selectionMode: stringField('selectionMode'),
            interactionState: stringField('interactionState'),
            pointerState: stringField('pointerState'),
            activeTag: stringField('activeTag'),
            activeIsCommentInput: booleanField('activeIsCommentInput'),
            activeIsBridgeUi: booleanField('activeIsBridgeUi'),
            documentHasFocus: booleanField('documentHasFocus'),
            reason: stringField('reason'),
            result: stringField('result'),
            skipReason: stringField('skipReason'),
            eventType: stringField('eventType'),
            listenerPhase: stringField('listenerPhase'),
            controlDetected: booleanField('controlDetected'),
            inputType: stringField('inputType'),
            keyKind: stringField('keyKind'),
            eventPhase: numberField('eventPhase'),
            defaultPrevented: booleanField('defaultPrevented'),
            isComposing: booleanField('isComposing'),
            composing: booleanField('composing'),
            valueLength: numberField('valueLength'),
            relatedTag: stringField('relatedTag'),
            relatedIsBridgeUi: booleanField('relatedIsBridgeUi'),
            targetTag: stringField('targetTag'),
            targetId: stringField('targetId'),
            targetClass: stringField('targetClass'),
            targetInputType: stringField('targetInputType'),
            targetRole: stringField('targetRole'),
            targetDisabled: booleanField('targetDisabled'),
            targetHasPointerCapture: booleanField('targetHasPointerCapture'),
            targetIsCommentInput: booleanField('targetIsCommentInput'),
            targetIsBridgeUi: booleanField('targetIsBridgeUi'),
            commentModeEnabled: booleanField('commentModeEnabled'),
            propagationStopped: booleanField('propagationStopped'),
            button: numberField('button'),
            buttons: numberField('buttons'),
            pointerType: stringField('pointerType'),
            hitTestTag: stringField('hitTestTag'),
            hitTestId: stringField('hitTestId'),
            nearestRangeId: stringField('nearestRangeId'),
            nearestRangeInputType: stringField('nearestRangeInputType'),
            pointerInsideNearestRange: booleanField('pointerInsideNearestRange'),
            nearestRangeDeltaX: numberField('nearestRangeDeltaX'),
            nearestRangeDeltaY: numberField('nearestRangeDeltaY'),
            nearestRangeWidth: numberField('nearestRangeWidth'),
            nearestRangeHeight: numberField('nearestRangeHeight'),
            pageInnerWidth: numberField('pageInnerWidth'),
            pageInnerHeight: numberField('pageInnerHeight'),
            pageDevicePixelRatio: numberField('pageDevicePixelRatio'),
            pageVisualViewportScale: numberField('pageVisualViewportScale'),
            sceneTransform: stringField('sceneTransform'),
            stage: stringField('stage'),
            hostConnected: booleanField('hostConnected'),
            rootAvailable: booleanField('rootAvailable'),
            uiRootConnected: booleanField('uiRootConnected'),
            composerConnected: booleanField('composerConnected'),
            inputConnected: booleanField('inputConnected'),
            composerWidth: numberField('composerWidth'),
            composerHeight: numberField('composerHeight'),
            composerLeft: numberField('composerLeft'),
            composerTop: numberField('composerTop'),
            errorName: stringField('errorName'),
            errorMessage: stringField('errorMessage'),
            selectionKind: stringField('selectionKind'),
            existingComment: booleanField('existingComment'),
            dragged: booleanField('dragged'),
            width: numberField('width'),
            height: numberField('height'),
            pageTs: numberField('ts'),
        });
    }
    logGetStateDiagnostic(input) {
        const resolvedTabId = input.tab?.tabId ?? null;
        const isScoped = input.requestedSessionId !== undefined;
        const activeMismatch = isScoped && resolvedTabId !== this.activeTabId;
        const commentModeEnabled = Boolean(input.tab?.commentModeEnabled);
        if (input.commentEvents.length === 0 && !activeMismatch && !commentModeEnabled)
            return;
        const maxEventId = input.commentEvents.reduce((max, event) => Math.max(max, event.eventId), 0);
        const requestedSessionKey = input.requestedSessionId === undefined
            ? '__legacy__'
            : (input.requestedSessionId ?? '__null__');
        const key = [
            requestedSessionKey,
            resolvedTabId ?? 'none',
            this.activeTabId ?? 'none',
            input.commentEvents.length,
            maxEventId,
            commentModeEnabled ? 'comment-mode' : 'normal',
        ].join(':');
        if (this.lastGetStateDiagnosticKey === key)
            return;
        this.lastGetStateDiagnosticKey = key;
        logger.info({
            msg: '[EmbeddedBrowserComment] get-state',
            requestedSessionId: input.requestedSessionId ?? null,
            scoped: isScoped,
            resolvedTabId,
            resolvedSessionId: input.tab?.sessionId ?? null,
            globalActiveTabId: this.activeTabId,
            activeMismatch,
            commentModeEnabled,
            commentEventCount: input.commentEvents.length,
            maxEventId: maxEventId || null,
            pendingCount: input.tab?.commentEvents.length ?? 0,
            pageHost: urlHost(input.tab?.url),
            durationMs: input.durationMs,
        });
    }
    async captureCommentScreenshot(tab, payload) {
        const wc = this.getWebContents(tab);
        if (!wc || wc.isDestroyed())
            return undefined;
        const padding = 64;
        const viewportWidth = payload.viewport.width || tab.bounds.width;
        const viewportHeight = payload.viewport.height || tab.bounds.height;
        const x = Math.max(0, Math.floor(payload.rect.x - padding));
        const y = Math.max(0, Math.floor(payload.rect.y - padding));
        const width = Math.min(viewportWidth - x, Math.ceil(payload.rect.width + padding * 2));
        const height = Math.min(viewportHeight - y, Math.ceil(payload.rect.height + padding * 2));
        if (width <= 0 || height <= 0)
            return undefined;
        try {
            // Read the already composed WebContents surface. Asking CDP to force a
            // fresh Page.captureScreenshot frame here can visibly flash GPU-heavy pages.
            const captureRect = tab.controller.toCapturePageRect({ x, y, width, height });
            const image = await withAgentCursorHiddenForCapture(tab, () => wc.capturePage(captureRect));
            return image.isEmpty()
                ? undefined
                : `data:image/png;base64,${image.toPNG().toString('base64')}`;
        }
        catch (error) {
            logger.warn(`[EmbeddedBrowser] browser comment screenshot failed: ${safeError(error)}`);
            return undefined;
        }
    }
    resolveBrowserTab(target, options = {}) {
        const normalized = normalizeBrowserTarget(target);
        if (typeof normalized.tabId === 'number') {
            const tab = this.tabs.get(normalized.tabId) ?? null;
            if (tab && typeof normalized.sessionId === 'string') {
                assertBrowserTabBelongsToSession(tab, normalized.sessionId);
            }
            return tab;
        }
        if (typeof normalized.sessionId === 'string') {
            return this.resolveSelectedTabBySession(normalized.sessionId);
        }
        return options.allowLegacyActive ? this.getActiveTab() : null;
    }
    async requireBrowserTab(target, options = {}) {
        const normalized = normalizeBrowserTarget(target);
        if (normalized.tabId === undefined) {
            const pending = this.ensuringSessionTabs.get(normalized.sessionId ?? null);
            if (pending)
                return pending;
        }
        const existing = this.resolveBrowserTab(normalized, {
            allowLegacyActive: options.allowLegacyActive,
        });
        if (existing)
            return existing;
        if (typeof normalized.tabId === 'number') {
            const resumed = await this.resumeSuspendedTab(normalized.tabId, normalized.sessionId);
            if (resumed)
                return resumed;
            throw new Error(`Embedded browser tab not found: tabId=${normalized.tabId}`);
        }
        if (typeof normalized.sessionId === 'string') {
            const selectedTabId = this.sessions.get(normalized.sessionId)?.selectedTabId;
            if (typeof selectedTabId === 'number' && this.suspendedTabs.has(selectedTabId)) {
                const resumed = await this.resumeSuspendedTab(selectedTabId, normalized.sessionId);
                if (resumed)
                    return resumed;
            }
        }
        if (!options.createIfMissing) {
            throw new Error('No embedded tab is available');
        }
        const sessionId = typeof normalized.sessionId === 'string' ? normalized.sessionId : null;
        const persisted = sessionId ? this.registry.getSelectedTab(sessionId) : null;
        if (sessionId &&
            persisted &&
            this.coldResumeSnapshots.has(this.coldResumeKey({
                sessionId,
                persistentTabId: persisted.persistentTabId,
            }))) {
            return this.ensureSessionTabCreation(sessionId, () => this.openPersistedOrBlankTab({
                active: true,
                bounds: options.bounds ?? OFFSCREEN_BOUNDS,
                sessionId,
            }));
        }
        return this.ensureSessionTabCreation(sessionId, () => this.openTab({
            active: true,
            bounds: options.bounds ?? OFFSCREEN_BOUNDS,
            sessionId,
            ...(persisted ? { persistentTabId: persisted.persistentTabId } : {}),
        }));
    }
    resolveSelectedTabBySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session?.selectedTabId !== null && session?.selectedTabId !== undefined) {
            const selected = this.tabs.get(session.selectedTabId);
            if (selected?.sessionId === sessionId && !this.isUncommittedMiniAppTab(selected)) {
                return selected;
            }
            if (this.suspendedTabs.get(session.selectedTabId)?.sessionId === sessionId)
                return null;
        }
        for (const tab of this.tabs.values()) {
            if (tab.sessionId !== sessionId || this.isUncommittedMiniAppTab(tab))
                continue;
            this.attachTabToSession(tab);
            const nextSession = this.getOrCreateSession(sessionId);
            if (nextSession.selectedTabId === null)
                nextSession.selectedTabId = tab.tabId;
            return tab;
        }
        return null;
    }
    resolveOrdinaryTabBySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            for (const tabId of session.tabIds) {
                const tab = this.tabs.get(tabId);
                if (tab?.sessionId === sessionId && !tab.miniApp)
                    return tab;
            }
        }
        return (Array.from(this.tabs.values()).find((tab) => tab.sessionId === sessionId && !tab.miniApp) ??
            null);
    }
    async ensureAgentBrowserTab(sessionId) {
        const pending = this.ensuringSessionTabs.get(sessionId);
        if (pending)
            return pending;
        const selected = this.resolveSelectedTabBySession(sessionId);
        if (selected)
            return selected;
        const selectedTabId = this.sessions.get(sessionId)?.selectedTabId;
        if (typeof selectedTabId === 'number' &&
            this.suspendedTabs.get(selectedTabId)?.sessionId === sessionId) {
            return this.requireBrowserTab({ sessionId, tabId: selectedTabId });
        }
        const ordinary = this.resolveOrdinaryTabBySession(sessionId);
        if (ordinary) {
            this.markTabSessionSelected(ordinary);
            return ordinary;
        }
        return this.ensureSessionTabCreation(sessionId, () => this.openTab({
            active: false,
            bounds: OFFSCREEN_BOUNDS,
            sessionId,
            selectInSession: true,
        }));
    }
    resolveTabBySession(sessionId) {
        if (typeof sessionId === 'string')
            return this.resolveSelectedTabBySession(sessionId);
        if (sessionId === undefined)
            return null;
        for (const tab of this.tabs.values()) {
            if (tab.sessionId === null)
                return tab;
        }
        return null;
    }
    addTabListener(tab, source, event, listener) {
        source.on(event, listener);
        tab.disposers.push(() => source.removeListener(event, listener));
    }
    resolveTab(args) {
        return this.resolveBrowserTab(args, { allowLegacyActive: true });
    }
    async executeAgentTool(sessionId, tool, rawArgs, signal) {
        // Agent tool routing trusts the runtime-owned session, never model-provided
        // target fields in rawArgs. Keep the preview/action lease on that same tab.
        if (!AGENT_BROWSER_ACTIONS.has(tool)) {
            throw new Error(`Unsupported Agent browser action: ${tool}`);
        }
        if (tool === 'open_tab') {
            return this.runWithAgentToolScope(() => this.openAgentTab(sessionId, rawArgs, signal));
        }
        const tab = await this.ensureAgentBrowserTab(sessionId);
        if (tool === 'navigate' &&
            hasLoadedBrowserPage(tab.url) &&
            rawArgs.replaceCurrentTab !== true) {
            throw new Error('CURRENT_TAB_OCCUPIED: Current Browser tab already has a loaded page; retry with open_tab');
        }
        // The Electron provider owns this visible loaded-tab guard. Browser Core
        // remains provider-neutral and performs navigation after this host policy check.
        const trustedArgs = tool === 'navigate'
            ? Object.fromEntries(Object.entries(rawArgs).filter(([key]) => key !== 'replaceCurrentTab'))
            : rawArgs;
        const execute = () => this.toolRuntime.executeAgentTool({ sessionId, tabId: tab.tabId }, tool, trustedArgs, signal);
        return this.runWithAgentToolScope(() => executeWithAgentExecutionGlow(tab, () => executeWithAgentCursorLease(tab, execute, {
            hideBeforeAction: tool === 'navigate' ||
                tool === 'back' ||
                tool === 'forward' ||
                tool === 'reload' ||
                tool === 'drag' ||
                tool === 'scroll',
        })));
    }
    async openAgentTab(sessionId, rawArgs, signal) {
        const trustedSessionId = sessionId.trim();
        if (!trustedSessionId)
            throw new Error('Browser tool requires an active session');
        if (signal?.aborted)
            throw new Error('Operation aborted');
        const url = asString(rawArgs.url).trim();
        if (!url)
            throw new Error('url is required');
        const selectedTab = this.resolveSelectedTabBySession(trustedSessionId);
        const previousTab = selectedTab && !selectedTab.miniApp
            ? selectedTab
            : this.resolveOrdinaryTabBySession(trustedSessionId);
        const previousBounds = previousTab &&
            previousTab.hiddenAt == null &&
            previousTab.bounds.x >= 0 &&
            previousTab.bounds.y >= 0
            ? previousTab.bounds
            : null;
        let openedTab = null;
        const rollbackOpenedTab = () => {
            const failedTab = openedTab;
            openedTab = null;
            if (failedTab && this.tabs.has(failedTab.tabId)) {
                this.destroyTab(failedTab, 'explicit');
            }
            if (previousTab && this.tabs.has(previousTab.tabId)) {
                this.markTabSessionSelected(previousTab);
            }
        };
        try {
            openedTab = await this.openTab({
                active: false,
                bounds: OFFSCREEN_BOUNDS,
                sessionId: trustedSessionId,
            });
            // Keep the staged page unselected until navigation succeeds. Publishing
            // it early lets the renderer request `show`, which promotes the hidden
            // page and cancels its in-flight background render operation.
            const navigation = asRecord(await this.toolRuntime.navigateAgentTab(openedTab, url, signal));
            if (signal?.aborted)
                throw new Error('Operation aborted');
            if (navigation.success === false) {
                const failedNavigation = {
                    ...navigation,
                    previousTabId: previousTab?.tabId ?? null,
                    openedInNewTab: false,
                };
                rollbackOpenedTab();
                return failedNavigation;
            }
            if (previousBounds) {
                const shown = await this.show(previousBounds, {
                    sessionId: trustedSessionId,
                    tabId: openedTab.tabId,
                });
                if (shown.success === false) {
                    throw new Error(asString(shown.error, 'Failed to show the new Browser tab'));
                }
            }
            else {
                this.markTabSessionSelected(openedTab);
            }
            return {
                ...navigation,
                tabId: openedTab.tabId,
                previousTabId: previousTab?.tabId ?? null,
                openedInNewTab: true,
            };
        }
        catch (error) {
            rollbackOpenedTab();
            throw error;
        }
    }
    async runWithAgentToolScope(execute) {
        this.agentToolCallDepth += 1;
        try {
            return await execute();
        }
        finally {
            this.agentToolCallDepth = Math.max(0, this.agentToolCallDepth - 1);
        }
    }
    async executeTool(tool, rawArgs, signal) {
        return this.runWithAgentToolScope(() => this.toolRuntime.executeTool(tool, rawArgs, signal));
    }
    tabSummary(tab) {
        this.refreshTabState(tab);
        const state = tab.controller.getState();
        if (tab.miniApp) {
            return {
                ...this.miniAppTabSummary(tab),
                persistentTabId: null,
                active: tab.tabId === this.activeTabId,
                canGoBack: false,
                canGoForward: false,
                isLoading: state.isLoading,
                annotationEnabled: tab.commentModeEnabled,
                zoomFactor: tab.controller.getZoomFactor(),
                devicePreviewMode: tab.controller.getDevicePreviewMode(),
                lastLoadError: tab.lastLoadError
                    ? {
                        code: tab.lastLoadError.code,
                        description: 'Mini App failed to load',
                        url: '',
                        ts: tab.lastLoadError.ts,
                    }
                    : null,
            };
        }
        return {
            tabId: tab.tabId,
            persistentTabId: tab.persistentTabId,
            url: tab.url,
            ...(tab.requestedUrl ? { requestedUrl: tab.requestedUrl } : {}),
            title: tab.title,
            ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
            active: tab.tabId === this.activeTabId,
            canGoBack: state.canGoBack,
            canGoForward: state.canGoForward,
            isLoading: state.isLoading,
            annotationEnabled: tab.commentModeEnabled,
            zoomFactor: tab.controller.getZoomFactor(),
            devicePreviewMode: tab.controller.getDevicePreviewMode(),
            devicePreviewState: tab.controller.getDevicePreviewState(),
            lastLoadError: tab.lastLoadError,
        };
    }
    miniAppTabSummary(tab) {
        const miniApp = tab.miniApp;
        if (!miniApp)
            throw new Error('Embedded tab is not a Mini App surface');
        return {
            tabId: tab.tabId,
            title: miniApp.miniApp.displayName ?? miniApp.miniApp.pluginId,
            surfaceKind: 'miniapp',
            miniApp: miniApp.miniApp,
            detached: tab.detachedWindow !== undefined,
            presentationRevision: tab.presentationRevision,
        };
    }
    suspendedTabSummary(tab) {
        return {
            tabId: tab.tabId,
            persistentTabId: tab.persistentTabId,
            url: tab.url,
            ...(tab.requestedUrl ? { requestedUrl: tab.requestedUrl } : {}),
            title: tab.title,
            ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
            active: false,
            canGoBack: false,
            canGoForward: false,
            isLoading: false,
            annotationEnabled: false,
            zoomFactor: tab.zoomFactor,
            devicePreviewMode: tab.devicePreviewMode,
            devicePreviewState: tab.devicePreviewState,
            lastLoadError: tab.lastLoadError,
            suspended: true,
        };
    }
}

function miniAppTargetKey(sessionId, pluginId) {
    return `${sessionId}\u0000${pluginId}`;
}
/** An inline tab currently painted in the File Panel (a detached window never is). */
function isShownInPanel(tab) {
    return !tab.detachedWindow && tab.hiddenAt == null && tab.bounds.x >= 0 && tab.bounds.y >= 0;
}
function miniAppTabNotFoundError() {
    return Object.assign(new Error('Mini App tab was not found'), { code: 'not_found' });
}
function assertMiniAppGenerationCurrent(isGenerationCurrent) {
    if (!isGenerationCurrent)
        return;
    let current = false;
    try {
        current = isGenerationCurrent();
    }
    catch {
        // A broken liveness probe cannot authorize a native surface commit.
    }
    if (!current) {
        throw Object.assign(new Error('Mini App Utility generation is unavailable'), {
            code: 'runtime_unavailable',
        });
    }
}
function miniAppNavigationOptions(callerSignal, operationSignal) {
    const signal = callerSignal && operationSignal
        ? AbortSignal.any([callerSignal, operationSignal])
        : (callerSignal ?? operationSignal);
    return signal ? { signal } : undefined;
}
function assertMiniAppNavigationSucceeded(result) {
    const payload = asRecord(result);
    if (payload.success !== false)
        return;
    throw new Error(`Mini App navigation failed: ${safeError(payload.error ?? 'unknown error')}`);
}
function hasLoadedBrowserPage(url) {
    const normalized = url.trim().toLowerCase();
    return normalized.length > 0 && !normalized.startsWith('about:blank');
}
let embeddedBrowserManager = null;
export function getEmbeddedBrowserManager() {
    if (!embeddedBrowserManager) {
        embeddedBrowserManager = new EmbeddedBrowserManager({
            registry: createPersistentBrowserRegistry(),
            isAgentCursorEnabled: () => getConfig().beta.browserAgentCursor === true,
        });
    }
    return embeddedBrowserManager;
}
/** Revokes managed Mini App tabs without instantiating the Browser owner. */
export function destroyAllManagedMiniAppTabs() {
    return embeddedBrowserManager?.destroyAllMiniAppTabs() ?? [];
}
/** Closes one plugin's managed tabs without instantiating the Browser owner. */
export function destroyManagedMiniAppTabs(pluginId) {
    return embeddedBrowserManager?.destroyMiniAppTabs(pluginId) ?? [];
}
/** Rotates one plugin's tab credentials without instantiating the Browser owner. */
export function syncManagedMiniAppLoopbackCredential(pluginId, credential) {
    embeddedBrowserManager?.syncMiniAppLoopbackCredential(pluginId, credential);
}
export async function openEmbeddedBrowserExternally(target) {
    const state = getEmbeddedBrowserManager().getState(target);
    const tabs = state.tabs;
    const activeTab = tabs.find((tab) => tab.tabId === state.selectedTabId) ?? tabs[0];
    const url = activeTab?.url;
    if (url && url !== 'about:blank') {
        await openExternalTarget(url);
        return { success: true, url };
    }
    return { success: false, error: 'No navigated embedded browser tab' };
}
