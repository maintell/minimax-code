import { ipcMain } from "electron";
import { trustedHost } from "./miniAppComposer.ipc";
import { PptxEditCoreHostBroker } from "../modules/document-preview/pptx-edit/core-host-broker";
export function setupPptxEditingIPC() {
    const broker = new PptxEditCoreHostBroker();
    ipcMain.handle('pptx-edit:request', (event, input) => {
        if (!trustedHost(event))
            return { ok: false, error: { code: 'invalid_request' } };
        return broker.execute(event.sender, input);
    });
    return async () => {
        ipcMain.removeHandler('pptx-edit:request');
        await broker.dispose();
    };
}
