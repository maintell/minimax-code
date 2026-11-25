import { resolveShortcutBindings, normalizePlatformAccelerator } from "@mavis/shared/keyboard-shortcuts";
import { BrowserWindow, globalShortcut, app } from "electron";
const platform = process.platform === 'darwin' ? 'mac' : 'windows';
let registered = [];
let recent = null;
let candidates;
function supported(windows = candidates?.() ?? []) {
    return windows.filter((win) => !!win && !win.isDestroyed());
}
function rememberFocus(_event, window) {
    if (supported().includes(window))
        recent = window;
}
function requestCapture() {
    const candidatesNow = candidates?.() ?? [];
    const windows = supported(candidatesNow);
    const focused = BrowserWindow.getFocusedWindow();
    const owner = windows.find((win) => win === focused) ??
        windows.find((win) => win === recent && win.isVisible()) ??
        windows.find((win) => win.isVisible()) ??
        windows.find((win) => win === candidatesNow[0]);
    if (owner && !owner.webContents.isDestroyed())
        owner.webContents.send('screenshot:requested');
}
/** Update only bindings owned here; failed replacements leave the previous routing intact. */
export function registerCaptureShortcut(resolveWindows, shortcuts = resolveShortcutBindings('composer.screenshot', {}, platform)) {
    // Electron treats these aliases as the same key; avoid registering our own key twice.
    const next = [...new Set(shortcuts.map((key) => normalizePlatformAccelerator(key, platform)))];
    const added = [];
    try {
        for (const key of next) {
            if (registered.includes(key))
                continue;
            if (!globalShortcut.register(key, requestCapture))
                throw new Error('Shortcut unavailable');
            added.push(key);
        }
    }
    catch {
        for (const key of added)
            globalShortcut.unregister(key);
        return false;
    }
    for (const key of registered) {
        if (!next.includes(key))
            globalShortcut.unregister(key);
    }
    if (!registered.length && next.length) {
        app.on('browser-window-focus', rememberFocus);
    }
    else if (registered.length && !next.length) {
        app.removeListener('browser-window-focus', rememberFocus);
    }
    registered = next;
    candidates = next.length ? resolveWindows : undefined;
    if (!next.length)
        recent = null;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && supported().includes(focused))
        recent = focused;
    return true;
}
export function unregisterCaptureShortcut() {
    for (const key of registered)
        globalShortcut.unregister(key);
    registered = [];
    app.removeListener('browser-window-focus', rememberFocus);
    candidates = undefined;
    recent = null;
}
