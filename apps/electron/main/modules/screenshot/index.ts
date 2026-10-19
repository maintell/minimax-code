/**
 * Screenshot Module
 * 基于 electron-screenshots 实现截图功能
 * https://github.com/nashaofu/screenshots
 */
import * as path from "path";
import * as fs from "fs/promises";
import { systemPreferences, desktopCapturer, shell, app } from "electron";
import { getCategoryLogger } from "../../utils/logger";
import { getIsEn } from "../../utils/tool";
const log = getCategoryLogger('main');
// 延迟导入 Screenshots，避免在非 Electron 环境报错
let Screenshots = null;
let screenshotsInstance = null;
/**
 * 初始化 Screenshots 实例
 */
export function initScreenshots() {
    try {
        // 动态导入 electron-screenshots
        Screenshots = require('electron-screenshots');
        screenshotsInstance = new Screenshots({
            singleWindow: true, // 复用截图窗口，加快显示速度
            lang: getScreenshotLang(getIsEn() ? 'en' : 'zh'),
        });
    }
    catch (error) {
        log.error(`[Screenshot] Failed to initialize screenshots: ${error}`);
    }
}
/**
 * 检查屏幕录制权限（macOS 10.15+）
 * @returns 权限检查结果
 */
export async function checkScreenCapturePermission() {
    // 只在 macOS 上需要检查权限
    if (process.platform !== 'darwin') {
        return {
            hasPermission: true,
            status: 'granted',
            message: 'Screen capture permission is not required on this platform',
        };
    }
    try {
        // 检查是否支持屏幕录制权限 API（macOS 10.15+）
        if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== 'function') {
            log.info('[Screenshot] Screen capture permission API not available, assuming granted');
            return {
                hasPermission: true,
                status: 'granted',
                message: 'Permission API not available (older macOS version)',
            };
        }
        // 获取当前权限状态
        const status = systemPreferences.getMediaAccessStatus('screen');
        log.info(`[Screenshot] Current screen capture permission status: ${status}`);
        switch (status) {
            case 'granted':
                return {
                    hasPermission: true,
                    status: 'granted',
                };
            case 'not-determined':
                // askForMediaAccess 不支持 'screen'，需要用 desktopCapturer 触发系统原生权限弹窗
                log.info('[Screenshot] Triggering screen capture permission dialog via desktopCapturer...');
                try {
                    await desktopCapturer.getSources({
                        types: ['screen'],
                        thumbnailSize: { width: 1, height: 1 },
                    });
                    const newStatus = systemPreferences.getMediaAccessStatus('screen');
                    const granted = newStatus === 'granted';
                    return {
                        hasPermission: granted,
                        status: granted ? 'granted' : 'denied',
                        message: granted ? 'Permission granted' : 'Permission denied by user',
                    };
                }
                catch (error) {
                    log.error(`[Screenshot] Failed to trigger permission dialog: ${error}`);
                    openScreenCaptureSettings();
                    return {
                        hasPermission: false,
                        status: 'not-determined',
                        message: 'Failed to request permission, opened System Preferences',
                    };
                }
            case 'denied':
                log.info('[Screenshot] Permission denied, opening System Preferences...');
                openScreenCaptureSettings();
                return {
                    hasPermission: false,
                    status: 'denied',
                    message: 'Screen recording permission denied. Please grant permission in System Preferences > Security & Privacy > Privacy > Screen Recording',
                };
            case 'restricted':
                return {
                    hasPermission: false,
                    status: 'restricted',
                    message: 'Screen recording is restricted on this device (e.g., parental controls)',
                };
            default:
                return {
                    hasPermission: false,
                    status: 'unknown',
                    message: `Unknown permission status: ${status}`,
                };
        }
    }
    catch (error) {
        log.error(`[Screenshot] Error checking screen capture permission: ${error}`);
        return {
            hasPermission: false,
            status: 'unknown',
            message: `Error checking permission: ${error}`,
        };
    }
}
/**
 * 打开系统设置中的屏幕录制权限页面（macOS）
 */
