import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { bindUtilityRuntimeRendererWebContentsLifecycle } from "../modules/local-runtime/utility/renderer-lifecycle";
/** Registers the preload -> Main transport-mode request boundary. */
export function setupUtilityRuntimeTransportIPC(options) {
    const lifecycleBoundRenderers = new WeakSet();
    ipcMain.handle(IPC_CHANNELS.RUNTIME_TRANSPORT_REQUEST_PORT, async (event) => {
        if (options.mode === 'protocol') {
            return {
                mode: 'protocol',
                enabled: false,
                connected: false,
            };
        }
        try {
            if (!lifecycleBoundRenderers.has(event.sender)) {
                bindUtilityRuntimeRendererWebContentsLifecycle(event.sender, options.disconnectRenderer);
                lifecycleBoundRenderers.add(event.sender);
            }
            const result = await options.connectRenderer(event.sender);
            if (result.connected) {
                return {
                    mode: 'direct',
                    enabled: true,
                    connected: true,
                };
            }
            return {
                mode: 'direct',
                enabled: true,
                connected: false,
                ...(result.terminal === true ? { terminal: true } : {}),
            };
        }
        catch (error) {
            options.warn(`[UtilityRuntime] renderer port request failed: ${String(error)}`);
            // Electron always owns the utility-process transport. A failed request
            // means the utility is temporarily unavailable, not that the app should
            // select the retired in-process runtime.
            return {
                mode: 'direct',
                enabled: true,
                connected: false,
            };
        }
    });
}
