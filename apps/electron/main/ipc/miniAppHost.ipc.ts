import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants.js";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager.js";
import { MiniAppHostBroker } from "../modules/browser/miniapp-host.js";
import { isMiniAppNavigationRevoking } from "../modules/browser/miniapp-host-navigation-permissions.js";
import { createUtilityMiniAppPermissionSwitches } from "../modules/browser/miniapp-permission-switches.js";
import { trustedHost } from "./miniAppComposer.ipc.js";
/** Page identities come from Electron; only the Host main frame may publish or acknowledge UI. */
export function setupMiniAppHostIPC() {
    const switches = createUtilityMiniAppPermissionSwitches();
    const broker = new MiniAppHostBroker({
        manager: getEmbeddedBrowserManager(),
        isNavigationEnabled: (pluginId) => switches.readEnabled(pluginId, 'host:navigation.read'),
        isNavigationRevoking: isMiniAppNavigationRevoking,
        sendEvent: (frame, event) => frame.send(IPC_CHANNELS.MINIAPP_HOST_EVENT, event),
        sendOpen: (frame, request) => frame.send(IPC_CHANNELS.MINIAPP_HOST_OPEN_REQUEST, request),
        cancelOpen: (frame, request) => frame.send(IPC_CHANNELS.MINIAPP_HOST_OPEN_CANCEL, request),
    });
    const publish = (event, value) => {
        if (trustedHost(event))
            broker.publish(event, value);
    };
    const reply = (event, value) => {
        if (trustedHost(event))
            broker.reply(event, value);
    };
    const unsubscribe = (event, value) => broker.unsubscribe(event, value);
    ipcMain.on(IPC_CHANNELS.MINIAPP_HOST_PUBLISH, publish);
    ipcMain.on(IPC_CHANNELS.MINIAPP_HOST_OPEN_REPLY, reply);
    ipcMain.on(IPC_CHANNELS.MINIAPP_HOST_UNSUBSCRIBE, unsubscribe);
    ipcMain.handle(IPC_CHANNELS.MINIAPP_HOST_HANDSHAKE, (event) => trustedHost(event) ? broker.handshake(event) : { success: false, code: 'not_permitted' });
    ipcMain.handle(IPC_CHANNELS.MINIAPP_HOST_GET_STATE, (event, value) => broker.getState(event, value));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_HOST_SUBSCRIBE, (event, value) => broker.subscribe(event, value));
    ipcMain.handle(IPC_CHANNELS.MINIAPP_HOST_OPEN, (event, value) => broker.open(event, value));
    return () => {
        broker.dispose();
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_HOST_PUBLISH, publish);
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_HOST_OPEN_REPLY, reply);
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_HOST_UNSUBSCRIBE, unsubscribe);
        for (const channel of [
            IPC_CHANNELS.MINIAPP_HOST_HANDSHAKE,
            IPC_CHANNELS.MINIAPP_HOST_GET_STATE,
            IPC_CHANNELS.MINIAPP_HOST_SUBSCRIBE,
            IPC_CHANNELS.MINIAPP_HOST_OPEN,
        ])
            ipcMain.removeHandler(channel);
    };
}
