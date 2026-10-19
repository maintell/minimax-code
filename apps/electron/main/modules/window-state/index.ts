/**
 * 主窗口位置/尺寸持久化。
 *
 * 关闭按钮默认走 hide-to-tray（见 windows/archonChatWindow.ts 的 close
 * handler），close 事件不是可靠的落盘时机，所以这里以 resize/move 的
 * debounce 写盘为主，close 时再补一次 flush。
 */
import { screen } from "electron";
import { MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT, MAIN_WINDOW_MIN_WIDTH, MAIN_WINDOW_MIN_HEIGHT } from "../../config/constants";
import { getStoredMainWindowState, setStoredMainWindowState } from "../../ipc/storage.ipc";
import logger from "../../utils/logger";
import { resolveStartupWindowState } from "./bounds";
const PERSIST_DEBOUNCE_MS = 400;
const MAIN_WINDOW_DEFAULTS = {
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
};
function currentWorkAreas() {
    try {
        return screen.getAllDisplays().map((display) => display.workArea);
    }
    catch (error) {
        // screen 仅在 app ready 之后可用；拿不到显示器信息时回落到默认尺寸。
        logger.warn(`[WindowState] Failed to read displays: ${String(error)}`);
        return [];
    }
}
/**
 * 读取上次退出时的窗口状态。读不到、数据损坏或屏幕布局已变化时，
 * bounds 返回 null，调用方沿用默认尺寸。
 */
export function readMainWindowStartupState() {
    let stored;
    try {
        stored = getStoredMainWindowState();
    }
    catch (error) {
        logger.warn(`[WindowState] Failed to read persisted window state: ${String(error)}`);
        return { bounds: null, maximized: false };
    }
    return resolveStartupWindowState({
        stored,
        workAreas: currentWorkAreas(),
        defaults: MAIN_WINDOW_DEFAULTS,
    });
}
/**
 * 监听窗口几何变化并持久化。返回解绑函数（测试与窗口重建时使用）。
 */
export function attachMainWindowStatePersistence(window) {
    let timer = null;
    let detached = false;
    const clearTimer = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    const persistNow = () => {
        clearTimer();
        if (detached || window.isDestroyed())
            return;
        try {
            // 全屏时窗口几何不代表用户偏好，跳过本次写入，保留上次记录。
            if (window.isFullScreen())
                return;
            // getNormalBounds 在最大化状态下返回还原后的尺寸，
            // 避免把最大化尺寸当成常态尺寸写进存档。
            const bounds = window.getNormalBounds();
            setStoredMainWindowState({
                bounds: {
                    x: Math.round(bounds.x),
                    y: Math.round(bounds.y),
                    width: Math.round(bounds.width),
                    height: Math.round(bounds.height),
                },
                maximized: window.isMaximized(),
            });
        }
        catch (error) {
            logger.warn(`[WindowState] Failed to persist window state: ${String(error)}`);
        }
    };
    const schedulePersist = () => {
        if (detached)
            return;
        clearTimer();
        timer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS);
    };
    window.on('resize', schedulePersist);
    window.on('move', schedulePersist);
    window.on('maximize', schedulePersist);
    window.on('unmaximize', schedulePersist);
    // close 会被 hide-to-tray 拦截，但事件本身仍会触发，用来补最后一次落盘。
    window.on('close', persistNow);
    return () => {
        if (detached)
            return;
        detached = true;
        clearTimer();
        if (!window.isDestroyed()) {
            window.off('resize', schedulePersist);
            window.off('move', schedulePersist);
            window.off('maximize', schedulePersist);
            window.off('unmaximize', schedulePersist);
            window.off('close', persistNow);
        }
    };
}
