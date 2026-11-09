import { ipcMain } from "electron";
import { trustedHost } from "./miniAppComposer.ipc";
import { listUtilityPptArtifacts } from "../modules/local-runtime/utility";
import { isPptPreviewSessionId } from "../modules/local-runtime/utility/ppt-preview-query-broker";
/** Host-only read projection. The renderer cannot request publication or another profile. */
export function setupPptPreviewQueryIPC() {
    ipcMain.handle('ppt-preview:list-artifacts', (event, sessionId) => {
        if (!trustedHost(event))
            throw new Error('PPT preview query sender is not authorized');
        if (!isPptPreviewSessionId(sessionId))
            throw new Error('Invalid PPT preview session');
        return listUtilityPptArtifacts(sessionId);
    });
    return () => ipcMain.removeHandler('ppt-preview:list-artifacts');
}
