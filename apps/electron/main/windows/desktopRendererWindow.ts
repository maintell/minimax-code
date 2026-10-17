import { BrowserWindow } from "electron";
import { DESKTOP_WINDOW_KIND_ARGUMENT_PREFIX, DESKTOP_APPEARANCE_CAPABILITY_ARGUMENT_PREFIX } from "@mavis/shared/desktop-appearance";
import { IPC_CHANNELS } from "../config/constants";
import logger from "../utils/logger";
import { onDesktopAppearanceCommitted } from "../modules/desktop-appearance";
const WINDOW_CAPABILITIES = {
    main: { appearance: true },
    'mini-chat': { appearance: true },
    login: { appearance: true },
    onboarding: { appearance: true },
    'log-viewer': { appearance: true },
};
const registeredDesktopRenderers = new Map();
let appearanceBroadcastingInitialized = false;
function ensureAppearanceBroadcasting() {
    if (appearanceBroadcastingInitialized)
        return;
    onDesktopAppearanceCommitted(broadcastDesktopAppearance);
    appearanceBroadcastingInitialized = true;
}
function registerDesktopRenderer(window, kind, capabilities) {
    const { webContents } = window;
    registeredDesktopRenderers.set(webContents.id, { webContents, kind, capabilities });
    webContents.once('destroyed', () => {
        const registered = registeredDesktopRenderers.get(webContents.id);
        if (registered?.webContents === webContents) {
            registeredDesktopRenderers.delete(webContents.id);
        }
    });
}
export function createDesktopRendererWindow(kind, options) {
    ensureAppearanceBroadcasting();
    const capabilities = WINDOW_CAPABILITIES[kind];
    const existingArguments = (options.webPreferences?.additionalArguments ?? []).filter((argument) => !argument.startsWith(DESKTOP_WINDOW_KIND_ARGUMENT_PREFIX) &&
        !argument.startsWith(DESKTOP_APPEARANCE_CAPABILITY_ARGUMENT_PREFIX));
    const additionalArguments = [
        ...existingArguments,
        `${DESKTOP_WINDOW_KIND_ARGUMENT_PREFIX}${kind}`,
        `${DESKTOP_APPEARANCE_CAPABILITY_ARGUMENT_PREFIX}${capabilities.appearance ? '1' : '0'}`,
    ];
    const window = new BrowserWindow({
        ...options,
        webPreferences: {
            ...options.webPreferences,
            additionalArguments,
        },
    });
    registerDesktopRenderer(window, kind, capabilities);
    return window;
}
function broadcastDesktopAppearance(snapshot) {
    // Theme mode must reach every window (login and onboarding included), so
    // the broadcast is not capability-filtered; receivers decide what to apply.
    for (const [webContentsId, registered] of registeredDesktopRenderers) {
        if (registered.webContents.isDestroyed()) {
            registeredDesktopRenderers.delete(webContentsId);
            continue;
        }
        try {
            registered.webContents.send(IPC_CHANNELS.DESKTOP_APPEARANCE_CHANGED, snapshot);
        }
        catch (error) {
            logger.warn(`[DesktopAppearance] Failed to update ${registered.kind} window: ${String(error)}`);
        }
    }
}
