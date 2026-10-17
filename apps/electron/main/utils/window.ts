import { app } from "electron";
import http from "node:http";
import { getMainWindow, windowManager } from "../windows";
/**
 * 将主窗口带到前台
 * @param options.createIfNotExists 窗口不存在时是否创建新窗口，默认 true
 */
export const bringToFront = (options = {}) => {
    const { createIfNotExists = true } = options;
    let mainWindow = getMainWindow();
    // 检查窗口是否存在且未被销毁
    if (!mainWindow || mainWindow.isDestroyed()) {
        if (createIfNotExists) {
            // 如果窗口不存在或已销毁，创建新窗口
            windowManager.createInitialWindow();
            mainWindow = getMainWindow();
        }
        else {
            // 不创建新窗口，直接返回
            return;
        }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        // 如果窗口最小化了，恢复它
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        // 显示窗口（如果隐藏了）
        if (!mainWindow.isVisible()) {
            mainWindow.show();
        }
        // macOS: 先激活应用，确保应用成为前台应用
        if (process.platform === 'darwin') {
            app.dock?.show();
            app.focus({ steal: true });
        }
        // 聚焦窗口
        mainWindow.focus();
    }
};

/**
 * 将主窗口带到前台（异步版本）
 * @param options.createIfNotExists 窗口不存在时是否创建新窗口，默认 true
 */
export const bringToFrontAsync = async (options = {}) => {
    const { createIfNotExists = true } = options;
    let mainWindow = getMainWindow();
    // 检查窗口是否存在且未被销毁
    if (!mainWindow || mainWindow.isDestroyed()) {
        if (createIfNotExists) {
            // 如果窗口不存在或已销毁，创建新窗口
            await windowManager.createInitialWindow();
            mainWindow = getMainWindow();
        }
        else {
            // 不创建新窗口，直接返回
            return;
        }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
        // 如果窗口最小化了，恢复它
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        // 显示窗口（如果隐藏了）
        if (!mainWindow.isVisible()) {
            mainWindow.show();
        }
        // macOS: 先激活应用，确保应用成为前台应用
        if (process.platform === 'darwin') {
            app.dock?.show();
            app.focus({ steal: true });
        }
        // 聚焦窗口
        mainWindow.focus();
    }
};

/**
 * 窗口工具函数
 * 等待服务器就绪
 */
export const waitForServer = async (url, maxAttempts = 90) => {
    // First compile of heavy pages (mermaid/langium) can take 50-100s in dev.
    // Use a longer per-request timeout so we don't abandon requests mid-compile.
    const REQUEST_TIMEOUT_MS = 5000;
    const RETRY_DELAY_MS = 3000;
    for (let i = 0; i < maxAttempts; i++) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.get(url, (res) => {
                    const statusCode = res.statusCode ?? 0;
                    res.resume();
                    if (statusCode >= 200 && statusCode < 400) {
                        resolve();
                    }
                    else {
                        reject(new Error(`Status: ${statusCode}`));
                    }
                });
                req.on('error', reject);
                req.setTimeout(REQUEST_TIMEOUT_MS, () => {
                    req.destroy();
                    reject(new Error('Timeout'));
                });
            });
            // eslint-disable-next-line no-console
            console.log('Next.js server is ready');
            return true;
        }
        catch {
            // eslint-disable-next-line no-console
            console.log(`Waiting for Next.js server... (${i + 1}/${maxAttempts})`);
            if (i < maxAttempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }
    }
    return false;
};

