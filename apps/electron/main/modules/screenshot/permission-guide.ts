import { nativeImage, ipcMain, app, screen, BrowserWindow } from "electron";
import path from "node:path";
import { existsSync } from "node:fs";
import { isEn } from "../../config/env";
import { getCategoryLogger } from "../../utils/logger";
import { registerTransparentWindow } from "../../windows/utils";
import { getVerifiedComputerUseAppBundle, getComputerUsePermissionStatus } from "../local-runtime/computer-use/component-permissions";
import { getScreenPermissionStatus } from "./permission";
/** execPath identifies the running bundle, including branded development launchers. */
export function runningAppBundle(executable) {
    if (!path.isAbsolute(executable))
        return undefined;
    const macOS = path.dirname(executable);
    const contents = path.dirname(macOS);
    const bundle = path.dirname(contents);
    return path.basename(macOS) === 'MacOS' &&
        path.basename(contents) === 'Contents' &&
        bundle.endsWith('.app')
        ? bundle
        : undefined;
}
const logger = getCategoryLogger('main', 'computer-use-permission-guide');
const escape = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const label = (value, fallback) => typeof value === 'string' && value.length <= 500 ? value : fallback;
export function permissionGuideHtml(name, appIcon, title, instruction, close, permissionIcon = '', recoveryHint = '') {
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#171717;--secondary:#747474;--border:#e5e5e5;--row:#f5f5f5}
  @media(prefers-color-scheme:dark){:root{--bg:#202020;--fg:#f5f5f5;--secondary:#a1a1a1;--border:#414141;--row:#292929}}
  *{box-sizing:border-box}body{margin:0;padding:16px;font:14px -apple-system,system-ui;background:transparent;color:var(--fg)}
  main{padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--bg);box-shadow:0 2px 12px #0003;-webkit-app-region:drag}
  header{display:flex;align-items:center;gap:12px}img{width:40px;height:40px;object-fit:contain}h1{font-size:16px;margin:0;flex:1}button{border:0;background:none;color:var(--secondary);font-size:24px;cursor:pointer;-webkit-app-region:no-drag}
  p{margin:12px 0 16px;color:var(--fg);line-height:1.5}.recovery-hint{font-size:12px;line-height:16px;color:var(--secondary)}#application{display:flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:12px;background:var(--row);padding:12px;cursor:grab;-webkit-app-region:no-drag}#application span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#application b{margin-left:auto;color:#0094fc;font-size:24px}#application img{pointer-events:none}
  </style></head><body><main><header><img src="${escape(permissionIcon)}" alt=""><h1>${escape(title)}</h1><button id="close" aria-label="${escape(close)}">×</button></header><p>${escape(instruction)}</p>${recoveryHint ? `<p class="recovery-hint">${escape(recoveryHint)}</p>` : ''}<div id="application" draggable="true" aria-label="${escape(name)}"><img src="${escape(appIcon)}" alt=""><span>${escape(name)}</span><b aria-hidden="true">↑</b></div></main></body></html>`;
}
export class ComputerUsePermissionGuide {
    constructor(target = 'component') {
        this.target = target;
        this.revision = 0;
        this.dragIcon = nativeImage.createEmpty();
        ipcMain.on('cu:permission:guide:drag', (event) => {
            if (!this.window ||
                event.sender !== this.window.webContents ||
                event.senderFrame !== this.window.webContents.mainFrame)
                return;
            // Fixed by main when the window opened: the verified component or the running Desktop bundle.
            const bundle = this.bundle;
            if (!bundle || !existsSync(bundle))
                return;
            try {
                event.sender.startDrag({ file: bundle, icon: this.dragIcon });
            }
            catch (error) {
                logger.warn('permission_guide_drag_failed', { error: String(error) });
            }
        });
        ipcMain.on('cu:permission:guide:close', (event) => {
            if (this.window && event.sender === this.window.webContents)
                this.close();
        });
    }
    close() {
        this.revision++;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = undefined;
        const window = this.window;
        this.window = undefined;
        this.bundle = undefined;
        if (window && !window.isDestroyed())
            window.destroy();
    }
    async show(kind, presentation = {}) {
        this.close();
        if (process.platform !== 'darwin')
            return;
        const desktop = this.target === 'desktop';
        if (desktop && kind !== 'screen-recording')
            return;
        const revision = this.revision;
        const bundle = desktop
            ? runningAppBundle(process.execPath)
            : await getVerifiedComputerUseAppBundle();
        if (revision !== this.revision || !bundle || !existsSync(bundle))
            return;
        const granted = async () => {
            const status = desktop
                ? { screenRecording: getScreenPermissionStatus(), accessibility: 'granted' }
                : await getComputerUsePermissionStatus();
            const value = kind === 'accessibility' ? status.accessibility : status.screenRecording;
            return value === 'granted' || value === 'not-required' || value === 'restricted';
        };
        if ((await granted()) || revision !== this.revision)
            return;
        // Use bundled artwork offline: macOS may return a generic document icon for .app files.
        const artwork = nativeImage.createFromPath(desktop
            ? path.join(app.getAppPath(), 'public', 'assets', 'logo', 'agentLogo.png')
            : path.join(app.getAppPath(), 'public', 'assets', 'plugin', 'computer-use.png'));
        const fileIcon = artwork.isEmpty()
            ? await app.getFileIcon(bundle, { size: 'normal' })
            : artwork;
        if (revision !== this.revision)
            return;
        const iconData = presentation?.permissionIconDataUrl;
        const customIcon = typeof iconData === 'string' &&
            iconData.length < 1000000 &&
            /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(iconData)
            ? nativeImage.createFromDataURL(iconData)
            : nativeImage.createEmpty();
        // Renderer artwork is best-effort (network, MIME or decode failures). Keep the
        // permission header available offline using the same bundled permission artwork.
        const permissionIcon = customIcon.isEmpty()
            ? nativeImage.createFromPath(path.join(app.getAppPath(), 'public', 'assets', 'permissions', `${kind}.png`))
            : customIcon;
        this.dragIcon = fileIcon.resize({
            width: 48,
            height: 48,
        });
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const width = Math.min(480, area.width);
        const height = Math.min(440, area.height);
        const window = new BrowserWindow({
            width,
            height,
            x: Math.round(area.x + (area.width - width) / 2),
            y: Math.max(area.y, area.y + area.height - height - 24),
            show: false,
            frame: false,
            ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
            transparent: true,
            backgroundColor: '#00000000',
            hasShadow: false,
            fullscreenable: false,
            fullscreen: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            skipTaskbar: true,
            alwaysOnTop: true,
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                preload: path.join(__dirname, 'permission-guide-preload.js'),
            },
        });
        registerTransparentWindow(window);
        this.window = window;
        this.bundle = bundle;
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        if (process.platform === 'darwin') {
            window.setVisibleOnAllWorkspaces(true, {
                visibleOnFullScreen: true,
                skipTransformProcessType: true,
            });
        }
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.on('closed', () => {
            if (this.window === window)
                this.close();
        });
        const title = kind === 'accessibility'
            ? isEn
                ? 'Accessibility'
                : '辅助功能'
            : isEn
                ? 'Screen Recording'
                : '屏幕录制';
        try {
            await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(permissionGuideHtml(path.basename(bundle, '.app'), this.dragIcon.toDataURL(), label(presentation?.title, title), label(presentation?.instruction, isEn ? 'Drag the app below into the permission list, then turn on its switch. If already listed, turn on the existing switch.' : '将下方应用拖入权限列表，再打开开关。如果已在列表中，直接打开已有开关。'), label(presentation?.closeLabel, isEn ? 'Close' : '关闭'), permissionIcon.toDataURL(), label(presentation?.recoveryHint, isEn ? 'Permission is on, but the app still reports it is missing? Select this app in the system permission list and click “−” to remove it. Then drag the app below back into the list and turn on its switch. Restart the app if prompted by macOS.' : '已开启权限但仍提示未授权？请在系统权限列表中选中当前应用，点击「−」移除，再将下方应用拖入列表并开启权限。如系统提示重新启动，请重启应用后再试。')))}`);
            if (this.window !== window || window.isDestroyed())
                return;
            window.showInactive();
            let checking = false;
            this.timer = setInterval(() => {
                if (checking)
                    return;
                checking = true;
                void granted()
                    .then((done) => {
                    if (done && this.window === window)
                        this.close();
                })
                    .catch((error) => {
                    logger.warn('permission_guide_status_failed', { error: String(error) });
                })
                    .finally(() => {
                    checking = false;
                });
            }, 1000);
            this.timer.unref?.();
        }
        catch (error) {
            if (this.window === window)
                this.close();
            logger.warn('permission_guide_load_failed', { error: String(error) });
        }
    }
}

