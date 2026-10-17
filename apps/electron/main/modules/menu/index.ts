/**
 * 应用菜单模块
 */
import { shell, dialog, Menu } from "electron";
import { hideWindowsMenuBar } from "../../windows/windows-titlebar";
import { isDev, isTest, isStaging, isInternalBuild } from "../../config";
import { IPC_CHANNELS, DOMAIN_URL, DISPLAY_NAME } from "../../config/constants";
import { bringToFront } from "../../utils/window";
import { getUserInfo } from "../../ipc/storage.ipc";
import { uploadLog } from "../../ipc/system.ipc";
import { getIsEn } from "../../utils/tool";
import { getMainWindow } from "../../windows";
import { closeLogViewerWindow, createLogViewerWindow } from "../../windows/logViewerWindow";
import { getDeveloperOptions, setDeveloperOptions } from "../developer-options";
/** 通知当前产品窗口打开更新弹窗。登录页和主窗口共用同一条 IPC。 */
function notifyRendererToOpenUpdateModal() {
    const win = getMainWindow();
    if (win && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.UPDATER_OPEN_MODAL);
    }
}
function buildMacUpdateSubmenu(isEn, onCheckForUpdates) {
    if (isDev)
        return [];
    return [
        {
            label: isEn ? 'Check for Updates' : '检查更新',
            click: onCheckForUpdates,
        },
        { type: 'separator' },
    ];
}
/**
 * 通知渲染进程打开反馈弹窗（Archon 窗口版本）
 */
function notifyArchonRendererToOpenFeedback() {
    const win = getMainWindow();
    if (win && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.MENU_OPEN_FEEDBACK);
    }
}
/** Keep the menu action while the renderer dispatches contextual Cmd+W handling and fallback. */
function closeArchonWindow() {
    const win = getMainWindow();
    if (win && !win.isDestroyed())
        win.close();
}
function closeNativeDevTools() {
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.closeDevTools();
    }
}
function buildDeveloperMenu(isEn, surface) {
    const options = getDeveloperOptions();
    if (!options.available)
        return null;
    const refreshMenu = surface === 'login' ? setupLoginMenu : setupArchonMenu;
    const showLoginLogs = surface === 'login' && (isTest || isStaging || isInternalBuild);
    return {
        label: isEn ? 'Developer' : '开发者',
        submenu: surface === 'archon'
            ? [
                {
                    label: options.enabled
                        ? isEn
                            ? 'Disable Developer Panel'
                            : '关闭开发者面板'
                        : isEn
                            ? 'Enable Developer Panel'
                            : '开启开发者面板',
                    accelerator: 'F12',
                    click: () => {
                        setDeveloperOptions({ enabled: !getDeveloperOptions().enabled });
                        refreshMenu();
                    },
                },
            ]
            : [
                {
                    label: isEn ? 'Enable Developer Features' : '启用开发者功能',
                    type: 'checkbox',
                    checked: options.enabled,
                    click: () => {
                        const result = setDeveloperOptions({ enabled: !options.enabled });
                        if (result.success && !result.state.enabled) {
                            closeNativeDevTools();
                            closeLogViewerWindow();
                        }
                        refreshMenu();
                    },
                },
                ...(showLoginLogs
                    ? [
                        { type: 'separator' },
                        {
                            label: isEn ? 'Open Logs' : '打开日志',
                            enabled: options.enabled,
                            click: async () => {
                                if (!getDeveloperOptions().enabled)
                                    return;
                                await createLogViewerWindow();
                            },
                        },
                    ]
                    : []),
            ],
    };
}
/**
 * 构建帮助菜单子项（登录、主窗口、Archon 共用）
 */
