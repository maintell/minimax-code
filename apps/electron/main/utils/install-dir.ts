import * as path from "path";
import { app } from "electron";
/**
 * Return the desktop app install root on packaged Windows builds.
 */
export function getDesktopAppInstallDir(input = {}) {
    const platform = input.platform ?? process.platform;
    const isPackaged = input.isPackaged ?? app.isPackaged;
    if (platform !== 'win32' || !isPackaged)
        return null;
    return path.win32.dirname(input.execPath ?? process.execPath);
}
