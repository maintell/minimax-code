/**
 * 屏幕/Dock 相关工具函数
 */
import { screen } from "electron";
/**
 * 获取 Dock/任务栏位置信息
 * 通过比较屏幕 bounds 和 workArea 的差值来推断 Dock 位置
 *
 * macOS: Dock 可能在底部、左侧或右侧
 * Windows: 任务栏通常在底部，但也可能在其他位置
 */
export function getDockInfo() {
    const display = screen.getPrimaryDisplay();
    const { bounds, workArea } = display;
    // 计算各方向的差值（排除菜单栏后的差值）
    // topDiff 主要是 macOS 菜单栏，不作为 Dock 位置判断
    const bottomDiff = bounds.y + bounds.height - (workArea.y + workArea.height);
    const leftDiff = workArea.x - bounds.x;
    const rightDiff = bounds.x + bounds.width - (workArea.x + workArea.width);
    // 优先判断底部（最常见的 Dock/任务栏 位置）
    if (bottomDiff > 0) {
        return { position: 'bottom', height: bottomDiff, width: 0 };
    }
    else if (leftDiff > 0) {
        return { position: 'left', height: 0, width: leftDiff };
    }
    else if (rightDiff > 0) {
        return { position: 'right', height: 0, width: rightDiff };
    }
    return { position: 'none', height: 0, width: 0 };
}