export function openScreenCaptureSettings() {
    if (process.platform === 'darwin') {
        // macOS 10.15+ 系统设置路径
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    }
}
/**
 * 开始截图并保存到指定路径
 * @param workspaceDir - 工作目录，截图将保存到 {workspaceDir}/screenshots/ 目录
 * @returns 保存的截图文件路径
 */
export async function startScreenshot(workspaceDir) {
    if (!screenshotsInstance) {
        throw new Error('Screenshots not initialized');
    }
    // 检查屏幕录制权限（macOS）
    const permissionResult = await checkScreenCapturePermission();
    log.info(`[Screenshot] Permission result: ${JSON.stringify(permissionResult)}`);
    if (!permissionResult.hasPermission) {
        const error = new Error(permissionResult.message || 'Screen capture permission denied');
        error.type = 'permission';
        throw error;
    }
    return new Promise((resolve, reject) => {
        // 确定保存目录
        let saveDir;
        if (workspaceDir) {
            saveDir = path.join(workspaceDir, 'screenshots');
        }
        else {
            // 默认保存到用户下载目录的 screenshots 文件夹
            saveDir = path.join(app.getPath('downloads'), 'screenshots');
        }
        // 生成文件名：screenshot_YYYYMMDD_HHmmss.png
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
        const fileName = `screenshot_${timestamp}.png`;
        const filePath = path.join(saveDir, fileName);
        log.info(`[Screenshot] Starting capture, will save to: ${filePath}`);
        // 监听确认事件（用户点击确认按钮）
        // eslint-disable-next-line prefer-const
        let onOk;
        // eslint-disable-next-line prefer-const
        let onCancel;
        // 清理监听器的函数
        const cleanup = () => {
            screenshotsInstance.off('ok', onOk);
            screenshotsInstance.off('cancel', onCancel);
        };
        onOk = async (_event, buffer) => {
            try {
                // 确保目录存在
                await fs.mkdir(saveDir, { recursive: true });
                // 保存文件
                await fs.writeFile(filePath, buffer);
                log.info(`[Screenshot] Screenshot saved successfully: ${filePath}`);
                // 清理事件监听器
                cleanup();
                resolve(filePath);
            }
            catch (error) {
                log.error(`[Screenshot] Failed to save screenshot: ${error}`);
                cleanup();
                reject(error);
            }
        };
        // 监听取消事件（用户点击取消或按 ESC）
        onCancel = () => {
            log.info('[Screenshot] Screenshot cancelled by user');
            cleanup();
            reject(new Error('Screenshot cancelled'));
        };
        // 注册事件监听器
        screenshotsInstance.on('ok', onOk);
        screenshotsInstance.on('cancel', onCancel);
        // 开始截图
        try {
            screenshotsInstance.startCapture();
        }
        catch (error) {
            log.error(`[Screenshot] Failed to start capture: ${error}`);
            cleanup();
            reject(error);
        }
    });
}
/**
 * 获取 Screenshots 实例（用于清理）
 */
export function getScreenshotsInstance() {
    return screenshotsInstance;
}
export let screenshotI18n = {
    zh: {
        magnifier_position_label: '坐标',
        operation_ok_title: '确定',
        operation_cancel_title: '取消',
        operation_save_title: '保存',
        operation_redo_title: '重做',
        operation_undo_title: '撤销',
        operation_mosaic_title: '马赛克',
        operation_text_title: '文本',
        operation_brush_title: '画笔',
        operation_arrow_title: '箭头',
        operation_ellipse_title: '椭圆',
        operation_rectangle_title: '矩形',
    },
    en: {
        magnifier_position_label: 'Position',
        operation_ok_title: 'OK',
        operation_cancel_title: 'Cancel',
        operation_save_title: 'Save',
        operation_redo_title: 'Redo',
        operation_undo_title: 'Undo',
        operation_mosaic_title: 'Mosaic',
        operation_text_title: 'Text',
        operation_brush_title: 'Brush',
        operation_arrow_title: 'Arrow',
        operation_ellipse_title: 'Ellipse',
        operation_rectangle_title: 'Rectangle',
    },
};
export function getScreenshotLang(locale) {
    return screenshotI18n[locale] || screenshotI18n.zh;
}
