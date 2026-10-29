/**
 * Browser Controller
 * 控制嵌入式浏览器窗口的核心模块
 * 作为方法入口，调用 BrowserActions 子模块
 */
import path from "node:path";
import { cloneBrowserDevicePreviewState } from "@mavis/shared/browser-device-preview";
import { MINIAPP_SURFACE_ID_ARGUMENT_PREFIX } from "@mavis/shared/miniapp-surface";
import { matchesEmbeddedBrowserShortcutAction, forwardEmbeddedBrowserHostShortcut } from "./embedded-browser-host-shortcut";
import { WebContentsView } from "electron";
import { BrowserActions } from "./browser-actions";
import { DevicePreviewController } from "./device-preview-controller";
import { DevicePreviewWindow } from "./device-preview-window";
import { AgentCursorController } from "./agent-cursor-controller";
import { AGENT_CURSOR_WORLD_ID, AGENT_CURSOR_BRIDGE_SCRIPT } from "./agent-cursor-bridge";
export let EMBEDDED_BROWSER_PARTITION = 'persist:mavis-browser';
/**
 * Electron's own default for a `WebContentsView` created with no explicit
 * background — opaque white. Exported so every call site that restores the
 * view after a transparent pop-out shares this literal instead of duplicating it.
 */
export let DEFAULT_VIEW_BACKGROUND = '#ffffffff';
/** Mini App pages get their own storage and the only webRequest hook that adds loopback auth. */
export let MINIAPP_BROWSER_PARTITION = 'persist:mavis-miniapp';
function boundsEqual(left, right) {
    return (left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height);
}
/**
 * 浏览器控制器
 * 管理嵌入式 WebContentsView 并提供各种操作方法
 *
 * WebContentsView 是 Electron 30+ 推荐使用的替代 BrowserView 的方案
 * 通过 window.contentView.addChildView() 添加到窗口中
 */
