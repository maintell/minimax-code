/// <reference lib="dom" />
import { ipcRenderer } from "electron";
// This sandboxed preload exposes no general-purpose IPC or filesystem API.
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('application')?.addEventListener('dragstart', (event) => {
        event.preventDefault();
        ipcRenderer.send('cu:permission:guide:drag');
    });
    document.getElementById('close')?.addEventListener('click', () => {
        ipcRenderer.send('cu:permission:guide:close');
    });
});
