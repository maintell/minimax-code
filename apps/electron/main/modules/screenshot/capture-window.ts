import { registerTransparentWindow } from "../../windows/utils";
/** Only the window's own main frame may drive a capture surface. */
export function isOwnFrame(event, target) {
    return (!!target &&
        !target.isDestroyed() &&
        event.sender === target.webContents &&
        event.senderFrame === target.webContents.mainFrame);
}
export function configureCaptureWindow(win, relativeLevel = 0) {
    // Capture backgrounds include transparent masks and fixed-color recording borders.
    registerTransparentWindow(win);
    win.setAlwaysOnTop(true, 'screen-saver', relativeLevel);
    if (process.platform === 'darwin')
        win.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
        });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
}
