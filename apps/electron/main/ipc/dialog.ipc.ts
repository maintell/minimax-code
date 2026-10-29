/**
 * 对话框 IPC 处理
 */
import { ipcMain, dialog } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { resolveParentWindow, showDialogWithoutOverlay } from "../utils/dialog";
import { runWhileKeepingMiniChatVisible } from "../windows/archonMiniChatWindow";
import { getMainWindow } from "../windows/mainWindow";
import { inspectSessionHandoffPaths } from "./session-handoff-paths";
import { captureSelectedFileIssuer } from "../modules/document-preview/selected-file-authority";
/**
 * 设置对话框 IPC 处理器
 */
export function setupDialogIPC() {
    ipcMain.handle(IPC_CHANNELS.DIALOG_INSPECT_HANDOFF_PATHS, async (_event, value) => {
        return inspectSessionHandoffPaths(value);
    });
    // 端云交接只暴露一个“添加文件”入口。macOS 原生选择器支持在同一个
    // 对话框中选择文件或文件夹；其他平台也保持同一 IPC 契约，避免渲染层
    // 泄漏为两个产品动作。
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_HANDOFF_PATHS, async (event, options) => {
        const parentWindow = resolveParentWindow(event, getMainWindow);
        const properties = [
            'openFile',
            'multiSelections',
        ];
        // Electron only supports a mixed file/directory native chooser on macOS.
        // Windows and Linux keep the same single product entry and accept folders
        // through drag-and-drop in the renderer instead of silently becoming a
        // directory-only chooser.
        if (process.platform === 'darwin')
            properties.splice(1, 0, 'openDirectory');
        const dialogOptions = {
            title: options?.title || 'Select Files or Folders',
            defaultPath: options?.defaultPath,
            buttonLabel: options?.buttonLabel || 'Add',
            properties,
        };
        const showDialogFn = (win) => win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions);
        const result = options?.withoutOverlay
            ? await showDialogWithoutOverlay(parentWindow, showDialogFn)
            : await showDialogFn(parentWindow ?? undefined);
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, paths: [], canceled: true };
        }
        return { success: true, paths: result.filePaths, canceled: false };
    });
    // 选择工作目录
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async (event, options) => {
        const parentWindow = resolveParentWindow(event, getMainWindow);
        const dialogOptions = {
            title: options?.title || 'Select Directory',
            defaultPath: options?.defaultPath,
            buttonLabel: options?.buttonLabel || 'Select',
            properties: ['openDirectory', 'createDirectory'],
        };
        const showDialogFn = (win) => win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions);
        const result = await runWhileKeepingMiniChatVisible(parentWindow, () => options?.withoutOverlay
            ? showDialogWithoutOverlay(parentWindow, showDialogFn)
            : showDialogFn(parentWindow ?? undefined));
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, path: null, canceled: true };
        }
        return {
            success: true,
            path: result.filePaths[0],
            canceled: false,
        };
    });
    // 选择文件
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FILE, async (event, options) => {
        const parentWindow = resolveParentWindow(event, getMainWindow);
        const issueSelectedFiles = event.senderFrame === event.sender.mainFrame
            ? captureSelectedFileIssuer(event.sender)
            : () => ({});
        const properties = ['openFile'];
        if (options?.multiSelections) {
            properties.push('multiSelections');
        }
        const dialogOptions = {
            title: options?.title || 'Select File',
            defaultPath: options?.defaultPath,
            buttonLabel: options?.buttonLabel || 'Select',
            filters: options?.filters,
            properties,
        };
        const showDialogFn = (win) => win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions);
        const result = await runWhileKeepingMiniChatVisible(parentWindow, () => options?.withoutOverlay
            ? showDialogWithoutOverlay(parentWindow, showDialogFn)
            : showDialogFn(parentWindow ?? undefined));
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, paths: [], canceled: true };
        }
        return {
            success: true,
            paths: result.filePaths,
            selectedFileTokens: issueSelectedFiles(result.filePaths),
            canceled: false,
        };
    });
    // 保存文件对话框
    ipcMain.handle(IPC_CHANNELS.DIALOG_SAVE_FILE, async (event, options) => {
        const parentWindow = resolveParentWindow(event, getMainWindow);
        const dialogOptions = {
            title: options?.title || 'Save file',
            defaultPath: options?.defaultPath,
            buttonLabel: options?.buttonLabel || 'Save',
            filters: options?.filters,
        };
        const showDialogFn = (win) => win ? dialog.showSaveDialog(win, dialogOptions) : dialog.showSaveDialog(dialogOptions);
        const result = await runWhileKeepingMiniChatVisible(parentWindow, () => options?.withoutOverlay
            ? showDialogWithoutOverlay(parentWindow, showDialogFn)
            : showDialogFn(parentWindow ?? undefined));
        if (result.canceled || !result.filePath) {
            return { success: false, path: null, canceled: true };
        }
        return {
            success: true,
            path: result.filePath,
            canceled: false,
        };
    });
}
