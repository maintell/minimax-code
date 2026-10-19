import { windowManager } from "./manager";
/**
 * 获取当前窗口引用
 */
export function getMainWindow() {
    return windowManager.getWindow();
}
