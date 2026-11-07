/**
 * File Tools IPC 处理器
 */
import { ipcMain, app } from "electron";
import { stageAttachment } from "../modules/file/stage-attachment";
import { saveWorkbook } from "../modules/file/save-workbook.js";
import { IPC_CHANNELS } from "../config/constants";
import { readFileCommand, writeFileCommand, editFileCommand, multiEditFileCommand, globSearchCommand, grepSearchCommand, listDirectoryCommand, statFileCommand, deleteFileCommand, moveFileCommand, copyFileCommand, downloadFileCommand, uploadFileCommand, trashFileCommand, chmodFileCommand } from "../modules/file";
/**
 * 设置 File Tools IPC 处理器
 */
export function setupFileIPC() {
    ipcMain.handle(IPC_CHANNELS.FILE_STAGE_ATTACHMENT, async (_, fileName, bytes) => {
        return stageAttachment(app.getPath('userData'), fileName, bytes);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_SAVE_WORKBOOK, async (event, params) => {
        if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
            throw new Error('Workbook save requires the application frame');
        return saveWorkbook(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_, params) => {
        return readFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_WRITE, async (_, params) => {
        return writeFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_EDIT, async (_, params) => {
        return editFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_MULTI_EDIT, async (_, params) => {
        return multiEditFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_GLOB, async (_, params) => {
        return globSearchCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_GREP, async (_, params) => {
        return grepSearchCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_LIST, async (_, params) => {
        return listDirectoryCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_, params) => {
        return statFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_DELETE, async (_, params) => {
        return deleteFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_MOVE, async (_, params) => {
        return moveFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_COPY, async (_, params) => {
        return copyFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_DOWNLOAD, async (_, params) => {
        return downloadFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_UPLOAD, async (_, params) => {
        return uploadFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_TRASH, async (_, params) => {
        return trashFileCommand(params);
    });
    ipcMain.handle(IPC_CHANNELS.FILE_CHMOD, async (_, params) => {
        return chmodFileCommand(params);
    });
}
