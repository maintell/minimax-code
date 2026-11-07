/**
 * `workspace/open?path=<dir>` asks Desktop to start a new task in a local
 * directory (sent by `mcode app`). The request may arrive before any renderer
 * can listen — on a cold start or while loading — so main keeps the latest one
 * until the main layout claims it. Signed out, it is dropped: the login (or
 * onboarding) page does not hold it for later.
 *
 * Any web page can fire this link, so the path is checked without blocking
 * the main process and without ever touching a network location.
 */
import { promises } from "fs";
import * as path from "path";
import { app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../config/constants";
import { logger } from "../../utils";
import { windowManager } from "../../windows";
export let WORKSPACE_OPEN_ACTION = 'workspace/open';
let pending = null;
/**
 * Windows contacts the host of a UNC (`\\host\share`), `\\?\UNC\` or device
 * path as soon as it is touched, sending the user's NTLM credentials, so only
 * drive-letter paths are accepted, before any fs call. The CLI already
 * resolved the path; it is kept as given (no realpath) so it names the same
 * project as Open Project.
 */
export function isAcceptableWorkspacePath(rawPath, platform = process.platform) {
    if (platform === 'win32')
        return /^[A-Za-z]:[\\/]/u.test(rawPath);
    return path.posix.isAbsolute(rawPath);
}
/** Only the main (archon) window can open a project; the others mean signed out. */
function isSignedOutWindow(type) {
    return type === 'login' || type === 'onboarding';
}
async function isDirectory(target) {
    try {
        return (await promises.stat(target)).isDirectory();
    }
    catch {
        return false;
    }
}
export async function rememberWorkspaceOpenRequest(action) {
    const workspaceDir = action.params.path;
    if (!workspaceDir ||
        !isAcceptableWorkspacePath(workspaceDir) ||
        !(await isDirectory(workspaceDir))) {
        logger.warn('[DeepLink] Ignoring workspace/open without an existing local directory');
        return;
    }
    if (isSignedOutWindow(windowManager.getWindowType())) {
        logger.info('[DeepLink] Dropped workspace/open: signed out');
        return;
    }
    pending = workspaceDir;
    logger.info('[DeepLink] Queued workspace/open request');
}
/** A cold start (or a logout) that lands on the login page drops the request. */
function dropWhenSignedOutWindowShows(window) {
    window.once('show', () => {
        if (pending && isSignedOutWindow(windowManager.getTypeByWindowId(window.id))) {
            pending = null;
            logger.info('[DeepLink] Dropped workspace/open: signed out');
        }
    });
}
/** Installs the claim IPC (each request is handed out once) and the sign-out drop. */
export function setupWorkspaceOpen() {
    app.on('browser-window-created', (_event, window) => dropWhenSignedOutWindowShows(window));
    ipcMain.handle(IPC_CHANNELS.DEEPLINK_TAKE_WORKSPACE_OPEN, () => {
        const workspaceDir = pending;
        pending = null;
        return workspaceDir;
    });
}
