/**
 * 右键菜单 IPC 处理器
 * 为渲染进程提供文字选中后的右键复制功能，以及图片右键菜单
 */
import { shell, nativeImage, net, Menu, clipboard, ipcMain, BrowserWindow, MenuItem, app } from "electron";
import { fileURLToPath } from "node:url";
import { getIsEn } from "../utils/tool";
import { IPC_CHANNELS } from "../config/constants";
function getLocalImagePath(params) {
    const filePath = params.filePath?.trim();
    if (filePath)
        return filePath;
    const imageSrc = params.imageSrc?.trim();
    if (!imageSrc?.startsWith('file:'))
        return undefined;
    try {
        return fileURLToPath(imageSrc);
    }
    catch {
        return undefined;
    }
}
function isAbsoluteLocalPath(filePath) {
    return /^(\/|[a-zA-Z]:[\\/]|\\\\)/u.test(filePath);
}
function getRevealableImagePath(params) {
    const filePath = getLocalImagePath(params);
    if (!filePath || !isAbsoluteLocalPath(filePath))
        return undefined;
    return filePath;
}
function createShowImageInFolderMenuItem(filePath, isEn) {
    return {
        label: isEn ? 'Show in Folder' : '在文件夹中显示',
        click: () => {
            try {
                shell.showItemInFolder(filePath);
            }
            catch (error) {
                console.error('[ContextMenu] Show image in folder failed:', error);
            }
        },
    };
}
async function readImageForClipboard(params) {
    const filePath = getLocalImagePath(params);
    if (filePath) {
        const localImage = nativeImage.createFromPath(filePath);
        if (!localImage.isEmpty())
            return localImage;
    }
    const imageSrc = params.imageSrc?.trim();
    if (!imageSrc) {
        throw new Error('No image source available');
    }
    if (imageSrc.startsWith('data:')) {
        const dataImage = nativeImage.createFromDataURL(imageSrc);
        if (!dataImage.isEmpty())
            return dataImage;
        throw new Error('Unable to read image data URL');
    }
    const response = await net.fetch(imageSrc);
    if (!response.ok) {
        throw new Error(`Unable to fetch image: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const remoteImage = nativeImage.createFromBuffer(buffer);
    if (!remoteImage.isEmpty())
        return remoteImage;
    throw new Error('Unable to decode image');
}
function showCopyImageMenu(imageSrc) {
    const isEn = getIsEn();
    const menu = Menu.buildFromTemplate([
        {
            label: isEn ? 'Copy' : '复制',
            click: () => {
                void readImageForClipboard({ imageSrc })
                    .then((image) => {
                    clipboard.writeImage(image);
                })
                    .catch((error) => {
                    console.error('[ContextMenu] Copy image failed:', error);
                });
            },
        },
    ]);
    menu.popup();
}
function setupImageContextMenuIPC() {
    ipcMain.handle(IPC_CHANNELS.SYSTEM_SHOW_IMAGE_CONTEXT_MENU, async (event, params) => {
        const isEn = getIsEn();
        const filePath = getLocalImagePath(params);
        const revealableFilePath = getRevealableImagePath(params);
        const imageSrc = params.imageSrc?.trim();
        if (!filePath && !imageSrc) {
            return { success: false, error: 'No image context target' };
        }
        const template = [
            {
                label: isEn ? 'Copy' : '复制',
                click: () => {
                    void readImageForClipboard({ filePath, imageSrc })
                        .then((image) => {
                        clipboard.writeImage(image);
                    })
                        .catch((error) => {
                        console.error('[ContextMenu] Copy image failed:', error);
                    });
                },
            },
        ];
        if (revealableFilePath) {
            template.push({ type: 'separator' }, createShowImageInFolderMenuItem(revealableFilePath, isEn));
        }
        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: BrowserWindow.fromWebContents(event.sender) ?? undefined });
        return { success: true };
    });
}
/**
 * 为 WebContents 设置右键菜单
 */
function setupContextMenuForWebContents(webContents) {
    webContents.on('context-menu', (event, params) => {
        const isEn = getIsEn();
        // Image right-click: use Electron's built-in copyImageAt for reliable copying.
        if (params.mediaType === 'image') {
            const imagePath = getRevealableImagePath({ imageSrc: params.srcURL });
            const template = [
                {
                    label: isEn ? 'Copy' : '复制',
                    click: () => {
                        webContents.copyImageAt(params.x, params.y);
                    },
                },
            ];
            if (imagePath) {
                template.push({ type: 'separator' }, createShowImageInFolderMenuItem(imagePath, isEn));
            }
            const menu = Menu.buildFromTemplate(template);
            menu.popup();
            return;
        }
        const menu = new Menu();
        // 如果有选中的文字，显示复制选项
        if (params.selectionText) {
            menu.append(new MenuItem({
                label: isEn ? 'Copy' : '复制',
                role: 'copy',
            }));
        }
        // 如果是可编辑区域，显示粘贴选项
        if (params.isEditable) {
            menu.append(new MenuItem({
                label: isEn ? 'Paste' : '粘贴',
                role: 'paste',
            }));
            // 如果有选中文字，显示剪切选项
            if (params.selectionText) {
                menu.insert(0, new MenuItem({
                    label: isEn ? 'Cut' : '剪切',
                    role: 'cut',
                }));
            }
            // 全选
            menu.append(new MenuItem({
                label: isEn ? 'Select All' : '全选',
                role: 'selectAll',
            }));
        }
        // 只有当菜单有项目时才显示
        if (menu.items.length > 0) {
            menu.popup();
        }
    });
}
/**
 * 设置右键菜单 IPC
 * 监听所有新创建的 WebContents，为其添加右键菜单支持
 */
export function setupContextMenuIPC() {
    setupImageContextMenuIPC();
    // 监听所有新创建的 WebContents
    app.on('web-contents-created', (_, webContents) => {
        setupContextMenuForWebContents(webContents);
    });
    // 为已存在的窗口设置右键菜单
    BrowserWindow.getAllWindows().forEach((window) => {
        setupContextMenuForWebContents(window.webContents);
    });
}