function buildHelpSubmenu(isEn, onCheckForUpdates, onOpenFeedback) {
    const isMac = process.platform === 'darwin';
    return [
        // Windows: 检查更新放在帮助菜单（macOS 在应用菜单里已有）
        ...(!isMac && !isDev && onCheckForUpdates
            ? [
                {
                    label: isEn ? 'Check for Updates' : '检查更新',
                    click: onCheckForUpdates,
                },
                { type: 'separator' },
            ]
            : []),
        {
            label: isEn ? 'Docs' : '产品文档',
            click: async () => {
                await shell.openExternal(`${DOMAIN_URL}/docs/changelog`);
            },
        },
        // 上传日志
        ...[
            { type: 'separator' },
            {
                label: isEn ? 'Feedback' : '问题反馈',
                click: async () => {
                    bringToFront();
                    if (typeof onOpenFeedback === 'function') {
                        // Archon window: notify renderer to open the feedback dialog
                        onOpenFeedback();
                    }
                    else {
                        // Legacy window (mmx-agent): direct upload + native dialog
                        const result = await uploadLog();
                        if (result.success) {
                            const content = `uid: ${getUserInfo()?.realUserID}\nuploadId: ${result.uploadId}`;
                            dialog.showMessageBox({ message: content });
                        }
                    }
                },
            },
        ],
    ];
}
/**
 * 设置登录窗口的简化菜单
 */
