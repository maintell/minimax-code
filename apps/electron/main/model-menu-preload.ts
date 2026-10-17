import { ipcRenderer, contextBridge } from "electron";
// Sandboxed popup: no business APIs, runtime transport, files, credentials or arbitrary IPC.
const api = {
    ready: () => ipcRenderer.send('model-menu-popup:renderer', 'ready'),
    measure: (id, measurement) => ipcRenderer.send('model-menu-popup:renderer', 'measure', id, measurement),
    painted: (id) => ipcRenderer.send('model-menu-popup:renderer', 'painted', id),
    action: (id, action) => ipcRenderer.send('model-menu-popup:renderer', 'action', id, action),
    close: (id, restoreFocus) => ipcRenderer.send('model-menu-popup:renderer', 'close', id, restoreFocus),
    onState: (listener) => {
        const receive = (_event, state) => listener(state);
        ipcRenderer.on('model-menu-popup:state', receive);
        return () => ipcRenderer.removeListener('model-menu-popup:state', receive);
    },
    onLayout: (listener) => {
        const receive = (_event, layout) => listener(layout);
        ipcRenderer.on('model-menu-popup:layout', receive);
        return () => ipcRenderer.removeListener('model-menu-popup:layout', receive);
    },
};
contextBridge.exposeInMainWorld('modelMenuPopupRenderer', api);
