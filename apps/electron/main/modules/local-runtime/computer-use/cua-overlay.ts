import { screen, app, nativeImage, BrowserWindow } from "electron";
import path from "node:path";
import { isEn } from "../../../config/env";
import { getCategoryLogger } from "../../../utils/logger";
import { registerTransparentWindow } from "../../../windows/utils";
const logger = getCategoryLogger('main', 'computer-use');
// Navigation is intercepted locally; this is an action marker, not a network endpoint.
const STOP_URL = 'https://computer-use.invalid/stop';
// No higher-level tool-phase signal is available here. Any Computer Use request, including
// background input and observation, keeps the overlay visible; collapse after sustained idleness.
const OPERATION_IDLE_HIDE_DELAY_MS = 60000;
// Full-screen Space switches emit bursts of work-area-only display changes.
const DISPLAY_CHANGE_DEBOUNCE_MS = 250;
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
/** Static, script-free contents. Theme tokens mirror packages/ui/src/configs/tailwind/colorPlugin.ts. */
export function overlayHtml(kind, icon, english, state = 'active') {
    const labels = english
        ? {
            active: 'MiniMax Code is using your computer',
            stopping: 'Stopping conversation…',
            failed: 'Could not stop. Please retry.',
        }
        : {
            active: '正在使用你的电脑',
            stopping: '正在停止对话…',
            failed: '停止失败，请重试',
        };
    const stop = english ? 'Stop conversation' : '停止对话';
    // All labels share a grid cell, reserving the widest label without resizing the window.
    const statusLabels = Object.entries(labels)
        .map(([key, label]) => `<span class="label" data-label="${key}">${label}</span>`)
        .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>
:root{--border_default:#0a0a0a14;--bg_default_tertiary_elevated:#fff;--text_default_primary:#171717;--bg_interaction_primary_default:#171717;--bg_interaction_primary_hover:#0a0a0acc;--text_label_primary_default:#fff}
@media(prefers-color-scheme:dark){:root{--border_default:#ffffff12;--bg_default_tertiary_elevated:#303030;--text_default_primary:#ededed;--bg_interaction_primary_default:#fff;--bg_interaction_primary_hover:#ffffffcc;--text_label_primary_default:#171717}}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font:13px system-ui;color:var(--text_default_primary)}
.edge{position:fixed;inset:0;box-sizing:border-box;border:3px solid rgba(0,148,252,.9);box-shadow:0 0 240px rgba(0,148,252,.5) inset,0 0 80px rgba(0,148,252,.6) inset;pointer-events:none;animation:cu-edge 2.4s ease-in-out infinite}
body:not([data-state="active"]) .edge{animation:none;opacity:.18}
@keyframes cu-edge{0%,100%{opacity:.4}50%{opacity:1}}
.bar{-webkit-app-region:drag;user-select:none;box-sizing:border-box;display:flex;width:max-content;max-width:100%;align-items:center;gap:0;height:50px;padding:10px;border:0.9px solid var(--border_default);border-radius:16px;background:var(--bg_default_tertiary_elevated);white-space:nowrap}
.bar>span{min-width:0;overflow:hidden;margin-right:10px;display:grid}.label{grid-area:1/1;visibility:hidden;overflow:hidden;text-overflow:ellipsis}body[data-state="active"] [data-label="active"],body[data-state="stopping"] [data-label="stopping"],body[data-state="failed"] [data-label="failed"]{visibility:visible}img{width:29px;height:29px;margin-right:7px;flex-shrink:0;object-fit:contain}a{-webkit-app-region:no-drag;display:flex;align-items:center;justify-content:center;width:26px;height:26px;flex-shrink:0;border-radius:50%;background:var(--bg_interaction_primary_default)}a:hover{background:var(--bg_interaction_primary_hover)}a:focus-visible{outline:2px solid #0094fc;outline-offset:2px}.stop{width:9px;height:9px;border-radius:2px;background:var(--text_label_primary_default)}
@media(prefers-reduced-motion:reduce){.edge{animation:none}}
</style></head><body data-state="${state}">${kind !== 'bar' ? `<div class="${kind}"></div>` : `<div class="bar"><img alt="MiniMax Code" src="${escapeHtml(icon)}"><span role="status" aria-live="polite">${statusLabels}</span><a href="${STOP_URL}" title="${stop}" aria-label="${stop}"><span class="stop"></span></a></div>`}</body></html>`;
}
function currentDisplayLayout() {
    return JSON.stringify(screen.getAllDisplays().map((display) => [display.id, display.bounds, display.scaleFactor]));
}
/** Owns only supervision UI. Never moves the user's pointer or activates a target application. */
export class CuaDesktopOverlay {
    constructor(stopTurn) {
        this.stopTurn = stopTurn;
        this.windows = [];
        this.loadedWindows = new Set();
        this.stopping = false;
        this.failed = false;
        this.watchingDisplays = false;
        this.activeRequests = new Set();
        // Any in-flight driver request, foreground or background, for the single lease holder.
        this.driverBusy = false;
        this.collapsed = false;
        this.onDisplaysChanged = () => {
            if (this.displayTimer)
                clearTimeout(this.displayTimer);
            this.displayTimer = setTimeout(() => {
                this.displayTimer = undefined;
                // Work-area-only changes (menu bar, Dock, taskbar) keep the existing windows in place.
                if (this.turn && currentDisplayLayout() !== this.displayLayout)
                    this.rebuild();
            }, DISPLAY_CHANGE_DEBOUNCE_MS);
            this.displayTimer.unref?.();
        };
        this.rebuild = () => {
            this.destroyWindows();
            if (!this.turn)
                return;
            this.displayLayout = currentDisplayLayout();
            const iconPath = path.join(app.getAppPath(), 'public', 'assets', 'logo', 'agentLogo.png');
            const icon = nativeImage.createFromPath(iconPath).toDataURL();
            for (const display of screen.getAllDisplays()) {
                // Electron display bounds are already DIP; keep each display's own origin and scale.
                this.createWindow(display.bounds, 'edge', icon);
                this.createWindow({
                    x: display.workArea.x,
                    // Below a top taskbar or menu bar on both platforms.
                    y: display.workArea.y + 24,
                    width: display.workArea.width,
                    height: 50,
                }, 'bar', icon);
            }
        };
    }
    show(turn, requestId) {
        if (!['win32', 'darwin'].includes(process.platform))
            return;
        this.cancelIdleHide();
        if (this.turn?.sessionId === turn.sessionId && this.turn.turnId === turn.turnId) {
            this.activeRequests.add(requestId);
            this.expand();
            this.updateState();
            return;
        }
        this.clear();
        this.turn = { ...turn };
        this.activeRequests.add(requestId);
        logger.info('overlay_started', turn);
        this.rebuild();
        screen.on('display-added', this.onDisplaysChanged);
        screen.on('display-removed', this.onDisplaysChanged);
        screen.on('display-metrics-changed', this.onDisplaysChanged);
        this.watchingDisplays = true;
    }
    finish(turn, requestId) {
        if (this.turn?.sessionId !== turn.sessionId ||
            this.turn.turnId !== turn.turnId ||
            !this.activeRequests.delete(requestId) ||
            this.activeRequests.size > 0)
            return;
        this.scheduleIdleHide();
    }
    /** Driver activity cannot start supervision; it only keeps an already shown turn visible. */
    noteDriverActivity(busy) {
        this.driverBusy = busy;
        if (!this.turn)
            return;
        if (busy) {
            this.cancelIdleHide();
            this.expand();
        }
        else {
            this.scheduleIdleHide();
        }
    }
    clear(sessionId, turnId) {
        if (sessionId && this.turn?.sessionId !== sessionId)
            return;
        if (turnId && this.turn?.turnId !== turnId)
            return;
        this.cancelIdleHide();
        if (this.displayTimer)
            clearTimeout(this.displayTimer);
        this.displayTimer = undefined;
        this.displayLayout = undefined;
        this.activeRequests.clear();
        this.turn = undefined;
        this.stopping = false;
        this.failed = false;
        this.collapsed = false;
        if (this.watchingDisplays) {
            screen.removeListener('display-added', this.onDisplaysChanged);
            screen.removeListener('display-removed', this.onDisplaysChanged);
            screen.removeListener('display-metrics-changed', this.onDisplaysChanged);
            this.watchingDisplays = false;
        }
        this.destroyWindows();
    }
    cancelIdleHide() {
        if (this.hideTimer)
            clearTimeout(this.hideTimer);
        this.hideTimer = undefined;
    }
    scheduleIdleHide() {
        if (this.activeRequests.size > 0 || this.driverBusy)
            return;
        this.cancelIdleHide();
        const owningTurn = this.turn;
        this.hideTimer = setTimeout(() => {
            this.hideTimer = undefined;
            // Keep cancellation progress and a failed stop's retry affordance available.
            if (this.turn === owningTurn && !this.stopping && !this.failed)
                this.collapse();
        }, OPERATION_IDLE_HIDE_DELAY_MS);
        this.hideTimer.unref?.();
    }
    // Hide instead of destroying so the next activity reappears instantly at the dragged position.
    collapse() {
        this.collapsed = true;
        for (const window of this.windows)
            if (!window.isDestroyed())
                window.hide();
    }
    expand() {
        if (!this.collapsed)
            return;
        this.collapsed = false;
        for (const window of this.loadedWindows)
            if (!window.isDestroyed())
                window.showInactive();
    }
    get state() {
        if (this.stopping)
            return 'stopping';
        if (this.failed)
            return 'failed';
        // Visibility already reflects Computer Use activity; avoid flipping between actions.
        return 'active';
    }
    async updateWindowState(window) {
        // Only this fixed enum reaches the sandboxed, script-free page. Keep its DOM and size stable.
        await window.webContents.executeJavaScript(`document.body.dataset.state = ${JSON.stringify(this.state)}`);
    }
    updateState() {
        const owningTurn = this.turn;
        for (const window of this.loadedWindows) {
            if (window.isDestroyed())
                continue;
            void this.updateWindowState(window).catch((error) => logger.warn('overlay_state_update_failed', {
                ...owningTurn,
                errorMessage: String(error),
            }));
        }
    }
    destroyWindows() {
        this.loadedWindows.clear();
        for (const window of this.windows)
            if (!window.isDestroyed())
                window.destroy();
        this.windows = [];
    }
    createWindow(bounds, kind, icon) {
        // Delayed window events retain their owner after the active turn changes or clears.
        const owningTurn = this.turn;
        const window = new BrowserWindow({
            ...bounds,
            // A nonactivating panel can cover native full-screen Spaces without
            // changing the host application's activation policy or hiding its Dock icon.
            ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
            // macOS otherwise pushes frameless windows below the menu bar, moving the
            // bottom edge off screen. This option only affects macOS.
            ...(kind === 'edge' ? { enableLargerThanScreen: true } : {}),
            show: false,
            frame: false,
            transparent: true,
            // Keep the window transparent when the app synchronizes native theme backgrounds.
            backgroundColor: '#00000000',
            resizable: false,
            movable: kind === 'bar',
            minimizable: false,
            maximizable: false,
            closable: false,
            focusable: false,
            skipTaskbar: true,
            hasShadow: false,
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                devTools: false,
                // The passive edge window must animate even while another app has focus.
                ...(kind === 'edge' ? { backgroundThrottling: false } : {}),
            },
        });
        registerTransparentWindow(window);
        this.windows.push(window);
        // Windows constrains initial window sizes to the work area, excluding the taskbar.
        // Restore the complete display bounds before showing the passive edge overlay.
        if (kind === 'edge')
            window.setBounds(bounds);
        window.setAlwaysOnTop(true, 'screen-saver');
        if (process.platform === 'darwin') {
            // Electron otherwise calls DockHide() for the entire application. Destroying
            // these passive windows does not restore the product's Dock entry.
            window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                skipTransformProcessType: true,
            });
        }
        window.setContentProtection(true);
        if (kind !== 'bar')
            window.setIgnoreMouseEvents(true);
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => {
            event.preventDefault();
            if (kind === 'bar' &&
                url === STOP_URL &&
                this.turn === owningTurn &&
                this.windows.includes(window) &&
                !window.isDestroyed())
                void this.stop();
        });
        void window
            .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(kind, icon, isEn, this.state))}`)
            .then(async () => {
            if (window.isDestroyed() || !this.windows.includes(window))
                return;
            this.loadedWindows.add(window);
            await this.updateWindowState(window);
            if (window.isDestroyed() || !this.windows.includes(window))
                return;
            if (kind === 'bar') {
                // Measure trusted, static content after fonts settle, before showing the window.
                const size = await window.webContents.executeJavaScript("document.fonts.ready.then(() => { const rect = document.querySelector('.bar').getBoundingClientRect(); return { width: rect.width, height: rect.height }; })");
                if (window.isDestroyed() || !this.windows.includes(window))
                    return;
                window.setContentSize(Math.min(bounds.width, Math.ceil(size.width)), Math.ceil(size.height));
                window.setPosition(Math.round(bounds.x + (bounds.width - window.getBounds().width) / 2), bounds.y);
            }
            if (!window.isDestroyed() && this.windows.includes(window) && !this.collapsed) {
                window.showInactive();
                logger.info('overlay_window_shown', {
                    kind,
                    ...owningTurn,
                    requestedBounds: bounds,
                    actualBounds: window.getBounds(),
                    visible: window.isVisible(),
                    alwaysOnTop: window.isAlwaysOnTop(),
                });
            }
        })
            .catch((error) => logger.warn('overlay_load_failed', {
            kind,
            bounds,
            ...owningTurn,
            errorMessage: String(error),
        }));
    }
    async stop() {
        const turn = this.turn;
        if (!turn || this.stopping)
            return;
        this.stopping = true;
        this.failed = false;
        this.updateState();
        try {
            await this.stopTurn(turn);
            if (this.turn === turn)
                this.clear();
        }
        catch (error) {
            logger.error('overlay_stop_failed', { ...turn, errorMessage: String(error) });
            if (this.turn === turn)
                this.failed = true;
        }
        finally {
            if (this.turn === turn) {
                this.stopping = false;
                this.updateState();
            }
        }
    }
}

