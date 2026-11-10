import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";
import { browserGuestRegistry } from "./browser-guest-registry.js";
export function createMiniAppWebviewWindow(options) {
    const window = new BrowserWindow({
        ...options,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            webviewTag: true,
            preload: path.join(__dirname, 'webview-host-preload.js'),
        },
    });
    const file = path.join(__dirname, '../../../webview-host/index.html');
    const url = pathToFileURL(file).href;
    browserGuestRegistry.install(window, (candidate) => candidate === url, 'miniapp_window');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const load = () => {
        void window.loadFile(file).catch(() => {
            if (!window.isDestroyed())
                window.destroy();
        });
    };
    let recoveredHost = false;
    window.webContents.on('render-process-gone', () => {
        if (window.isDestroyed())
            return;
        // One automatic host recovery, never an unbounded crash/reload loop. A
        // second crash returns the logical Mini App to the FilePanel retry path.
        if (recoveredHost)
            window.destroy();
        else {
            recoveredHost = true;
            load();
        }
    });
    load();
    return window;
}
