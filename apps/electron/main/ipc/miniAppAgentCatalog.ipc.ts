import { ipcMain } from "electron";
import { readMiniAppAgentCreateRequest } from "@mavis/shared/miniapp-surface";
import { IPC_CHANNELS } from "../config/constants.js";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager.js";
import { modelsUtilityMiniAppAgent, agentsUtilityMiniAppAgent, createUtilityMiniAppAgent } from "../modules/local-runtime/utility";
import { failure, captureTabCaller, toFailureCode } from "./miniAppAgentIpcSupport";
/** `models` / `agents` take no page input; the tab alone decides what they list. */
const readNoInput = () => ({});
/**
 * Page `models` / `agents` / `create`: identity is the sending tab, a tab without a host chat is
 * allowed (the runtime then omits `host` and binds no chat model), and runtime errors map to the
 * same failure codes as the other Agent channels.
 */
export function setupMiniAppAgentCatalogIPC() {
    const manager = getEmbeddedBrowserManager();
    const channels = [];
    const serve = (channel, method, read, call) => {
        channels.push(channel);
        ipcMain.handle(channel, async (event, value) => {
            const input = read(value);
            if (input === null)
                return failure('invalid_request');
            const caller = captureTabCaller(manager, event);
            if (!caller)
                return failure('not_permitted');
            try {
                return { ok: true, result: await call(caller, input) };
            }
            catch (error) {
                return failure(toFailureCode(error, { pluginId: caller.pluginId, method }));
            }
        });
    };
    serve(IPC_CHANNELS.MINIAPP_AGENT_MODELS, 'agent.models', readNoInput, (caller) => modelsUtilityMiniAppAgent({ caller }));
    serve(IPC_CHANNELS.MINIAPP_AGENT_AGENTS, 'agent.agents', readNoInput, (caller) => agentsUtilityMiniAppAgent({ caller }));
    serve(IPC_CHANNELS.MINIAPP_AGENT_CREATE, 'agent.create', readMiniAppAgentCreateRequest, (caller, { agent }) => createUtilityMiniAppAgent({ caller, ...(agent !== undefined ? { agent } : {}) }));
    return () => {
        for (const channel of channels)
            ipcMain.removeHandler(channel);
    };
}
