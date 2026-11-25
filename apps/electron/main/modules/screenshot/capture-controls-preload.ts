import { ipcRenderer, contextBridge } from "electron";
const bridge = {
    locale: () => ipcRenderer.invoke('capture-controls:locale'),
    action: (action) => ipcRenderer.invoke('capture-controls:action', action),
    onProgress: (callback) => {
        ipcRenderer.on('capture-controls:progress', (_event, progress) => callback(progress));
    },
    onState: (callback) => {
        ipcRenderer.on('capture-controls:state', (_event, state) => callback(state));
    },
};
contextBridge.exposeInMainWorld('captureControls', bridge);
