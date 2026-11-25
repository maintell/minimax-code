/**
 * `plugin/try?name=<plugin>` asks Desktop to open Home with that plugin
 * mentioned in the composer, ready for the user's task (sent by the Chrome
 * extension's how-to page). Like `workspace/open`, main keeps the latest
 * request until the main layout claims it, and drops it when signed out.
 *
 * Any web page can fire this link, so only a well-formed plugin name is kept;
 * the renderer still mentions it only when the plugin is enabled locally.
 */
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../config/constants";
import { logger } from "../../utils";
import { windowManager } from "../../windows";
import { isSignedOutWindow } from "./workspace-open";
export let PLUGIN_TRY_ACTION = 'plugin/try';
/** The install contract accepts a plugin name of up to 80 characters. */
const MAX_PLUGIN_NAME_LENGTH = 80;
/** The same name shape the Runtime accepts: lowercase, separators between words. */
const PLUGIN_NAME_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
let pending = null;
export function isAcceptablePluginName(name) {
    return (typeof name === 'string' && name.length <= MAX_PLUGIN_NAME_LENGTH && PLUGIN_NAME_RE.test(name));
}
export function rememberPluginTryRequest(action) {
    const name = action.params.name;
    if (!isAcceptablePluginName(name)) {
        logger.warn('[DeepLink] Ignoring plugin/try without a valid plugin name');
        return;
    }
    if (isSignedOutWindow(windowManager.getWindowType())) {
        logger.info('[DeepLink] Dropped plugin/try: signed out');
        return;
    }
    pending = name;
    logger.info('[DeepLink] Queued plugin/try request');
}
function dropWhenSignedOutWindowShows(window) {
    window.once('show', () => {
        if (pending && isSignedOutWindow(windowManager.getTypeByWindowId(window.id))) {
            pending = null;
            logger.info('[DeepLink] Dropped plugin/try: signed out');
        }
    });
}
/** Installs the claim IPC (each request is handed out once) and the sign-out drop. */
export function setupPluginTry() {
    app.on('browser-window-created', (_event, window) => dropWhenSignedOutWindowShows(window));
    ipcMain.handle(IPC_CHANNELS.DEEPLINK_TAKE_PLUGIN_TRY, () => {
        const name = pending;
        pending = null;
        return name;
    });
}
