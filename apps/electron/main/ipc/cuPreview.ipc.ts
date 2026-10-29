import { BrowserWindow, ipcMain } from "electron";
import { isDev } from "../config";
import { DEV_SERVER_URL, DISPLAY_NAME } from "../config/constants";
import { inspectCuaPreview } from "../modules/local-runtime/computer-use/cua-preview";
import { ComputerUsePermissionGuide } from "../modules/screenshot/permission-guide";
import { getScreenPermissionStatus, openScreenRecordingSettingsForGrant } from "../modules/screenshot/permission";
import { getCategoryLogger } from "../utils/logger";
function trustedHostRenderer(event) {
    if (event.sender.isDestroyed() ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame)
        return false;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents.id !== event.sender.id)
        return false;
    try {
        const url = new URL(event.sender.getURL());
        if (url.pathname !== '/archon' && url.pathname !== '/archon/')
            return false;
        return isDev
            ? url.origin === new URL(DEV_SERVER_URL).origin
            : url.protocol === 'app:' && url.hostname === '.';
    }
    catch {
        return false;
    }
}
export function setupCuPreviewIPC() {
    const guide = new ComputerUsePermissionGuide('desktop');
    let stopped = false;
    ipcMain.handle('cu:preview:inspect', async (event, sessionId, capture) => {
        if (!trustedHostRenderer(event) ||
            typeof sessionId !== 'string' ||
            sessionId.length > 256 ||
            typeof capture !== 'boolean')
            return null;
        return inspectCuaPreview(sessionId, capture);
    });
    // Preview capture uses this Desktop app's own Screen Recording grant, separate from the
    // Computer Use component. Advisory only: it never gates Computer Use activation.
    ipcMain.handle('cu:preview:desktopPermission', (event) => trustedHostRenderer(event)
        ? { status: getScreenPermissionStatus(), appName: DISPLAY_NAME }
        : null);
    ipcMain.handle('cu:preview:openDesktopPermissionSettings', async (event) => {
        if (stopped || !trustedHostRenderer(event))
            return;
        // Probe first so macOS lists this app on the Screen Recording page.
        await openScreenRecordingSettingsForGrant();
        if (stopped)
            return;
        // Guidance must not prevent the existing settings navigation.
        await guide.show('screen-recording').catch((error) => {
            getCategoryLogger('main').warn('preview_permission_guide_unavailable', {
                error: String(error),
            });
        });
    });
    return () => {
        stopped = true;
        guide.close();
    };
}
