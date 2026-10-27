import { BaseWindow } from "electron";
/**
 * A child window provides the native clip that Electron View parents do not.
 * It only owns presentation: BrowserController retains WebContents and shortcut ownership.
 */
export class DevicePreviewWindow {
    constructor(host, view) {
        this.host = host;
        this.view = view;
        this.clip = null;
        this.page = null;
        this.visible = false;
        this.disposed = false;
        this.disposers = [];
        this.window = new BaseWindow({
            parent: host,
            title: 'Browser device preview',
            width: 1,
            height: 1,
            frame: false,
            show: false,
            hasShadow: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            closable: false,
            skipTaskbar: true,
            hiddenInMissionControl: true,
        });
        this.window.contentView.addChildView(view);
        const sync = () => this.sync();
        const hide = () => {
            if (!this.window.isDestroyed())
                this.window.hide();
        };
        // Windows does not move a child window with its parent. Recompute from the host
        // content origin on every platform, including decorations/fullscreen transitions.
        // Widen Electron's per-event overloads to the inherited EventEmitter contract
        // for the fixed lists of no-argument observers below.
        const hostEvents = host;
        for (const event of [
            'move',
            'resize',
            'show',
            'restore',
            'maximize',
            'unmaximize',
            'enter-full-screen',
            'leave-full-screen',
        ]) {
            hostEvents.on(event, sync);
            this.disposers.push(() => hostEvents.removeListener(event, sync));
        }
        for (const event of ['hide', 'minimize']) {
            hostEvents.on(event, hide);
            this.disposers.push(() => hostEvents.removeListener(event, hide));
        }
        this.window.on('focus', () => {
            if (!view.webContents.isDestroyed())
                view.webContents.focus();
        });
        this.window.once('closed', () => this.releaseListeners());
    }
    update(clip, page) {
        this.clip = { ...clip };
        this.page = { ...page };
        this.visible = true;
        this.sync();
    }
    hide() {
        this.visible = false;
        if (!this.window.isDestroyed())
            this.window.hide();
    }
    isFocused() {
        return (!this.disposed &&
            !this.window.isDestroyed() &&
            this.window.isVisible() &&
            this.window.isFocused());
    }
    destroy() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.releaseListeners();
        if (!this.window.isDestroyed()) {
            this.window.hide();
            this.window.contentView.removeChildView(this.view);
            // BaseWindow does not destroy the page; its lifetime remains with the controller.
            this.window.destroy();
        }
    }
    releaseListeners() {
        for (const dispose of this.disposers.splice(0))
            dispose();
    }
    sync() {
        if (this.disposed || this.window.isDestroyed() || this.host.isDestroyed())
            return;
        if (!this.visible ||
            !this.clip ||
            !this.page ||
            !this.host.isVisible() ||
            this.host.isMinimized()) {
            this.window.hide();
            return;
        }
        const host = this.host.getContentBounds();
        const x = Math.max(0, this.clip.x);
        const y = Math.max(0, this.clip.y);
        const width = Math.min(host.width, this.clip.x + this.clip.width) - x;
        const height = Math.min(host.height, this.clip.y + this.clip.height) - y;
        if (width <= 0 || height <= 0) {
            this.window.hide();
            return;
        }
        const windowBounds = { x: host.x + x, y: host.y + y, width, height };
        const pageBounds = {
            ...this.page,
            x: this.page.x + this.clip.x - x,
            y: this.page.y + this.clip.y - y,
        };
        // Unchanged layout must not disturb focus, IME or page pointer capture.
        if (!sameBounds(this.window.getBounds(), windowBounds))
            this.window.setBounds(windowBounds);
        if (!sameBounds(this.view.getBounds(), pageBounds))
            this.view.setBounds(pageBounds);
        if (!this.window.isVisible())
            this.window.showInactive();
    }
}

function sameBounds(left, right) {
    return (left.x === right.x &&
        left.y === right.y &&
        left.width === right.width &&
        left.height === right.height);
}
