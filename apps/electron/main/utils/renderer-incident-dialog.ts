import path from "node:path";
import { dialog, clipboard } from "electron";
import { uploadLog } from "../ipc/system.ipc";
import { getUserInfo } from "../ipc/storage.ipc";
import { getIsEn } from "./tool";
export async function showRendererIncidentDialog({ parentWindow, title, message, detail, onReload, onRestart, findLatestCrashDump, }) {
    const isEn = getIsEn();
    const showMessageBox = (options) => parentWindow ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options);
    const buttons = isEn
        ? ['Reload', 'Upload Logs', 'Quit & Restart', 'Later']
        : ['重新加载', '上传日志', '退出并重启', '稍后处理'];
    const { response } = await showMessageBox({
        type: 'warning',
        title: title ?? (isEn ? 'Page issue detected' : '页面异常'),
        message: message ?? (isEn ? 'The page stopped responding.' : '页面运行异常。'),
        detail,
        buttons,
        defaultId: 0,
        cancelId: 3,
        noLink: true,
    });
    if (response === 0) {
        onReload();
        return;
    }
    if (response === 1) {
        const crashDump = await findLatestCrashDump?.().catch(() => null);
        const extraFiles = crashDump
            ? [
                {
                    name: crashDump.name || path.basename(crashDump.path),
                    path: crashDump.path,
                },
            ]
            : undefined;
        const result = await uploadLog(extraFiles);
        if (result.success) {
            const uploadId = result.uploadId ?? '';
            if (uploadId) {
                clipboard.writeText(uploadId);
            }
            const userInfo = getUserInfo();
            const uid = userInfo?.realUserID || userInfo?.userID || '';
            await showMessageBox({
                type: 'info',
                title: isEn ? 'Logs uploaded' : '日志上传成功',
                message: isEn ? 'The diagnostic logs were uploaded.' : '异常日志已上传。',
                detail: `${uid ? `UID: ${uid}\n` : ''}${uploadId ? `UploadId: ${uploadId}` : ''}`,
                buttons: [isEn ? 'OK' : '知道了'],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
            });
        }
        else {
            await showMessageBox({
                type: 'error',
                title: isEn ? 'Log upload failed' : '日志上传失败',
                message: isEn ? 'Log upload failed. Please try again later.' : '日志上传失败，请稍后重试。',
                detail: result.error,
                buttons: [isEn ? 'OK' : '知道了'],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
            });
        }
        return;
    }
    if (response === 2) {
        onRestart();
    }
}
