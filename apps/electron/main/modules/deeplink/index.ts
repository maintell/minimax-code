/**
 * Deep Link 模块
 * 支持从网页唤起桌面端应用
 *
 * 协议格式 (根据语言和环境区分):
 * - 国内版线上: minimax-cn://action?param1=value1&param2=value2
 * - 海外版线上: minimax://action?param1=value1&param2=value2
 * - 国内版测试: minimax-cn-test://action?param1=value1&param2=value2
 * - 海外版测试: minimax-test://action?param1=value1&param2=value2
 * - 国内版预发: minimax-cn-staging://action?param1=value1&param2=value2
 * - 海外版预发: minimax-staging://action?param1=value1&param2=value2
 *
 * 示例:
 * - minimax://open                    打开应用
 * - minimax://chat?message=hello      打开并发送消息
 * - minimax://navigate?url=xxx        打开并导航到指定页面
 * - minimax://auth-callback           OAuth 完成后仅唤起应用；凭证仍由 Shared OAuth Core 读取
 */
import * as path from "path";
import { app } from "electron";
import { getMainWindow, windowManager } from "../../windows";
import { IPC_CHANNELS } from "../../config/constants";
import { bringToFront } from "../../utils";
import { isTest, isStaging, isZh, isDev } from "../../config/env";
import { buildDevProtocolLaunchArgs } from "../../config/dev-protocol-launch";
import { resolveLocalRuntimeDataDir } from "../local-runtime/data-dir";
import { buildSingleInstanceLockKey } from "./single-instance-lock";
import { isSupportedDeepLinkUrl, parseDeepLink } from "./parse";
function getProtocolEnvSuffix() {
    const domainUrl = process.env.NEXT_PUBLIC_DOMAIN_URL || '';
    if (isTest ||
        domainUrl.includes('matrix-test.xaminim.com') ||
        domainUrl.includes('matrix-overseas-test.xaminim.com')) {
        return '-test';
    }
    if (isStaging ||
        domainUrl.includes('matrix-pre.xaminim.com') ||
        domainUrl.includes('matrix-overseas-pre.xaminim.com')) {
        return '-staging';
    }
    return '';
}
// 自定义协议名称：根据语言和环境区分
// 格式: minimax[-cn][-env]
// 例如: minimax (英文线上), minimax-cn (中文线上), minimax-test (英文测试), minimax-cn-staging (中文预发)
// 注意: 开发环境不需要区分，因为不会打包
function getProtocolNameByEnv() {
    const base = isZh ? 'minimax-cn' : 'minimax';
    const envSuffix = getProtocolEnvSuffix();
    return `${base}${envSuffix}`;
}
export let PROTOCOL_NAME = getProtocolNameByEnv();
function isDeepLinkUrl(url) {
    return isSupportedDeepLinkUrl(url);
}
// 注册的处理器
const handlers = new Map();
let deepLinkEventHandlersInstalled = false;
/**
 * 处理 Deep Link
 */
async function handleDeepLink(url) {
    // The registered protocol may be invoked with an invalid legacy callback.
    // Never log the raw URL because it can contain credentials before parsing
    // has had a chance to reject it.
    console.log('[DeepLink] handleDeepLink called');
    const parsed = parseDeepLink(url);
    if (!parsed) {
        console.log('[DeepLink] Failed to parse url');
        return;
    }
    console.log('[DeepLink] Parsed action:', parsed.action, 'params:', Object.keys(parsed.params));
    // 确保窗口存在并聚焦
    let mainWindow = getMainWindow();
    if (!mainWindow) {
        await windowManager.createInitialWindow();
        mainWindow = getMainWindow();
    }
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.focus();
        // 通知渲染进程
        mainWindow.webContents.send(IPC_CHANNELS.DEEPLINK_RECEIVED, parsed);
    }
    // 调用注册的处理器
    const handler = handlers.get(parsed.action);
    if (handler) {
        handler(parsed);
    }
    else {
        // 默认处理：只聚焦窗口
        console.log('[DeepLink] No handler for action:', parsed.action);
    }
}
/**
 * 注册 Deep Link 处理器
 */
export function registerDeepLinkHandler(action, handler) {
    handlers.set(action, handler);
}
/**
 * Acquire the single-instance lock before any protocol registration.
 * This small pre-bootstrap boundary lets the Electron entrypoint finalize
 * app identity/userData and apply startup guards before loading the rest of
 * the deep-link dependency graph.
 */
export function acquireSingleInstanceLock() {
    // Windows/Linux: 通过 second-instance 事件接收
    // 确保单实例运行：lock key 同时区分协议（中/外、test/staging）、构建环境
    // （dev/prod）和开发 worktree，既能与已安装的 `.app` 并存，也允许多个
    // worktree 的开发客户端并行运行。
    // 详见 single-instance-lock.ts 的注释。
    // 注意：必须在注册协议之前请求单实例锁，否则新启动的实例可能在退出前就注册了协议
    const lockKey = buildSingleInstanceLockKey(PROTOCOL_NAME, {
        isDev: isDev,
        isTest: isTest,
        isStaging: isStaging,
        devIdentity: process.env.MAVIS_ELECTRON_DEV_APP_ID,
    });
    const gotTheLock = app.requestSingleInstanceLock(lockKey);
    if (!gotTheLock) {
        // 另一个实例已在运行，退出当前实例
        // 不要做任何其他操作，直接退出
        app.quit();
        return false; // 提前返回，避免执行后续代码
    }
    return true;
}
/**
 * Install launch-time deep-link listeners immediately after the single-instance
 * lock is acquired. Electron does not replay second-instance/open-url events,
 * so lifecycle setup may safely repeat this call but must not be the first one.
 */
