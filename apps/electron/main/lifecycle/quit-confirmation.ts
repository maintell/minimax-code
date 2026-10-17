import { randomUUID } from "node:crypto";
import { ipcMain, dialog } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { getIsEn } from "../utils/tool";
const TASK_QUERY_TIMEOUT_MS = 2000;
function requestRendererConfirmation(window) {
    return new Promise((resolve) => {
        const requestId = randomUUID();
        const contents = window.webContents;
        let finished = false;
        let waitingForUser = false;
        const finish = (result) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            ipcMain.removeListener(IPC_CHANNELS.APP_QUIT_CONFIRMATION_RESULT, onResult);
            contents.removeListener('render-process-gone', onUnavailable);
            contents.removeListener('destroyed', onUnavailable);
            contents.removeListener('did-start-navigation', onNavigation);
            // Dismiss any late UI request before falling back to a native dialog.
            try {
                if (!contents.isDestroyed())
                    contents.send(IPC_CHANNELS.APP_QUIT_CONFIRMATION_ABORT, requestId);
            }
            catch {
                // A disappearing renderer must not prevent the request from settling.
            }
            resolve(result);
        };
        const onUnavailable = () => finish(false);
        const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
            if (isMainFrame && !isInPlace)
                finish(false);
        };
        const onResult = (event, result) => {
            if (event.sender !== contents || event.senderFrame !== contents.mainFrame)
                return;
            if (!result || typeof result !== 'object')
                return;
            const reply = result;
            if (reply.requestId !== requestId)
                return;
            if (typeof reply.confirmed === 'boolean') {
                finish(reply.confirmed);
            }
            else if (reply.pending === true && !waitingForUser) {
                waitingForUser = true;
                clearTimeout(timer);
                if (!window.isDestroyed()) {
                    if (window.isMinimized())
                        window.restore();
                    window.show();
                    window.focus();
                }
            }
        };
        const timer = setTimeout(() => finish(undefined), TASK_QUERY_TIMEOUT_MS);
        ipcMain.on(IPC_CHANNELS.APP_QUIT_CONFIRMATION_RESULT, onResult);
        contents.once('render-process-gone', onUnavailable);
        contents.once('destroyed', onUnavailable);
        contents.on('did-start-navigation', onNavigation);
        try {
            contents.send(IPC_CHANNELS.APP_QUIT_CONFIRMATION_REQUEST, requestId);
        }
        catch {
            finish(undefined);
        }
    });
}
/** ConfirmModal owns the normal flow; native UI is only an unresponsive-renderer fallback. */
export async function confirmQuitWithRunningTasks(window) {
    if (!window || window.isDestroyed())
        return true;
    const confirmed = await requestRendererConfirmation(window);
    if (confirmed !== undefined)
        return confirmed;
    const isEn = getIsEn();
    const options = {
        type: 'warning',
        title: isEn ? 'Quit application?' : '退出应用？',
        message: isEn ? 'Unable to check running tasks' : '暂时无法确认任务运行状态',
        detail: isEn
            ? 'Quitting will interrupt local tasks. Are you sure you want to quit?'
            : '退出应用会中断本地任务，确定要退出吗？',
        buttons: isEn ? ['Cancel', 'Quit Application'] : ['取消', '退出应用'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    };
    if (window.isDestroyed())
        return (await dialog.showMessageBox(options)).response === 1;
    if (window.isMinimized())
        window.restore();
    window.show();
    window.focus();
    return (await dialog.showMessageBox(window, options)).response === 1;
}
