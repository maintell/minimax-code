import { ipcRenderer, contextBridge } from "electron";
const api = {
    ready: () => ipcRenderer.invoke('browser-webview:ready'),
    applied: (id, revision) => ipcRenderer.send('browser-webview:applied', id, revision),
    onAgentPointer: (listener) => {
        const receive = (_event, id) => listener(id);
        ipcRenderer.on('browser-webview:agent-pointer', receive);
        return () => ipcRenderer.removeListener('browser-webview:agent-pointer', receive);
    },
    onSnapshot: (listener) => {
        const receive = (_event, snapshot) => listener(snapshot);
        ipcRenderer.on('browser-webview:snapshot', receive);
        return () => ipcRenderer.removeListener('browser-webview:snapshot', receive);
    },
};
contextBridge.exposeInMainWorld('browserWebviewHostAPI', api);
