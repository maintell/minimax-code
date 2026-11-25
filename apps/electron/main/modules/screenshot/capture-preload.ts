import { ipcRenderer, contextBridge } from "electron";
const bridge = {
    initialize: () => ipcRenderer.invoke('capture:initialize'),
    locale: () => ipcRenderer.invoke('capture:locale'),
    microphoneAccess: () => ipcRenderer.invoke('capture:microphone'),
    error: (message) => ipcRenderer.invoke('capture:error', message),
    show: () => ipcRenderer.invoke('capture:show'),
    started: () => ipcRenderer.invoke('capture:started'),
    hide: (options) => ipcRenderer.invoke('capture:hide', options),
    progress: (progress) => ipcRenderer.invoke('capture:progress', progress),
    save: (bytes, mime, keep = false) => ipcRenderer.invoke('capture:save', bytes, mime, keep),
    chunk: (bytes) => ipcRenderer.invoke('capture:chunk', bytes),
    complete: () => ipcRenderer.invoke('capture:complete'),
    cancel: () => ipcRenderer.invoke('capture:cancel'),
    onPause: (callback) => {
        const handler = (_event, paused) => callback(paused);
        ipcRenderer.on('capture:pause', handler);
        return () => ipcRenderer.removeListener('capture:pause', handler);
    },
    onFinish: (callback) => {
        const handler = () => callback();
        ipcRenderer.on('capture:finish', handler);
        return () => ipcRenderer.removeListener('capture:finish', handler);
    },
};
contextBridge.exposeInMainWorld('capture', bridge);
