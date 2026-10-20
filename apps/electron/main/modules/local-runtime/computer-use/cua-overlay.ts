import { app, nativeImage, screen, BrowserWindow } from "electron";
import path from "node:path";
import { isEn } from "../../../config/env";
import { getCategoryLogger } from "../../../utils/logger";
import { registerTransparentWindow } from "../../../windows/utils";
const logger = getCategoryLogger('main', 'computer-use');
// Navigation is intercepted locally; this is an action marker, not a network endpoint.
const STOP_URL = 'https://computer-use.invalid/stop';
// Coalesce adjacent actions without keeping supervision visible during model/tool work.
const OPERATION_IDLE_HIDE_DELAY_MS = 300;
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
/** Static, script-free contents. Theme tokens mirror packages/ui/src/configs/tailwind/colorPlugin.ts. */
export function overlayHtml(kind, icon, english, failed = false) {
    const label = failed
        ? english
            ? 'Could not stop. Please retry.'
            : '停止失败，请重试'
        : english
            ? 'MiniMax Code is using your computer'
            : '正在使用你的电脑';
    const stop = english ? 'Stop conversation' : '停止对话';
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>
:root{--border_default:#0a0a0a14;--bg_default_tertiary_elevated:#fff;--text_default_primary:#171717;--bg_interaction_primary_default:#171717;--bg_interaction_primary_hover:#0a0a0acc;--text_label_primary_default:#fff}
@media(prefers-color-scheme:dark){:root{--border_default:#ffffff12;--bg_default_tertiary_elevated:#303030;--text_default_primary:#ededed;--bg_interaction_primary_default:#fff;--bg_interaction_primary_hover:#ffffffcc;--text_label_primary_default:#171717}}
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font:13px system-ui;color:var(--text_default_primary)}
.edge{position:fixed;inset:0;box-sizing:border-box;border:3px solid rgba(0,148,252,.9);box-shadow:0 0 240px rgba(0,148,252,.5) inset,0 0 80px rgba(0,148,252,.6) inset;pointer-events:none;animation:cu-edge 2.4s ease-in-out infinite}
@keyframes cu-edge{0%,100%{opacity:.4}50%{opacity:1}}
.bar{-webkit-app-region:drag;user-select:none;box-sizing:border-box;display:flex;width:max-content;max-width:100%;align-items:center;gap:0;height:50px;padding:10px;border:0.9px solid var(--border_default);border-radius:16px;background:var(--bg_default_tertiary_elevated);white-space:nowrap}
.bar>span{min-width:0;overflow:hidden;text-overflow:ellipsis;margin-right:10px}img{width:29px;height:29px;margin-right:7px;flex-shrink:0;object-fit:contain}a{-webkit-app-region:no-drag;display:flex;align-items:center;justify-content:center;width:26px;height:26px;flex-shrink:0;border-radius:50%;background:var(--bg_interaction_primary_default)}a:hover{background:var(--bg_interaction_primary_hover)}a:focus-visible{outline:2px solid #0094fc;outline-offset:2px}.stop{width:9px;height:9px;border-radius:2px;background:var(--text_label_primary_default)}
@media(prefers-reduced-motion:reduce){.edge{animation:none}}
</style></head><body>${kind !== 'bar' ? `<div class="${kind}"></div>` : `<div class="bar"><img alt="MiniMax Code" src="${escapeHtml(icon)}"><span>${label}</span><a href="${STOP_URL}" title="${stop}" aria-label="${stop}"><span class="stop"></span></a></div>`}</body></html>`;
}
/** Owns only supervision UI. Never moves the user's pointer or activates a target application. */
export class CuaDesktopOverlay {
    constructor(stopTurn) {
        this.stopTurn = stopTurn;
        this.windows = [];
        this.stopping = false;
        this.failed = false;
        this.watchingDisplays = false;
        this.activeRequests = new Set();
        this.rebuild = () => {
            this.destroyWindows();
            if (!this.turn)
                return;
            const iconPath = path.join(app.getAppPath(), 'public', 'assets', 'logo', 'agentLogo.png');
            const icon = nativeImage.createFromPath(iconPath).toDataURL();
            for (const display of screen.getAllDisplays()) {
                // Electron display bounds are already DIP; keep each display's own origin and scale.
                // Keep the full-screen edge effect Windows-only; macOS retains the stop bar.
                if (process.platform === 'win32')
                    this.createWindow(display.bounds, 'edge', icon);
                this.createWindow({
                    x: display.workArea.x,
                    y: (process.platform === 'darwin' ? display.workArea.y : display.bounds.y) + 24,
                    width: display.workArea.width,
                    height: 50,
                }, 'bar', icon);
            }
        };
    }
    show(turn, requestId) {
        if (!['win32', 'darwin'].includes(process.platform))
            return;
        if (this.hideTimer)
            clearTimeout(this.hideTimer);
        this.hideTimer = undefined;
        if (this.turn?.sessionId === turn.sessionId && this.turn.turnId === turn.turnId) {
            this.activeRequests.add(requestId);
            return;
        }
        this.clear();
        this.turn = turn;
        this.activeRequests.add(requestId);
        logger.info('overlay_started', turn);
        this.rebuild();
        screen.on('display-added', this.rebuild);
        screen.on('display-removed', this.rebuild);
        screen.on('display-metrics-changed', this.rebuild);
        this.watchingDisplays = true;
    }
    finish(turn, requestId) {
        if (this.turn?.sessionId !== turn.sessionId ||
            this.turn.turnId !== turn.turnId ||
            !this.activeRequests.delete(requestId) ||
            this.activeRequests.size > 0)
            return;
        this.hideTimer = setTimeout(() => {
            this.hideTimer = undefined;
            // Keep cancellation progress and a failed stop's retry affordance available.
            if (!this.stopping && !this.failed)
                this.clear(turn.sessionId, turn.turnId);
        }, OPERATION_IDLE_HIDE_DELAY_MS);
        this.hideTimer.unref?.();
    }
    clear(sessionId, turnId) {
        if (sessionId && this.turn?.sessionId !== sessionId)
            return;
        if (turnId && this.turn?.turnId !== turnId)
            return;
        if (this.hideTimer)
            clearTimeout(this.hideTimer);
        this.hideTimer = undefined;
        this.activeRequests.clear();
        this.turn = undefined;
        this.stopping = false;
        this.failed = false;
        if (this.watchingDisplays) {
            screen.removeListener('display-added', this.rebuild);
            screen.removeListener('display-removed', this.rebuild);
            screen.removeListener('display-metrics-changed', this.rebuild);
            this.watchingDisplays = false;
        }
        this.destroyWindows();
    }
    destroyWindows() {
        for (const window of this.windows)
            if (!window.isDestroyed())
                window.destroy();
        this.windows = [];
    }
    createWindow(bounds, kind, icon) {
        // Delayed window events retain their owner after the active turn changes or clears.
        const owningTurn = { ...this.turn };
        const window = new BrowserWindow({
            ...bounds,
            // A nonactivating panel can cover native full-screen Spaces without
            // changing the host application's activation policy or hiding its Dock icon.
            ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
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
            if (kind === 'bar' && url === STOP_URL)
                void this.stop();
        });
        void window
            .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(kind, icon, isEn, this.failed))}`)
            .then(async () => {
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
            if (!window.isDestroyed() && this.windows.includes(window)) {
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
        try {
            await this.stopTurn(turn);
            this.clear(turn.sessionId, turn.turnId);
        }
        catch (error) {
            logger.error('overlay_stop_failed', { ...turn, errorMessage: String(error) });
            if (this.turn === turn) {
                this.failed = true;
                this.rebuild();
            }
        }
        finally {
            if (this.turn === turn)
                this.stopping = false;
        }
    }
}

