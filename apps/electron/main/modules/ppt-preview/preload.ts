import { ipcRenderer, contextBridge } from "electron";
const PPT_PREVIEW_SELECTION_BRIDGE_EVENT = 'ppt-preview:selection-bridge-event';
const mavisPptPreviewBridge = {
    emitSelectionEvent(envelope) {
        ipcRenderer.send(PPT_PREVIEW_SELECTION_BRIDGE_EVENT, envelope);
    },
};
contextBridge.exposeInMainWorld('mavisPptPreviewBridge', mavisPptPreviewBridge);