export function setupLoginMenu() {
    const isMac = process.platform === 'darwin';
    const isEn = getIsEn();
    const developerMenu = buildDeveloperMenu(isEn, 'login');
    const template = [
        // 应用菜单 (仅 macOS)
        ...(isMac
            ? [
                {
                    label: DISPLAY_NAME,
                    submenu: [
                        {
                            role: 'about',
                            label: isEn ? `About ${DISPLAY_NAME}` : `关于 ${DISPLAY_NAME}`,
                        },
                        { type: 'separator' },
                        ...buildMacUpdateSubmenu(isEn, notifyRendererToOpenUpdateModal),
                        { role: 'hide', label: isEn ? 'Hide' : '隐藏' },
                        { role: 'hideOthers', label: isEn ? 'Hide Others' : '隐藏其他' },
                        { role: 'unhide', label: isEn ? 'Unhide' : '显示所有' },
                        { type: 'separator' },
                        { role: 'quit', label: isEn ? 'Quit' : '退出' },
                    ],
                },
            ]
            : []),
        // 编辑菜单（保留基本编辑功能）
        {
            label: isEn ? 'Edit' : '编辑',
            submenu: [
                { role: 'undo', label: isEn ? 'Undo' : '撤销' },
                { role: 'redo', label: isEn ? 'Redo' : '重做' },
                { type: 'separator' },
                { role: 'cut', label: isEn ? 'Cut' : '剪切' },
                { role: 'copy', label: isEn ? 'Copy' : '复制' },
                { role: 'paste', label: isEn ? 'Paste' : '粘贴' },
                { role: 'selectAll', label: isEn ? 'Select All' : '全选' },
            ],
        },
        // 视图菜单
        {
            label: isEn ? 'View' : '视图',
            submenu: [
                { role: 'zoomIn', label: isEn ? 'Zoom In' : '放大' },
                { role: 'zoomOut', label: isEn ? 'Zoom Out' : '缩小' },
                { role: 'resetZoom', label: isEn ? 'Actual Size' : '实际大小' },
            ],
        },
        // 窗口菜单
        {
            label: isEn ? 'Window' : '窗口',
            submenu: [
                { role: 'minimize', label: isEn ? 'Minimize' : '最小化' },
                ...(isMac
                    ? [{ role: 'close', label: isEn ? 'Close' : '关闭' }]
                    : [{ role: 'quit', label: isEn ? 'Quit' : '退出' }]),
            ],
        },
        ...(developerMenu ? [developerMenu] : []),
        // 帮助菜单
        {
            label: isEn ? 'Help' : '帮助',
            submenu: buildHelpSubmenu(isEn, notifyRendererToOpenUpdateModal),
        },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
/**
 * 设置 Archon Chat 窗口的菜单
 * 基于主窗口菜单裁剪：无标签页、无小窗，IPC 直接发送到窗口 webContents
 */
export function setupArchonMenu() {
    const isMac = process.platform === 'darwin';
    const isEn = getIsEn();
    const mainWindow = getMainWindow();
    const developerMenu = buildDeveloperMenu(isEn, 'archon');
    const template = [
        // 应用菜单 (仅 macOS)
        ...(isMac
            ? [
                {
                    label: DISPLAY_NAME,
                    submenu: [
                        {
                            role: 'about',
                            label: isEn ? `About ${DISPLAY_NAME}` : `关于 ${DISPLAY_NAME}`,
                        },
                        { type: 'separator' },
                        ...buildMacUpdateSubmenu(isEn, notifyRendererToOpenUpdateModal),
                        {
                            label: isEn ? 'Settings' : '设置',
                            click: () => {
                                const win = getMainWindow();
                                if (win && !win.webContents.isDestroyed()) {
                                    bringToFront();
                                    win.webContents.send(IPC_CHANNELS.MENU_OPEN_SETTINGS);
                                }
                            },
                        },
                        { type: 'separator' },
                        { role: 'services' },
                        { type: 'separator' },
                        { role: 'hide', label: isEn ? 'Hide' : '隐藏' },
                        { role: 'hideOthers' },
                        { role: 'unhide' },
                        { type: 'separator' },
                        { role: 'quit', label: isEn ? 'Quit' : '退出' },
                    ],
                },
            ]
            : []),
        // 编辑菜单
        {
            label: isEn ? 'Edit' : '编辑',
            submenu: [
                { role: 'undo', label: isEn ? 'Undo' : '撤销' },
                { role: 'redo', label: isEn ? 'Redo' : '重做' },
                { type: 'separator' },
                { role: 'cut', label: isEn ? 'Cut' : '剪切' },
                { role: 'copy', label: isEn ? 'Copy' : '复制' },
                { role: 'paste', label: isEn ? 'Paste' : '粘贴' },
                { role: 'delete', label: isEn ? 'Delete' : '删除' },
                { role: 'selectAll', label: isEn ? 'Select All' : '全选' },
                // Windows: Settings shortcut (macOS has it in the app menu)
                ...(!isMac
                    ? [
                        { type: 'separator' },
                        {
                            label: isEn ? 'Settings' : '设置',
                            click: () => {
                                const win = getMainWindow();
                                if (win && !win.webContents.isDestroyed()) {
                                    bringToFront();
                                    win.webContents.send(IPC_CHANNELS.MENU_OPEN_SETTINGS);
                                }
                            },
                        },
                    ]
                    : []),
            ],
        },
        // 视图菜单
        {
            label: isEn ? 'View' : '视图',
            submenu: [
                { role: 'zoomIn', label: isEn ? 'Zoom In' : '放大' },
                { role: 'zoomOut', label: isEn ? 'Zoom Out' : '缩小' },
                { role: 'resetZoom', label: isEn ? 'Actual Size' : '实际大小' },
            ],
        },
        // 窗口菜单
        {
            label: isEn ? 'Window' : '窗口',
            submenu: [
                { role: 'minimize', label: isEn ? 'Minimize' : '最小化' },
                { role: 'togglefullscreen', label: isEn ? 'Toggle Fullscreen' : '切换全屏' },
                { type: 'separator' },
                { role: 'reload', label: isEn ? 'Reload' : '重新加载' },
                { type: 'separator' },
                isMac
                    ? { label: isEn ? 'Close' : '关闭', click: closeArchonWindow }
                    : { role: 'quit', label: isEn ? 'Quit' : '退出' },
            ],
        },
        ...(developerMenu ? [developerMenu] : []),
        // 帮助菜单
        {
            label: isEn ? 'Help' : '帮助',
            submenu: buildHelpSubmenu(isEn, notifyRendererToOpenUpdateModal, notifyArchonRendererToOpenFeedback),
        },
    ];
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
    if (mainWindow)
        hideWindowsMenuBar(mainWindow);
}
