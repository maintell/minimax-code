import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants.js";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager.js";
import { MiniAppToolPermissionBroker, setActiveMiniAppToolPermissionBroker } from "../modules/browser/miniapp-tool-permission.js";
import { requestUtilityMiniAppTools } from "../modules/local-runtime/utility";
import { captureTabCaller } from "./miniAppAgentIpcSupport.js";
import { trustedHost } from "./miniAppComposer.ipc.js";
/**
 * Host tool-permission prompt channel (Main <-> Host renderer) and the page's
 * `window.mcode.miniapp.tool.request(names)`; the page preload already required a user gesture.
 */
export function setupMiniAppToolIPC() {
    const manager = getEmbeddedBrowserManager();
    const broker = new MiniAppToolPermissionBroker({
        manager,
        send: (frame, request) => frame.send(IPC_CHANNELS.MINIAPP_TOOL_PERMISSION_REQUEST, request),
        cancel: (frame, requestId) => frame.send(IPC_CHANNELS.MINIAPP_TOOL_PERMISSION_CANCEL, { requestId }),
    });
    setActiveMiniAppToolPermissionBroker(broker);
    const reply = (event, value) => {
        if (trustedHost(event))
            broker.reply(event, value);
    };
    ipcMain.on(IPC_CHANNELS.MINIAPP_TOOL_PERMISSION_REPLY, reply);
    ipcMain.handle(IPC_CHANNELS.MINIAPP_TOOL_REQUEST, async (event, value) => {
        const caller = captureTabCaller(manager, event);
        if (!caller)
            return { success: false, code: 'not_permitted' };
        const names = value?.names;
        if (!Array.isArray(names))
            return { success: false, code: 'invalid_request' };
        try {
            return await requestUtilityMiniAppTools({ pluginId: caller.pluginId, names });
        }
        catch {
            return { success: false, code: 'runtime_unavailable' };
        }
    });
    return () => {
        setActiveMiniAppToolPermissionBroker(null);
        broker.dispose();
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_TOOL_PERMISSION_REPLY, reply);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_TOOL_REQUEST);
    };
}
