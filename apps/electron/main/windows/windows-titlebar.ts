import { ipcMain } from "electron";
export let WINDOWS_TITLEBAR_HEIGHT = 40;
const owners = new WeakMap();
let registered = false;
export function hideWindowsMenuBar(window) {
    if (process.platform !== 'win32' || !owners.has(window.webContents))
        return;
    window.setAutoHideMenuBar(false);
    window.setMenuBarVisibility(false);
}
/** Only the Windows main product window opts into integrated chrome. */
export function installWindowsTitlebar(window) {
    if (process.platform !== 'win32')
        return;
    owners.set(window.webContents, window);
    hideWindowsMenuBar(window);
    // Native accelerators remain available, but Alt/F10 must not reveal a menu row.
    window.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Alt' ||
            (input.key === 'F10' && !input.shift && !input.control && !input.alt)) {
            event.preventDefault();
        }
    });
    if (registered)
        return;
    registered = true;
    ipcMain.handle('titlebar:appearance', (event, value) => {
        const target = owners.get(event.sender);
        if (!target || target.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
            throw new Error('Title bar is only available to the main window');
        }
        const appearance = value;
        if (!appearance ||
            typeof appearance.color !== 'string' ||
            typeof appearance.symbolColor !== 'string' ||
            (appearance.color !== 'transparent' && !/^#[0-9a-f]{6}$/i.test(appearance.color)) ||
            !/^#[0-9a-f]{6}$/i.test(appearance.symbolColor) ||
            typeof appearance.height !== 'number' ||
            !Number.isFinite(appearance.height) ||
            appearance.height < 24 ||
            appearance.height > 160) {
            throw new Error('Invalid title bar appearance');
        }
        target.setTitleBarOverlay({
            // Electron's dynamic setter rejects the CSS keyword "transparent".
            color: appearance.color === 'transparent' ? '#00000000' : appearance.color,
            symbolColor: appearance.symbolColor,
            height: Math.round(appearance.height),
        });
    });
}