export class BrowserController {
    constructor(options = {}) {
        this.options = options;
        this.webContentsView = null;
        this.previewWindow = null;
        this.previewLayout = null;
        this.parentWindow = null;
        /**
         * File Panel host that owns shortcut routing. Unlike parentWindow it does not
         * follow temporary reparenting into a background render or detached window.
         */
        this.shortcutHostWindow = null;
        /**
         * Wired by the manager while this Mini App page owns a detached window.
         * Cmd/Ctrl+W in that state returns the page to the panel instead of
         * forwarding to the File Panel host or falling through to the app menu's
         * `role: 'close'`, which would otherwise close the main window.
         */
        this.onRequestCloseDetached = null;
        this.bounds = {
            x: 0,
            y: 0,
            width: 800,
            height: 600,
        };
        this.deferredInitialization = null;
        this.agentCursorEnabled = () => true;
        this.agentCursorIdentity = () => null;
        this.agentCursorVisible = () => false;
        this.agentCursorDiagnose = () => undefined;
        this.agentExecutionGlowActive = false;
        this.agentSurfaceBridgeReady = false;
        this.browserActions = new BrowserActions();
        this.devicePreviewController = new DevicePreviewController(() => this.browserActions.getCDPHelper());
        this.browserActions.setInputCoordinateScaleProvider?.(() => this.devicePreviewController.getDisplayScale());
        this.agentCursorController = new AgentCursorController({
            evaluate: async (script) => {
                const installed = await this.ensureAgentSurfaceBridge();
                if (!installed) {
                    return { success: false, result: null, error: 'Agent surface bridge unavailable' };
                }
                return this.evaluateInIsolatedWorld(AGENT_CURSOR_WORLD_ID, script);
            },
            isEnabled: () => this.agentCursorEnabled(),
            isVisible: () => this.agentCursorVisible(),
            identity: () => this.agentCursorIdentity(),
            diagnose: (reason) => this.agentCursorDiagnose(reason),
        });
        this.browserActions.setAgentCursor?.(this.agentCursorController);
    }
    /**
     * 获取 WebContents
     */
    get webContents() {
        const wc = this.webContentsView?.webContents;
        if (!wc || wc.isDestroyed?.())
            return null;
        return wc;
    }
    /**
     * 检查 contentView 是否可用（窗口和 contentView 都未被销毁）
     */
    getContentView(window) {
        if (!window || window.isDestroyed() || !window.contentView) {
            return null;
        }
        return window.contentView;
    }
    get contentView() {
        return this.getContentView(this.parentWindow);
    }
    /**
     * 安全地从 contentView 中移除 view
     */
    safeRemoveFromContentView(view, parentWindow = this.parentWindow) {
        const cv = this.getContentView(parentWindow);
        if (!cv)
            return;
        try {
            if (!cv.children?.includes(view))
                return;
            cv.removeChildView(view);
        }
        catch {
            // 可能已不在 children 中
        }
    }
    /**
     * 安全地将 view 添加到 contentView
     */
    safeAddToContentView(view, parentWindow = this.parentWindow) {
        const cv = this.getContentView(parentWindow);
        if (!cv)
            return;
        try {
            if (cv.children?.includes(view))
                return;
            cv.addChildView(view);
        }
        catch {
            // Ignore races while Electron is moving/destroying native child views.
        }
    }
    /**
     * 创建浏览器视图
     */
    async create(parentWindow, bounds, options = {}) {
        try {
            if (this.webContentsView) {
                this.destroy();
            }
            this.devicePreviewController.reset();
            this.parentWindow = parentWindow;
            this.shortcutHostWindow = parentWindow;
            this.bounds = bounds;
            const partition = options.surfaceKind === 'miniapp' ? MINIAPP_BROWSER_PARTITION : EMBEDDED_BROWSER_PARTITION;
            this.webContentsView = new WebContentsView({
                webPreferences: {
                    partition,
                    nodeIntegration: false,
                    nodeIntegrationInSubFrames: false,
                    contextIsolation: true,
                    autoplayPolicy: 'user-gesture-required',
                    sandbox: true,
                    webSecurity: true,
                    // Electron 暴露了 FedCM API，但没有 Chrome 的账号选择界面；关闭后让身份提供方
                    // 在内嵌浏览器中回退到 popup / redirect 登录流程。
                    disableBlinkFeatures: 'FedCm',
                    // 允许隐藏/后台页面被 Chromium 节流；自动化操作期间由 manager 临时关闭。
                    backgroundThrottling: true,
                    preload: path.join(__dirname, options.surfaceKind === 'miniapp' ? 'miniapp-preload.bundle.js' : 'preload.js'),
                    // Fixed at WebContents creation; the page reads it synchronously as
                    // `window.mcode.miniapp.window.id`. The WebContents is never rebuilt, so the
                    // id survives pop-out and return.
                    ...(options.surfaceKind === 'miniapp' && options.miniAppSurfaceId
                        ? {
                            additionalArguments: [
                                `${MINIAPP_SURFACE_ID_ARGUMENT_PREFIX}${options.miniAppSurfaceId}`,
                            ],
                        }
                        : {}),
                },
            });
            // Normal creation loads a blank page for Windows initialization.
            // NavigationHistory.restore() is only legal before the first load, so
            // cold-history restoration explicitly skips this bootstrap navigation.
            if (options.skipInitialLoad === true) {
                // Electron 42 RestoreHistory copies only the UA string into an override,
                // losing native UA-CH. Clear it before restore so both remain native.
                this.webContentsView.webContents.setUserAgent('');
            }
            else {
                await this.webContentsView.webContents.loadURL('about:blank');
            }
            // 默认静音
            this.webContentsView.webContents.setAudioMuted(true);
            // 仅在初始 bounds 在屏时挂载到窗口；离屏创建（隐藏态）保持未挂载，
            // 之后 setBounds 把它移到屏内时再挂载，避免隐藏视图截获窗口事件。
            if (bounds.x >= 0 && bounds.y >= 0) {
                parentWindow.contentView.addChildView(this.webContentsView);
            }
            // 设置边界
            this.webContentsView.setBounds(bounds);
            // 设置事件监听
            this.setupEventListeners(options.onOpenTab, partition);
            const initialization = {
                mode: options.devicePreviewMode ?? 'responsive',
                ...(options.devicePreviewState
                    ? { previewState: cloneBrowserDevicePreviewState(options.devicePreviewState) }
                    : {}),
            };
            if (options.skipInitialLoad === true) {
                this.deferredInitialization = initialization;
            }
            else {
                // 初始化子模块；诊断监听在后台自愈，不阻塞 Browser Tab 创建。
                await this.initializeSubModules(initialization.mode, initialization.previewState);
            }
            return { success: true };
        }
        catch (error) {
            // create() can fail after WebContentsView already allocated a renderer.
            // Always tear down the partial controller so failed initialization does
            // not leave an untracked renderer or compositor surface behind.
            this.destroy();
            return { success: false, error: String(error) };
        }
    }
    async completeDeferredInitialization() {
        if (!this.deferredInitialization)
            return;
        await this.initializeSubModules(this.deferredInitialization.mode, this.deferredInitialization.previewState);
        this.deferredInitialization = null;
    }
    /**
     * 初始化子模块
     */
    async initializeSubModules(devicePreviewMode, previewState) {
        const wc = this.webContents;
        if (!wc)
            return;
        // 初始化 Browser Actions（内部会创建 CDPHelper）
        this.browserActions.setWebContents(wc);
        this.browserActions.setBounds(this.bounds);
        // Ordinary pages and popups keep Electron/Chromium native UA and UA-CH.
        // Only explicit device preview may override them; about:blank has no UA-CH.
        const cdpHelper = this.browserActions.getCDPHelper();
        await this.devicePreviewController.setDisplayBounds(this.bounds);
        if (cdpHelper) {
            // Apply the initial viewport without reloading a restored history entry.
            if (!previewState?.enabled)
                await this.devicePreviewController.setMode(devicePreviewMode);
            if (previewState)
                await this.devicePreviewController.restorePreviewState(previewState);
            this.syncDevicePreviewBorderRadius();
        }
        // DOM / Console / Network 属于可选诊断能力，不阻塞 Browser Tab 创建。
        this.browserActions.startDOMListener();
    }
    /**
     * 销毁浏览器视图
     */
    destroy() {
        try {
            this.agentExecutionGlowActive = false;
            this.agentSurfaceBridgeReady = false;
            void this.agentCursorController.reset();
            this.devicePreviewController.reset();
            this.deferredInitialization = null;
            this.releasePreviewWindow();
            this.previewLayout = null;
            // 停止 DOM 监听
            this.browserActions.stopDOMListener();
            // 断开 CDP（通过 BrowserActions）
            const cdpHelper = this.browserActions.getCDPHelper();
            if (cdpHelper) {
                cdpHelper.detach();
            }
            // 清空元素映射
            this.browserActions.getElementMapManager().clear();
            if (this.webContentsView) {
                this.safeRemoveFromContentView(this.webContentsView);
                // 销毁 webContents，释放 renderer 进程和关联的 IOSurface buffer。
                // 仅 removeChildView + 置空引用不会让 Chromium 真正回收资源，
                // 浏览器自动化任务频繁创建/销毁 controller 时会让 WindowServer 累积 GPU compositor 内存。
                try {
                    if (!this.webContentsView.webContents.isDestroyed()) {
                        this.webContentsView.webContents.close();
                    }
                }
                catch {
                    // ignore: webContents 在 close 过程中可能已被销毁
                }
                this.webContentsView = null;
            }
            // 清空 Browser Actions 的引用
            this.browserActions.setWebContents(null);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    }
    /**
     * 更新边界
     */
    setBounds(bounds, previewLayout) {
        if (!this.webContentsView || !this.contentView)
            return Promise.resolve();
        if (previewLayout !== undefined)
            this.previewLayout = previewLayout;
        if (this.previewWindow || (this.previewLayout && this.getDevicePreviewState().enabled)) {
            this.bounds = bounds;
            this.browserActions.setBounds(bounds);
            const hidden = bounds.x < 0 || bounds.y < 0;
            if (hidden) {
                this.previewWindow?.hide();
                this.safeRemoveFromContentView(this.webContentsView);
                return Promise.resolve();
            }
            this.syncPreviewPresentation();
            return this.devicePreviewController
                .setDisplayBounds(this.previewLayout?.available ?? bounds, this.previewLayout?.hostZoomFactor ?? 1)
                .then(() => this.syncPreviewPresentation());
        }
        const wasHidden = this.bounds.x < 0 || this.bounds.y < 0;
        const shouldHide = bounds.x < 0 || bounds.y < 0;
        const expectedBoundsMatch = boundsEqual(this.bounds, bounds);
        let actualBoundsMatch = expectedBoundsMatch;
        try {
            actualBoundsMatch = boundsEqual(this.webContentsView.getBounds(), bounds);
        }
        catch {
            // Older/mocked WebContentsView implementations may not expose getBounds.
        }
        this.bounds = bounds;
        if (shouldHide === wasHidden && expectedBoundsMatch && actualBoundsMatch) {
            this.browserActions.setBounds(bounds);
            return Promise.resolve();
        }
        if (shouldHide !== wasHidden) {
            if (shouldHide) {
                this.safeRemoveFromContentView(this.webContentsView);
            }
            else {
                this.safeRemoveFromContentView(this.webContentsView);
                this.safeAddToContentView(this.webContentsView);
            }
        }
        this.webContentsView.setBounds(bounds);
        // 更新 Browser Actions 的边界
        this.browserActions.setBounds(bounds);
        if (!shouldHide) {
            return this.devicePreviewController.setDisplayBounds(bounds).catch(() => {
                // A scale-only refresh is best-effort. Mode transitions and Agent
                // resets still go through the strict awaited controller path.
            });
        }
        return Promise.resolve();
    }
    getNativeViewDiagnostics() {
        const view = this.webContentsView;
        const previewHost = this.previewWindow?.window;
        const livePreviewHost = previewHost && !previewHost.isDestroyed() ? previewHost : null;
        const contentView = livePreviewHost?.contentView ?? this.contentView;
        if (!view) {
            return {
                actualBounds: null,
                parentWindowId: this.parentWindow?.id ?? null,
                attached: false,
            };
        }
        let actualBounds = null;
        try {
            actualBounds = view.getBounds();
        }
        catch {
            // The native view can disappear while Electron is tearing down its host.
        }
        const previewBounds = livePreviewHost?.getContentBounds();
        const hostBounds = previewBounds && this.parentWindow && !this.parentWindow.isDestroyed()
            ? this.parentWindow.getContentBounds()
            : null;
        return {
            actualBounds,
            ...(actualBounds && previewBounds && hostBounds
                ? {
                    hostRelativeBounds: {
                        ...actualBounds,
                        x: previewBounds.x - hostBounds.x + actualBounds.x,
                        y: previewBounds.y - hostBounds.y + actualBounds.y,
                    },
                }
                : {}),
            parentWindowId: this.parentWindow?.id ?? null,
            attached: Array.isArray(contentView?.children) ? contentView.children.includes(view) : null,
        };
    }
    /** Preserve native DIP rounding when a fixed preview is replaced by a DOM image. */
    getDevicePreviewFrameBounds() {
        if (!this.previewWindow || !this.previewLayout || this.parentWindow !== this.shortcutHostWindow)
            return null;
        const bounds = this.getNativeViewDiagnostics().hostRelativeBounds;
        if (!bounds)
            return null;
        const zoom = this.previewLayout.hostZoomFactor;
        return {
            x: bounds.x / zoom,
            y: bounds.y / zoom,
            width: bounds.width / zoom,
            height: bounds.height / zoom,
        };
    }
    /**
     * 将 view 移动到 contentView 的最上层
     */
    bringToFront() {
        if (!this.webContentsView || !this.contentView)
            return;
        if (this.previewWindow) {
            // The preview stays attached while hidden. Restore it without taking
            // focus from the host toolbar or dismissing its newly opened picker.
            this.syncPreviewPresentation();
            return;
        }
        this.safeRemoveFromContentView(this.webContentsView);
        this.safeAddToContentView(this.webContentsView);
        // macOS 会在原生 View 重新挂载时清掉页面焦点。若不恢复，落在跨域
        // iframe 内的第一次点击只会重新聚焦 WebContents，无法携带打开 OAuth
        // popup 所需的瞬时用户激活，表现为 Google 登录按钮无响应。
        try {
            // Selecting a tab from a native child menu must update the live page
            // without stealing focus and dismissing that menu.
            const childHasFocus = this.parentWindow?.getChildWindows().some((child) => child.isFocused());
            if (!childHasFocus)
                this.webContents?.focus();
        }
        catch {
            // Ignore races while the WebContents is being closed or reparented.
        }
    }
    /**
     * 从父窗口中移除 view（但不销毁）
     */
    removeFromParent() {
        if (!this.webContentsView)
            return;
        this.previewWindow?.hide();
        this.safeRemoveFromContentView(this.webContentsView);
    }
    /**
     * Reparent the existing WebContentsView and attach it with explicit positive
     * bounds. Background rendering uses this path because an offscreen controller
     * must become compositor-backed without being presented in the FilePanel UI.
     */
    attachToParent(parentWindow, bounds) {
        if (!this.webContentsView ||
            !parentWindow ||
            parentWindow.isDestroyed() ||
            !parentWindow.contentView) {
            return;
        }
        const previousParentWindow = this.parentWindow;
        if (previousParentWindow && previousParentWindow !== parentWindow) {
            this.safeRemoveFromContentView(this.webContentsView, previousParentWindow);
        }
        this.releasePreviewWindow();
        this.parentWindow = parentWindow;
        const preview = this.getDevicePreviewState();
        const scale = this.devicePreviewController.getDisplayScale();
        const pageBounds = preview.enabled && preview.viewport
            ? {
                ...bounds,
                width: Math.max(1, Math.round(preview.viewport.width * scale)),
                height: Math.max(1, Math.round(preview.viewport.height * scale)),
            }
            : bounds;
        this.bounds = pageBounds;
        this.safeRemoveFromContentView(this.webContentsView, parentWindow);
        this.safeAddToContentView(this.webContentsView, parentWindow);
        this.webContentsView.setBounds(pageBounds);
        this.browserActions.setBounds(pageBounds);
    }
    /**
     * 将 view 添加到父窗口中
     */
    addToParent(parentWindow) {
        if (!this.webContentsView ||
            !parentWindow ||
            parentWindow.isDestroyed() ||
            !parentWindow.contentView) {
            return;
        }
        const previousParentWindow = this.parentWindow;
        if (previousParentWindow && previousParentWindow !== parentWindow) {
            this.releasePreviewWindow();
            this.safeRemoveFromContentView(this.webContentsView, previousParentWindow);
        }
        this.parentWindow = parentWindow;
        this.shortcutHostWindow = parentWindow;
        if (this.previewLayout && this.getDevicePreviewState().enabled) {
            // A background handoff carries compositor bounds. Wait for setBounds to
            // supply the foreground clip before presenting it in the File Panel.
            if (this.previewWindow)
                this.syncPreviewPresentation();
            return;
        }
        this.safeRemoveFromContentView(this.webContentsView, parentWindow);
        if (this.bounds.x >= 0 && this.bounds.y >= 0) {
            this.safeAddToContentView(this.webContentsView, parentWindow);
            this.webContentsView.setBounds(this.bounds);
        }
    }
    /**
     * 设置缩放因子
     */
    async setZoomFactor(factor) {
        const wc = this.webContents;
        if (!wc) {
            return { success: false, error: 'Browser not created' };
        }
        const previousFactor = wc.getZoomFactor();
        try {
            wc.setZoomFactor(factor);
            await this.devicePreviewController.setPageScaleFactor(factor);
            return { success: true };
        }
        catch (error) {
            try {
                wc.setZoomFactor(previousFactor);
                await this.devicePreviewController.setPageScaleFactor(previousFactor);
            }
            catch {
                // Preserve the original zoom failure for the caller.
            }
            return { success: false, error: String(error) };
        }
    }
    /**
     * 获取缩放因子
     */
    getZoomFactor() {
        return this.webContents?.getZoomFactor() || 1;
    }
    /**
     * 控制当前 Browser tab 的音频输出。由 manager 按前台可见状态同步，
     * 防止隐藏或切换后的页面继续播放声音。
     */
    setAudioMuted(muted) {
        const wc = this.webContents;
        if (!wc) {
            return { success: false, error: 'Browser not created' };
        }
        try {
            wc.setAudioMuted(muted);
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    }
    /**
     * 控制 Chromium 是否可以节流后台页面。传入 false 仅用于需要可靠计时器/渲染调度的操作窗口。
     */
    setBackgroundThrottlingAllowed(allowed) {
        const wc = this.webContents;
        if (!wc)
            return;
        try {
            wc.setBackgroundThrottling(allowed);
        }
        catch {
            // Ignore races while the WebContents is closing.
        }
    }
    /**
     * Sets the native `WebContentsView`'s own background — separate from the
     * page DOM background and from the owning `BaseWindow`'s. A `frame:false,
     * transparent:true` Mini App window needs this cleared to an alpha-channel
     * color, or the view paints an opaque rectangle regardless of the window's
     * own transparency.
     */
    setBackgroundColor(color) {
        if (!this.webContents || !this.webContentsView)
            return;
        try {
            this.webContentsView.setBackgroundColor(color);
        }
        catch {
            // Ignore races while the native view is being torn down.
        }
    }
    /**
     * Wired by the manager around a detach/attach round trip; see the field
     * comment on `onRequestCloseDetached` above.
     */
    setOnRequestCloseDetached(callback) {
        this.onRequestCloseDetached = callback;
    }
    /**
     * 获取当前状态
     */
    getState() {
        const wc = this.webContents;
        return {
            isCreated: !!this.webContentsView,
            isLoading: wc?.isLoading() || false,
            url: wc?.getURL() || '',
            title: wc?.getTitle() || '',
            canGoBack: wc?.navigationHistory?.canGoBack() || false,
            canGoForward: wc?.navigationHistory?.canGoForward() || false,
        };
    }
    /**
     * 视图当前是否处于离屏隐藏态（负坐标 → 已从窗口 contentView 摘除，
     * 页面不再合成渲染帧）。截图等依赖 compositor 的操作需要据此降级。
     */
    isOffscreen() {
        return this.bounds.x < 0 || this.bounds.y < 0;
    }
    /**
     * 获取 ElementMapManager 实例
     */
    getElementMapManager() {
        return this.browserActions.getElementMapManager();
    }
    /**
     * Expose the CDP helper for broker-host features that need raw protocol
     * commands while still sharing this controller's debugger attachment.
     */
    getCDPHelper() {
        return this.browserActions.getCDPHelper();
    }
    getDevicePreviewMode() {
        return this.devicePreviewController.getMode();
    }
    getDevicePreviewState() {
        return this.devicePreviewController.getPreviewState();
    }
    async updateDevicePreview(request) {
        try {
            const result = await this.devicePreviewController.updatePreview(request);
            this.syncDevicePreviewBorderRadius();
            // Apply emulation in place so switching devices preserves the current document.
            // Pages that detect identity only on load can still be refreshed explicitly.
            return {
                success: true,
                changed: result.changed,
                reloaded: false,
                devicePreviewState: this.getDevicePreviewState(),
            };
        }
        catch (error) {
            this.syncDevicePreviewBorderRadius();
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                devicePreviewState: this.getDevicePreviewState(),
            };
        }
    }
    getInputCoordinateScale() {
        return this.browserActions.getCurrentInputCoordinateScale();
    }
    toCapturePageRect(clip) {
        const scale = this.devicePreviewController.getDisplayScale();
        const x = Math.floor(clip.x * scale);
        const y = Math.floor(clip.y * scale);
        const right = Math.ceil((clip.x + clip.width) * scale);
        const bottom = Math.ceil((clip.y + clip.height) * scale);
        return {
            x,
            y,
            width: Math.max(1, right - x),
            height: Math.max(1, bottom - y),
        };
    }
    getCapturePageOutputSize(params, capturedSize) {
        const preset = this.devicePreviewController.getPreset();
        if (!preset)
            return capturedSize;
        const logicalSize = params.scope === 'clip' && params.clip
            ? { width: params.clip.width, height: params.clip.height }
            : preset.viewport;
        return {
            width: Math.max(1, Math.round(logicalSize.width * preset.viewport.deviceScaleFactor)),
            height: Math.max(1, Math.round(logicalSize.height * preset.viewport.deviceScaleFactor)),
        };
    }
    configureAgentCursor(options) {
        this.agentCursorEnabled = options.isEnabled ?? (() => true);
        this.agentCursorIdentity = options.identity;
        this.agentCursorVisible = options.isVisible;
        this.agentCursorDiagnose = options.diagnose ?? (() => undefined);
    }
    async installAgentCursorBridge() {
        if (!this.agentCursorEnabled() && !this.agentExecutionGlowActive)
            return false;
        const installed = await this.ensureAgentSurfaceBridge();
        if (installed && this.agentExecutionGlowActive) {
            await this.dispatchAgentSurfaceCommand({ type: 'execution-start' });
        }
        return installed;
    }
    handleAgentSurfaceNavigationStarted() {
        this.agentSurfaceBridgeReady = false;
    }
    async ensureAgentSurfaceBridge() {
        if (this.agentSurfaceBridgeReady)
            return true;
        const result = await this.evaluateInIsolatedWorld(AGENT_CURSOR_WORLD_ID, AGENT_CURSOR_BRIDGE_SCRIPT);
        this.agentSurfaceBridgeReady = result.success && result.result === true;
        return this.agentSurfaceBridgeReady;
    }
    handleAgentCursorArrival(arrival) {
        return this.agentCursorController.handleArrival(arrival);
    }
    async prepareAgentCursorMove(point) {
        await this.agentCursorController.prepareMove(point, { animate: true });
    }
    async hideAgentCursor() {
        await this.agentCursorController.hide();
    }
    async resetAgentCursor() {
        await this.agentCursorController.reset();
    }
    async setAgentExecutionGlow(active) {
        this.agentExecutionGlowActive = active;
        await this.sendAgentSurfaceCommand({
            type: active ? 'execution-start' : 'execution-stop',
        });
    }
    async withAgentCursorHiddenForCapture(capture) {
        const hideGlow = this.agentExecutionGlowActive;
        if (hideGlow)
            await this.sendAgentSurfaceCommand({ type: 'capture-hide' });
        try {
            return await this.agentCursorController.withHiddenForCapture(capture);
        }
        finally {
            if (hideGlow && this.agentExecutionGlowActive) {
                await this.sendAgentSurfaceCommand({ type: 'capture-restore' });
            }
        }
    }
    async dispatchAgentSurfaceCommand(command) {
        const script = `globalThis.__mavisEmbeddedBrowserAgentCursorControl?.dispatch(${JSON.stringify(command)}) === true`;
        const result = await this.evaluateInIsolatedWorld(AGENT_CURSOR_WORLD_ID, script);
        return result.success && result.result === true;
    }
    async sendAgentSurfaceCommand(command) {
        if (!(await this.ensureAgentSurfaceBridge()))
            return false;
        if (await this.dispatchAgentSurfaceCommand(command))
            return true;
        // A document can be replaced between the cached readiness check and the
        // dispatch. Reinstall once in the new isolated world and retry.
        this.agentSurfaceBridgeReady = false;
        if (!(await this.ensureAgentSurfaceBridge()))
            return false;
        return this.dispatchAgentSurfaceCommand(command);
    }
    async setDevicePreviewMode(mode) {
        try {
            const result = await this.devicePreviewController.setMode(mode);
            this.syncDevicePreviewBorderRadius();
            const wc = this.webContents;
            const shouldReload = result.changed && Boolean(wc && wc.getURL() && wc.getURL() !== 'about:blank');
            if (!shouldReload) {
                return {
                    success: true,
                    ...result,
                    mode: this.devicePreviewController.getMode(),
                    reloaded: false,
                };
            }
            let reloadResult;
            try {
                reloadResult = await this.browserActions.reload();
            }
            catch (reloadError) {
                return await this.rollbackDevicePreviewAfterReloadFailure(reloadError instanceof Error ? reloadError.message : String(reloadError));
            }
            if (reloadResult.success !== false) {
                return {
                    success: true,
                    ...result,
                    mode: this.devicePreviewController.getMode(),
                    reloaded: true,
                };
            }
            const reloadError = typeof reloadResult.error === 'string' ? reloadResult.error : 'Browser reload failed';
            return await this.rollbackDevicePreviewAfterReloadFailure(reloadError);
        }
        catch (error) {
            this.syncDevicePreviewBorderRadius();
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                mode: this.devicePreviewController.getMode(),
            };
        }
    }
    async rollbackDevicePreviewAfterReloadFailure(reloadError) {
        let recoverySuffix = '';
        try {
            await this.devicePreviewController.setMode('responsive');
            this.syncDevicePreviewBorderRadius();
            const recoveryReload = await this.browserActions.reload();
            if (recoveryReload.success === false) {
                recoverySuffix = `; responsive reload: ${String(recoveryReload.error ?? 'failed')}`;
            }
        }
        catch (recoveryError) {
            recoverySuffix = `; responsive recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
        }
        return {
            success: false,
            error: `DEVICE_PREVIEW_RELOAD_FAILED: ${reloadError}${recoverySuffix}`,
            mode: this.devicePreviewController.getMode(),
        };
    }
    isDevicePreviewWindowFocused() {
        return (this.parentWindow === this.shortcutHostWindow && (this.previewWindow?.isFocused() ?? false));
    }
    releasePreviewWindow() {
        this.previewWindow?.destroy();
        this.previewWindow = null;
    }
    syncPreviewPresentation() {
        const view = this.webContentsView;
        const parent = this.parentWindow;
        if (!view || !parent || parent.isDestroyed())
            return;
        const state = this.getDevicePreviewState();
        const layout = this.previewLayout;
        if (!state.enabled || !state.viewport || !layout || parent !== this.shortcutHostWindow) {
            const wasClipped = Boolean(this.previewWindow);
            this.releasePreviewWindow();
            if ((wasClipped || layout) && !this.isOffscreen()) {
                if (parent !== this.shortcutHostWindow && state.enabled && state.viewport) {
                    const scale = this.devicePreviewController.getDisplayScale();
                    this.bounds = {
                        ...this.bounds,
                        width: Math.max(1, Math.round(state.viewport.width * scale)),
                        height: Math.max(1, Math.round(state.viewport.height * scale)),
                    };
                    this.browserActions.setBounds(this.bounds);
                }
                this.safeAddToContentView(view);
                if (!boundsEqual(view.getBounds(), this.bounds))
                    view.setBounds(this.bounds);
            }
            return;
        }
        if (this.isOffscreen()) {
            this.previewWindow?.hide();
            return;
        }
        if (!this.previewWindow) {
            this.safeRemoveFromContentView(view);
            this.previewWindow = new DevicePreviewWindow(parent, view);
        }
        const scale = this.devicePreviewController.getDisplayScale();
        this.previewWindow.update(this.bounds, {
            x: Math.round(layout.offset.x),
            y: Math.round(layout.offset.y),
            width: Math.max(1, Math.round(state.viewport.width * scale)),
            height: Math.max(1, Math.round(state.viewport.height * scale)),
        });
    }
    syncDevicePreviewBorderRadius() {
        this.syncPreviewPresentation();
        // Electron 42's rounded WebContentsView mask misroutes OOPIF input when
        // emulation scale is below 1. The scrollable preview uses a rectangular
        // native clip; retain the old mask only for the legacy five-preset surface.
        const legacyDeviceFrame = !this.getDevicePreviewState().enabled && this.devicePreviewController.getPreset();
        this.webContentsView?.setBorderRadius(legacyDeviceFrame ? BrowserController.DEVICE_PREVIEW_BORDER_RADIUS : 0);
    }
    /**
     * Expose the underlying WebContents for Electron-only host integrations.
     */
    getWebContents() {
        return this.webContents;
    }
    /**
     * Gives the page real keyboard focus. A newly opened pop-out window does
     * not otherwise pull it: without this, shortcuts like Cmd/Ctrl+W only
     * work once the user clicks inside the page (Bug 2).
     */
    focusPage() {
        const wc = this.webContents;
        if (!wc || wc.isDestroyed())
            return;
        wc.focus();
    }
    async updateElementMapAfterAction(options) {
        return this.browserActions.updateElementMapAfterAction(options);
    }
    /**
     * 安全发送消息到父窗口
     */
    safeSendToParent(channel, data) {
        const parentWindow = this.parentWindow;
        if (!parentWindow || parentWindow.isDestroyed() || !('webContents' in parentWindow))
            return;
        const parentWebContents = parentWindow.webContents;
        if (!parentWebContents || parentWebContents.isDestroyed())
            return;
        parentWebContents.send(channel, data);
    }
    /**
     * 设置事件监听
     */
    setupEventListeners(onOpenTab, partition = EMBEDDED_BROWSER_PARTITION) {
        const wc = this.webContents;
        if (!wc || wc?.isDestroyed?.()) {
            return;
        }
        wc.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown' || !(input.meta || input.control || input.alt || input.shift))
                return;
            const overrides = this.options.getShortcutOverrides?.() ?? {};
            const isDetached = this.parentWindow !== this.shortcutHostWindow;
            if (isDetached &&
                matchesEmbeddedBrowserShortcutAction(input, 'workspacePanel.closeCurrentTab', overrides)) {
                // Detached: handle the close shortcut ourselves instead of forwarding
                // it (nowhere useful to land) or leaving it to fall through to the
                // app menu's `role: 'close'`, which resolves to the main window, not
                // this Mini App's own pop-out.
                event.preventDefault();
                this.onRequestCloseDetached?.();
                return;
            }
            forwardEmbeddedBrowserHostShortcut(event, input, this.shortcutHostWindow,
            // Outside the File Panel host the close shortcut belongs to the page's
            // own window, whose close handler returns the page to the panel.
            isDetached ? { ...overrides, 'workspacePanel.closeCurrentTab': null } : overrides);
        });
        // 拦截新窗口打开请求
        wc.setWindowOpenHandler(({ url, features }) => {
            if (wc.isDestroyed()) {
                return { action: 'deny' };
            }
            const isPopup = features.includes('popup') ||
                features.includes('width=') ||
                features.includes('height=') ||
                features.includes('menubar=no') ||
                features.includes('toolbar=no');
            if (isPopup) {
                return {
                    action: 'allow',
                    overrideBrowserWindowOptions: {
                        width: 600,
                        height: 600,
                        center: true,
                        resizable: true,
                        minimizable: false,
                        maximizable: false,
                        webPreferences: {
                            partition,
                            nodeIntegration: false,
                            nodeIntegrationInSubFrames: false,
                            contextIsolation: true,
                            sandbox: true,
                            disableBlinkFeatures: 'FedCm',
                        },
                    },
                };
            }
            // Page-created windows belong to the same tab manager as toolbar tabs.
            // Without an owner, fail closed instead of replacing the source page.
            onOpenTab?.(url);
            return { action: 'deny' };
        });
    }
    // ============================================
    // 导航操作（委托给 BrowserActions）
    // ============================================
    async loadForPresentation(params) {
        return this.browserActions.loadForPresentation(params);
    }
    async navigate(params, options) {
        return this.browserActions.navigate(params, options);
    }
    async goBack() {
        return this.browserActions.goBack();
    }
    async goForward() {
        return this.browserActions.goForward();
    }
    async reload() {
        return this.browserActions.reload();
    }
    // ============================================
    // 交互操作（委托给 BrowserActions）
    // ============================================
    async click(params) {
        const result = await this.browserActions.click(params);
        // 点击后可能需要更新元素映射
        // 这里可以根据需要添加自动更新逻辑
        return result;
    }
    async type(params, options = {}) {
        return this.browserActions.type(params, options);
    }
    async pressKey(params) {
        return this.browserActions.pressKey(params);
    }
    async scroll(params) {
        const result = await this.browserActions.scroll(params);
        // 滚动后元素位置可能变化，可以考虑更新元素映射
        return result;
    }
    async hover(params) {
        return this.browserActions.hover(params);
    }
    async drag(params) {
        return this.browserActions.drag(params);
    }
    async setChecked(params) {
        return this.browserActions.setChecked(params);
    }
    async selectOption(params) {
        return this.browserActions.selectOption(params);
    }
    // ============================================
    // 获取信息（委托给 BrowserActions）
    // ============================================
    /**
     * 截图
     * 使用 CDP Page.captureScreenshot，支持窗口最小化/不可见时截图
     */
    async inspect(params = {}, options = {}) {
        return this.browserActions.inspect(params, options);
    }
    async screenshot(params = {}) {
        return this.browserActions.screenshot(params);
    }
    /**
     * 获取 DOM
     * 同时返回 HTML 和结构化数据
     */
    async getDOM(params = {}) {
        return this.browserActions.getDOM(params);
    }
    /**
     * 将 HTML 文件转换为 Markdown
     */
    async htmlToMarkdown(params) {
        return this.browserActions.htmlToMarkdown(params);
    }
    // ============================================
    // 高级操作（委托给 BrowserActions）
    // ============================================
    async waitFor(params) {
        return this.browserActions.waitFor(params);
    }
    async evaluate(params) {
        return this.browserActions.evaluate(params);
    }
    async evaluateInIsolatedWorld(worldId, script) {
        const wc = this.webContents;
        if (!wc)
            return { success: false, result: null, error: 'WebContents not available' };
        try {
            const result = await wc.executeJavaScriptInIsolatedWorld(worldId, [{ code: script }], false);
            return { success: true, result };
        }
        catch (error) {
            return {
                success: false,
                result: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    // ============================================
    // 配置方法
    // ============================================
    /**
     * 设置 ElementMap 缓存目录
     * @param dir 缓存目录路径
     */
    async setElementMapCacheDir(dir) {
        try {
            this.browserActions.getElementMapManager().setCacheDir(dir);
            return { success: true };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to set cache dir',
            };
        }
    }
    // ============================================
    // 工具方法
    // ============================================
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

BrowserController.DEVICE_PREVIEW_BORDER_RADIUS = 15;
// 全局实例
let browserController = null;
/**
 * 获取或创建 BrowserController 实例
 */
export function getBrowserController() {
    if (!browserController) {
        browserController = new BrowserController();
    }
    return browserController;
}
