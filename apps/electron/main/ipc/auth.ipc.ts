/**
 * 认证相关 IPC 处理
 */
import { ipcMain } from "electron";
import { classifyDesktopLoginError } from "@mavis/shared/desktop-login-diagnostics";
import { IPC_CHANNELS } from "../config/constants";
import { windowManager } from "../windows";
import { resolveSharedOAuthAuthState } from "../windows/initial-auth";
import { logger } from "../utils";
import { stopLocalRuntime, prepareLocalRuntime } from "../modules/local-runtime";
import { clearSharedRuntimeProjection, refreshSharedRuntimeProjection } from "../modules/auth/runtime-projection";
import { clearUserInfo } from "./storage.ipc";
/**
 * 设置认证 IPC 处理器
 */
export function setupAuthIPC(options) {
    // 退出登录
    // 清除存储、停止本地 runtime 并切换到登录窗口
    ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
        try {
            await options.sharedAuthSession.logout(true);
            await clearSharedRuntimeProjection();
            clearUserInfo();
            // 2. 停止本地 runtime 并重置状态（token 已失效，下次登录时重新初始化）
            await stopLocalRuntime();
            // 3. 切换到登录窗口（关闭主窗口）
            await windowManager.switchToLoginWindow();
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 检查登录状态
    ipcMain.handle(IPC_CHANNELS.AUTH_CHECK_STATUS, async () => {
        const status = await options.sharedAuthSession.getStatus();
        return {
            isLoggedIn: await resolveSharedOAuthAuthState(options.sharedAuthSession),
            mode: status.mode === 'legacy-compatible' ? 'legacy-compatible' : 'shared-local',
        };
    });
    ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async (event) => {
        try {
            await options.sharedAuthSession.login((prompt) => {
                event.sender.send(IPC_CHANNELS.AUTH_DEVICE_AUTHORIZATION, prompt);
            });
            return { success: true };
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                diagnostics: classifyDesktopLoginError(error, 'login_failed', process.platform),
            };
        }
    });
    ipcMain.handle(IPC_CHANNELS.AUTH_CANCEL_LOGIN, async () => {
        try {
            await options.sharedAuthSession.cancelLogin();
            return { success: true };
        }
        catch (error) {
            return {
                success: false,
                error: String(error),
                diagnostics: classifyDesktopLoginError(error, 'cancel_failed', process.platform),
            };
        }
    });
    // 切换到登录窗口（用于 Electron 环境中需要重新登录时，如 token 过期）
    // 会销毁当前主窗口，创建新的登录窗口
    // source: 触发来源，用于日志追踪异常退出
    ipcMain.handle(IPC_CHANNELS.AUTH_NAVIGATE_TO_LOGIN, async (_, source) => {
        try {
            // 记录退出来源日志，便于排查异常退出问题
            logger.info(`[Auth] navigateToLogin triggered, source: ${source || 'unknown'}`);
            await windowManager.switchToLoginWindow();
            return { success: true };
        }
        catch (error) {
            console.error(`[Auth] navigateToLogin failed, source: ${source || 'unknown'}`, error);
            return { success: false, error: String(error) };
        }
    });
    // 登录成功后切换到 Archon Chat 窗口（新版默认主窗口）
    // 会销毁登录窗口
    ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN_COMPLETE, async (_, user) => {
        try {
            if (hasRendererCredentialFields(user)) {
                return {
                    success: false,
                    error: 'Renderer-provided tokens are rejected while Shared MCode OAuth is enabled.',
                };
            }
            let runtimeWarmupStarted = false;
            const startRuntimeWarmup = () => {
                if (runtimeWarmupStarted)
                    return;
                runtimeWarmupStarted = true;
                void prepareLocalRuntime()
                    .then((ready) => {
                    if (!ready)
                        logger.warn('[LocalRuntime] Warmup after login did not become ready');
                })
                    .catch((error) => logger.warn(`[LocalRuntime] Warmup after login failed: ${String(error)}`));
            };
            await refreshSharedRuntimeProjection(options.sharedAuthSession);
            startRuntimeWarmup();
            await windowManager.switchToArchonWindow();
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
}
function hasRendererCredentialFields(user) {
    if (!user)
        return false;
    return Object.entries(user).some(([key, value]) => {
        if (value === undefined || value === null || value === '')
            return false;
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
        return (normalized === 'authorization' ||
            normalized === 'cookie' ||
            normalized.endsWith('token') ||
            normalized.endsWith('credential') ||
            normalized.endsWith('secret'));
    });
}
