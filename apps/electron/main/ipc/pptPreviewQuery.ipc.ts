import { ipcMain } from "electron";
import { trustedHost } from "./miniAppComposer.ipc";
import { listUtilityPptArtifacts } from "../modules/local-runtime/utility";
import { isPptPreviewSessionId } from "../modules/local-runtime/utility/ppt-preview-query-broker";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { configurePptPreviewSnapshotLookup } from "../modules/document-preview/generation-preview/render-host";
function listArtifacts(event, sessionId) {
    if (!trustedHost(event))
        throw new Error('PPT preview query sender is not authorized');
    if (!isPptPreviewSessionId(sessionId))
        throw new Error('Invalid PPT preview session');
    return listUtilityPptArtifacts(sessionId);
}
/** Host-only read projection. The renderer cannot request publication or another profile. */
export function setupPptPreviewQueryIPC() {
    ipcMain.handle('ppt-preview:list-artifacts', listArtifacts);
    configurePptPreviewSnapshotLookup({
        dataDir: () => resolveLocalRuntimeDataDir(),
        listArtifacts,
    });
    return () => {
        configurePptPreviewSnapshotLookup(undefined);
        ipcMain.removeHandler('ppt-preview:list-artifacts');
    };
}
