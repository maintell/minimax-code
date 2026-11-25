import { dialog, shell } from "electron";
import { describeConfigNotice, configIssuesFingerprint, readProfileConfigNotice } from "@mavis/config";
import logger from "../../utils/logger";
import { getIsEn } from "../../utils/tool";
import { getMainWindow } from "../../windows/mainWindow";
const OPEN_FILE_RESPONSE = 0;
const REVEAL_FILE_RESPONSE = 1;
const DISMISS_RESPONSE = 2;
/** Issue sets already shown in this process; re-created windows must not repeat them. */
const shownFingerprints = new Set();
export function buildConfigIssueNotice(issues, configPath, isEn, platform) {
    const reveal = platform === 'darwin'
        ? isEn
            ? 'Show in Finder'
            : '在访达中显示'
        : isEn
            ? 'Show in Folder'
            : '在文件夹中显示';
    const notice = describeConfigNotice(issues, isEn ? 'en' : 'zh', configPath);
    return {
        type: 'warning',
        title: notice.title,
        message: notice.summary,
        detail: `${notice.lines.map((line) => `• ${line}`).join('\n')}\n\n${notice.footer}`,
        buttons: [isEn ? 'Open config.yaml' : '打开 config.yaml', reveal, isEn ? 'OK' : '知道了'],
        defaultId: OPEN_FILE_RESPONSE,
        cancelId: DISMISS_RESPONSE,
        noLink: true,
    };
}
/**
 * Tells the user that config.yaml was partly or wholly ignored. Config loading
 * already fell back to defaults; without this notice the app would silently run
 * with settings the user did not choose.
 */
export async function notifyConfigIssues(dependencies = productionDependencies()) {
    const { issues, configPath, acknowledge } = dependencies.readNotice();
    if (issues.length === 0)
        return;
    const key = configIssuesFingerprint(issues);
    if (shownFingerprints.has(key))
        return;
    shownFingerprints.add(key);
    dependencies.warn(`[ConfigIssues] config.yaml fell back to defaults: ${issues
        .map((issue) => (issue.section ? `${issue.kind}:${issue.section}` : issue.kind))
        .join(', ')}`);
    let response;
    try {
        ({ response } = await dependencies.showMessageBox(dependencies.parentWindow(), buildConfigIssueNotice(issues, configPath, dependencies.isEn(), dependencies.platform)));
    }
    catch (error) {
        // Not shown: let a later call in this launch try again.
        shownFingerprints.delete(key);
        throw error;
    }
    // Shown: lost settings need not be told again; fixable problems keep showing.
    acknowledge();
    if (response === OPEN_FILE_RESPONSE) {
        const error = await dependencies.openPath(configPath);
        if (error) {
            dependencies.warn(`[ConfigIssues] could not open config.yaml: ${error}`);
            dependencies.showItemInFolder(configPath);
        }
    }
    else if (response === REVEAL_FILE_RESPONSE) {
        dependencies.showItemInFolder(configPath);
    }
}
const NOTICE_RETRY_DELAYS_MS = [5000, 30000];
/**
 * Shows the notice, trying again later when the dialog cannot be shown (for
 * example the window was replaced while it opened). Throws the last error so
 * the caller can log it; the problems stay unacknowledged for the next launch.
 */
export async function notifyConfigIssuesWithRetry(dependencies = productionDependencies(), wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())) {
    for (let attempt = 0;; attempt += 1) {
        try {
            await notifyConfigIssues(dependencies);
            return;
        }
        catch (error) {
            const delayMs = NOTICE_RETRY_DELAYS_MS[attempt];
            if (delayMs === undefined)
                throw error;
            dependencies.warn(`[ConfigIssues] notice not shown, retrying in ${delayMs} ms`);
            await wait(delayMs);
        }
    }
}
function productionDependencies() {
    return {
        readNotice: readProfileConfigNotice,
        isEn: getIsEn,
        platform: process.platform,
        parentWindow: () => {
            const window = getMainWindow();
            return window && !window.isDestroyed() ? window : null;
        },
        showMessageBox: (parent, options) => parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options),
        openPath: (filePath) => shell.openPath(filePath),
        showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
        warn: (message) => logger.warn(message),
    };
}
export function resetConfigIssueNoticeForTest() {
    shownFingerprints.clear();
}
