import * as path from "path";
import { app, nativeImage } from "electron";
import { isDev } from "../../config";
/**
 * 获取托盘图标
 * macOS: 需要使用 Template 图标（16x16 或 22x22，黑白色）
 * Windows: 可以使用彩色图标（建议 16x16 或 32x32）
 *
 * 图标文件说明：
 * - resources/trayTemplate.png: macOS 托盘图标（22x22，黑色模板，透明背景）
 * - resources/trayTemplate@2x.png: macOS Retina 托盘图标（44x44，macOS 自动加载）
 * - resources/tray.png: Windows/Linux 托盘图标（32x32，可彩色）
 * - resources/tray.ico: Windows 托盘图标（多尺寸 ico 文件）
 */
export function getTrayIcon() {
    const resourcesPath = isDev
        ? path.join(app.getAppPath(), 'resources')
        : path.join(process.resourcesPath, 'resources');
    let icon;
    if (process.platform === 'darwin') {
        // macOS: 尝试加载 Template 图标
        const templatePath = path.join(resourcesPath, 'trayTemplate.png');
        icon = nativeImage.createFromPath(templatePath);
        if (icon.isEmpty()) {
            // 如果没有专用托盘图标，使用应用图标并调整大小
            const icnsPath = path.join(resourcesPath, 'icon.icns');
            icon = nativeImage.createFromPath(icnsPath);
            if (!icon.isEmpty()) {
                icon = icon.resize({ width: 22, height: 22 });
            }
        }
        // 设置为 Template 图标（自动适应系统主题）
        icon.setTemplateImage(true);
    }
    else if (process.platform === 'win32') {
        // Windows: 尝试加载 ico 或 png
        const icoPath = path.join(resourcesPath, 'tray.ico');
        const pngPath = path.join(resourcesPath, 'tray.png');
        icon = nativeImage.createFromPath(icoPath);
        if (icon.isEmpty()) {
            icon = nativeImage.createFromPath(pngPath);
        }
        if (icon.isEmpty()) {
            // 使用应用图标
            const iconPath = path.join(resourcesPath, 'icon.ico');
            icon = nativeImage.createFromPath(iconPath);
            if (!icon.isEmpty()) {
                icon = icon.resize({ width: 32, height: 32 });
            }
        }
    }
    else {
        // Linux
        const pngPath = path.join(resourcesPath, 'tray.png');
        icon = nativeImage.createFromPath(pngPath);
        if (icon.isEmpty()) {
            const icnsPath = path.join(resourcesPath, 'icon.icns');
            icon = nativeImage.createFromPath(icnsPath);
            if (!icon.isEmpty()) {
                icon = icon.resize({ width: 22, height: 22 });
            }
        }
    }
    return icon;
}
