/**
 * Computer Use Permission IPC Handlers
 *
 * Bridges the Computer Use system-permission flow from the main
 * process to the renderer. Control permissions belong to the verified
 * standalone MiniMax Computer Use component; Electron screenshot preview
 * keeps its independent permission flow.
 */
import { ipcMain } from "electron";
import { ComputerUsePermissionGuide } from "../modules/screenshot/permission-guide";
import { getCategoryLogger } from "../utils/logger";
import { getComputerUsePermissionStatus, requestComputerUsePermission, openComputerUsePermissionSettings } from "../modules/local-runtime/computer-use/component-permissions";
/** IPC channel names exposed for the Computer Use permission bridge. */
export let CU_PERMISSION_CHANNELS = {
    STATUS: 'cu:permission:status',
    REQUEST: 'cu:permission:request',
    OPEN_SETTINGS: 'cu:permission:openSettings',
};
/** Register the three Computer Use permission IPC handlers. */
export function setupCuPermissionIPC() {
    const guide = new ComputerUsePermissionGuide();
    let stopped = false;
    ipcMain.handle(CU_PERMISSION_CHANNELS.STATUS, async () => getComputerUsePermissionStatus());
    ipcMain.handle(CU_PERMISSION_CHANNELS.REQUEST, async (_, kind) => requestComputerUsePermission(kind));
    ipcMain.handle(CU_PERMISSION_CHANNELS.OPEN_SETTINGS, async (_, kind, presentation) => {
        if (stopped)
            return;
        await openComputerUsePermissionSettings(kind);
        if (stopped)
            return;
        // Guidance must not prevent the existing settings navigation.
        await guide.show(kind, presentation).catch((error) => {
            getCategoryLogger('main').warn('permission_guide_unavailable', { error: String(error) });
        });
    });
    return () => {
        stopped = true;
        guide.close();
    };
}