export function setupDeepLinkEventHandlers() {
    if (deepLinkEventHandlersInstalled)
        return;
    deepLinkEventHandlersInstalled = true;
    app.on('second-instance', (_event, commandLine) => {
        const url = commandLine.find(isDeepLinkUrl);
        if (url) {
            handleDeepLink(url);
        }
        bringToFront();
    });
    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleDeepLink(url);
    });
}
/**
 * 设置 Deep Link 协议
 * 必须在 app ready 之前调用
 */
export function setupDeepLink(lockAlreadyAcquired = false) {
    const gotTheLock = lockAlreadyAcquired || acquireSingleInstanceLock();
    if (!gotTheLock)
        return false;
    setupDeepLinkEventHandlers();
    // 设置为默认协议处理器
    if (isDev && process.platform === 'darwin') {
        // 每个 worktree 都有独立的开发版 .app，却共用测试环境的回调协议。
        // macOS 可能把当前 app 识别为协议客户端，同时仍把 URL 交给旧 worktree；
        // 因此开发启动时始终重新声明当前 app 为默认处理器。
        const ok = app.setAsDefaultProtocolClient(PROTOCOL_NAME);
        if (!ok) {
            console.warn(`[DeepLink] Failed to reclaim macOS dev protocol handler: ${PROTOCOL_NAME}`);
        }
    }
    else if (process.defaultApp) {
        // Dev mode starts the generic Electron binary. Always refresh the handler:
        // macOS can report Electron.app as the default client while its launch args
        // still point at the placeholder "path-to-app".
        const mainEntry = path.join(app.getAppPath(), 'dist', 'main', 'index.js');
        const protocolArgs = process.platform === 'win32'
            ? [mainEntry, ...buildDevProtocolLaunchArgs(buildDevProtocolLaunchEnvironment())]
            : [mainEntry];
        const ok = app.setAsDefaultProtocolClient(PROTOCOL_NAME, process.execPath, protocolArgs);
        if (!ok) {
            console.warn(`[DeepLink] Failed to register dev protocol handler: ${PROTOCOL_NAME}`);
        }
    }
    else {
        const isDefaultClient = app.isDefaultProtocolClient(PROTOCOL_NAME);
        if (!isDefaultClient) {
            if (process.platform === 'win32') {
                // Windows: production needs the concrete executable path.
                app.setAsDefaultProtocolClient(PROTOCOL_NAME, process.execPath);
            }
            else {
                // Packaged macOS/Linux builds declare schemes in electron-builder config.
                app.setAsDefaultProtocolClient(PROTOCOL_NAME);
            }
        }
    }
    // 检查启动参数中是否有 deep link（冷启动时）
    const deepLinkUrl = process.argv.find(isDeepLinkUrl);
    if (deepLinkUrl) {
        // 等待 app ready 后处理
        app.whenReady().then(() => {
            // 稍微延迟，确保窗口已创建
            setTimeout(() => handleDeepLink(deepLinkUrl), 500);
        });
    }
    return true;
}
function buildDevProtocolLaunchEnvironment() {
    return {
        NEXT_PUBLIC_BUILD_ENV: process.env.NEXT_PUBLIC_BUILD_ENV,
        NEXT_PUBLIC_LOCALE: process.env.NEXT_PUBLIC_LOCALE,
        NODE_ENV: process.env.NODE_ENV,
        MAVIS_DATA_DIR: resolveLocalRuntimeDataDir(),
        MAVIS_DEV_USE_GIT_PROFILE: process.env.MAVIS_DEV_USE_GIT_PROFILE,
        MAVIS_ELECTRON_DEV_APP_ID: process.env.MAVIS_ELECTRON_DEV_APP_ID,
        MAVIS_ELECTRON_DEV_APP_NAME: process.env.MAVIS_ELECTRON_DEV_APP_NAME,
        MAVIS_ELECTRON_DEV_DISPLAY_NAME: process.env.MAVIS_ELECTRON_DEV_DISPLAY_NAME,
        MAVIS_ELECTRON_DEV_LABEL: process.env.MAVIS_ELECTRON_DEV_LABEL,
        MAVIS_ELECTRON_DEV_USER_DATA_DIR: process.env.MAVIS_ELECTRON_DEV_USER_DATA_DIR,
        MAVIS_ELECTRON_DEV_PORT: process.env.MAVIS_ELECTRON_DEV_PORT,
    };
}
/**
 * 获取协议名称
 */
export function getProtocolName() {
    return PROTOCOL_NAME;
}
