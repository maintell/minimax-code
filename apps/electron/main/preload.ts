/**
 * Electron 预加载脚本
 * 通过 contextBridge 安全地暴露 API 到渲染进程
 */
import { ipcRenderer, contextBridge, webFrame, webUtils } from "electron";
const modelMenuPopupAPI = {
    setModalScope: (scope) => ipcRenderer.invoke('model-menu-popup:modal-scope', scope),
    open: (request) => ipcRenderer.invoke('model-menu-popup:open', request),
    update: (id, presentation) => ipcRenderer.send('model-menu-popup:owner', 'update', id, presentation),
    close: (id) => ipcRenderer.send('model-menu-popup:owner', 'close', id),
    onEvent: (listener) => {
        const receive = (_event, value) => listener(value);
        ipcRenderer.on('model-menu-popup:event', receive);
        return () => ipcRenderer.removeListener('model-menu-popup:event', receive);
    },
};
contextBridge.exposeInMainWorld('modelMenuPopupAPI', modelMenuPopupAPI);
const IPC_CHANNELS = {
    // 主题
    SYSTEM_GET_THEME: 'system:get-theme',
    SYSTEM_THEME_CHANGED: 'system:theme-changed',
    SYSTEM_SET_THEME_SOURCE: 'system:set-theme-source',
    SYSTEM_OPEN_DIR: 'system:open-dir',
    SYSTEM_CREATE_DIR: 'system:create-dir',
    SYSTEM_OPEN_FILE_IN_FOLDER: 'system:open-file-in-folder',
    SYSTEM_SHOW_IMAGE_CONTEXT_MENU: 'system:show-image-context-menu',
    SYSTEM_GET_HOME_PATH: 'system:get-home-path',
    SYSTEM_GET_APP_INSTALL_DIR: 'system:get-app-install-dir',
    // 窗口控制
    WINDOW_MINIMIZE: 'window:minimize',
    WINDOW_RESTORE: 'window:restore',
    WINDOW_MAXIMIZE: 'window:maximize',
    WINDOW_CLOSE: 'window:close',
    WINDOW_IS_MAXIMIZED: 'window:is-maximized',
    WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
    WINDOW_IS_FULL_SCREEN: 'window:is-full-screen',
    WINDOW_FULL_SCREEN_CHANGED: 'window:full-screen-changed',
    DEVTOOLS_OPEN: 'devtools:open',
    DEVTOOLS_TOGGLE: 'devtools:toggle',
    DEVELOPER_OPTIONS_GET: 'developer-options:get',
    DEVELOPER_OPTIONS_CHANGED: 'developer-options:changed',
    RUNTIME_MEMORY_MONITOR_GET: 'runtime-memory-monitor:get',
    RUNTIME_MEMORY_MONITOR_SET_RECORDING: 'runtime-memory-monitor:set-recording',
    RUNTIME_MEMORY_MONITOR_CLEAR: 'runtime-memory-monitor:clear',
    RUNTIME_MEMORY_MONITOR_START_HEAP_SAMPLING: 'runtime-memory-monitor:start-heap-sampling',
    RUNTIME_MEMORY_MONITOR_STOP_HEAP_SAMPLING: 'runtime-memory-monitor:stop-heap-sampling',
    RUNTIME_MEMORY_MONITOR_REVEAL_PROFILE: 'runtime-memory-monitor:reveal-profile',
    ASR_PUSH_TO_TALK_KEY_UP: 'asr:push-to-talk-key-up',
    // 菜单事件
    MENU_NEW_CHAT: 'menu:new-chat',
    MENU_OPEN_SETTINGS: 'menu:open-settings',
    MENU_OPEN_FEEDBACK: 'menu:open-feedback',
    // 认证
    AUTH_CHECK_STATUS: 'auth:check-status',
    AUTH_LOGIN: 'auth:login',
    AUTH_CANCEL_LOGIN: 'auth:cancel-login',
    AUTH_DEVICE_AUTHORIZATION: 'auth:device-authorization',
    AUTH_LOGOUT: 'auth:logout',
    AUTH_NAVIGATE_TO_LOGIN: 'auth:navigate-to-login',
    AUTH_LOGIN_COMPLETE: 'auth:login-complete',
    AUTH_LOGGED_OUT: 'auth:logged-out',
    // 代理请求
    PROXY_FETCH: 'proxy:fetch',
    PROXY_STREAM_START: 'proxy:stream:start',
    PROXY_STREAM_ABORT: 'proxy:stream:abort',
    PROXY_STREAM_EVENT: 'proxy:stream:event',
    PROXY_FETCH_DEBUG_SUBSCRIBE: 'proxy:fetch-debug:subscribe',
    PROXY_FETCH_DEBUG_UNSUBSCRIBE: 'proxy:fetch-debug:unsubscribe',
    PROXY_FETCH_DEBUG_EVENT: 'proxy:fetch-debug:event',
    // 对话框
    DIALOG_SELECT_DIRECTORY: 'dialog:select-directory',
    DIALOG_SELECT_FILE: 'dialog:select-file',
    DIALOG_SELECT_HANDOFF_PATHS: 'dialog:select-handoff-paths',
    DIALOG_INSPECT_HANDOFF_PATHS: 'dialog:inspect-handoff-paths',
    DIALOG_SAVE_FILE: 'dialog:save-file',
    DIALOG_GET_PATH_FOR_FILE: 'dialog:get-path-for-file',
    // 存储
    STORAGE_GET_TOKENS: 'storage:get-tokens',
    STORAGE_SET_TOKENS: 'storage:set-tokens',
    STORAGE_CLEAR_TOKENS: 'storage:clear-tokens',
    STORAGE_GET_USER: 'storage:get-user',
    STORAGE_ACCOUNT_CHANGED: 'storage:account-changed',
    STORAGE_SET_USER: 'storage:set-user',
    STORAGE_CLEAR_USER: 'storage:clear-user',
    STORAGE_GET_DESKTOP_CONFIG: 'storage:get-desktop-config',
    STORAGE_SET_DESKTOP_CONFIG: 'storage:set-desktop-config',
    STORAGE_GET_DESKTOP_APPEARANCE_SYNC: 'storage:get-desktop-appearance-sync',
    STORAGE_CLEAR_ALL: 'storage:clear-all',
    STORAGE_GET_LANGUAGE_SYNC: 'storage:get-language-sync',
    STORAGE_GET_LOCAL_STORAGE_CONFIG: 'storage:get-local-storage-config',
    STORAGE_GET_DESKTOP_ONBOARDING_MODE: 'storage:get-desktop-onboarding-mode',
    STORAGE_SET_LOCAL_STORAGE_CONFIG: 'storage:set-local-storage-config',
    STORAGE_CLEAR_LOCAL_STORAGE_CONFIG: 'storage:clear-local-storage-config',
    STORAGE_SYNC_DAEMON_AUTH: 'storage:sync-daemon-auth',
    // Remote Control bridge (mirror of config/constants — sandboxed preload
    // cannot require that module; keep in sync)
    RC_CONNECT: 'rc:connect',
    RC_DISCONNECT: 'rc:disconnect',
    RC_GET_STATUS: 'rc:get-status',
    RC_STATUS_CHANGED: 'rc:status-changed',
    RC_CHECK_BINDING: 'rc:check-binding',
    RC_REQUEST_CODE: 'rc:request-code',
    RC_GET_DEVICE_ID: 'rc:get-device-id',
    RC_GET_DEVICE_NAME: 'rc:get-device-name',
    RC_BINDING_READY: 'rc:binding-ready',
    RC_REFRESH_BINDING: 'rc:refresh-binding',
    RC_BINDING_LOST: 'rc:binding-lost',
    RC_MARK_UNBOUND: 'rc:mark-unbound',
    RC_PUBLISH_SESSION_COMPOSER_MODE: 'rc:publish-session-composer-mode',
    RC_SESSION_COMPOSER_MODE_CHANGED: 'rc:session-composer-mode-changed',
    // 外部链接
    OPEN_EXTERNAL: 'open-external',
    // 系统
    SYSTEM_OPEN_LOG_FILE: 'system:open-log-file',
    SYSTEM_GET_LOG_FILE_PATH: 'system:get-log-file-path',
    SYSTEM_UPLOAD_LOG: 'system:upload-log',
    SYSTEM_UPLOAD_FEEDBACK_LOG: 'system:upload-feedback-log',
    SYSTEM_RELAUNCH: 'system:relaunch',
    // 桌面设置
    DESKTOP_RELAUNCH: 'desktop:relaunch',
    DESKTOP_SET_TRAY_VISIBLE: 'desktop:set-tray-visible',
    DESKTOP_GET_TRAY_VISIBLE: 'desktop:get-tray-visible',
    DESKTOP_SET_RUN_ON_STARTUP: 'desktop:set-run-on-startup',
    DESKTOP_GET_RUN_ON_STARTUP: 'desktop:get-run-on-startup',
    DESKTOP_SET_KEEP_AWAKE: 'desktop:set-keep-awake',
    DESKTOP_GET_KEEP_AWAKE: 'desktop:get-keep-awake',
    DESKTOP_START_COMPUTER_USE_RUNTIME: 'desktop:start-computer-use-runtime',
    DESKTOP_APPEARANCE_CHANGED: 'desktop:appearance-changed',
    // 全局快捷键
    DESKTOP_SET_GLOBAL_ACCESS_SHORTCUT: 'desktop:set-global-access-shortcut',
    DESKTOP_GET_GLOBAL_ACCESS_SHORTCUT: 'desktop:get-global-access-shortcut',
    DESKTOP_SET_SHORTCUT_OVERRIDES: 'desktop:set-shortcut-overrides',
    DESKTOP_OPEN_NOTIFICATION_SETTINGS: 'desktop:open-notification-settings',
    DESKTOP_SET_LANGUAGE: 'desktop:set-language',
    DESKTOP_GET_LOCAL_RUNTIME_DATA_DIR_INFO: 'desktop:get-local-runtime-data-dir-info',
    DESKTOP_RELOCATE_LOCAL_RUNTIME_DATA_DIR: 'desktop:relocate-local-runtime-data-dir',
    // FilePanel embedded browser
    EMBEDDED_BROWSER_CREATE: 'embedded-browser:create',
    EMBEDDED_BROWSER_SHOW: 'embedded-browser:show',
    EMBEDDED_BROWSER_SET_BOUNDS: 'embedded-browser:set-bounds',
    EMBEDDED_BROWSER_SET_DEVICE_PREVIEW_MODE: 'embedded-browser:set-device-preview-mode',
    EMBEDDED_BROWSER_SET_NATIVE_OVERLAY_OCCLUSION: 'embedded-browser:set-native-overlay-occlusion',
    EMBEDDED_BROWSER_HIDE: 'embedded-browser:hide',
    EMBEDDED_BROWSER_DESTROY: 'embedded-browser:destroy',
    EMBEDDED_BROWSER_GET_STATE: 'embedded-browser:get-state',
    EMBEDDED_BROWSER_EXECUTE_TOOL: 'embedded-browser:execute-tool',
    EMBEDDED_BROWSER_NAVIGATE: 'embedded-browser:navigate',
    EMBEDDED_BROWSER_SCREENSHOT: 'embedded-browser:screenshot',
    EMBEDDED_BROWSER_GO_BACK: 'embedded-browser:go-back',
    EMBEDDED_BROWSER_GO_FORWARD: 'embedded-browser:go-forward',
    EMBEDDED_BROWSER_RELOAD: 'embedded-browser:reload',
    EMBEDDED_BROWSER_FORCE_RELOAD: 'embedded-browser:force-reload',
    EMBEDDED_BROWSER_SET_ZOOM: 'embedded-browser:set-zoom',
    EMBEDDED_BROWSER_CLEAR_COOKIES: 'embedded-browser:clear-cookies',
    EMBEDDED_BROWSER_CLEAR_CACHE: 'embedded-browser:clear-cache',
    EMBEDDED_BROWSER_SET_COMMENT_MODE: 'embedded-browser:set-comment-mode',
    EMBEDDED_BROWSER_CLEAR_COMMENTS: 'embedded-browser:clear-comments',
    EMBEDDED_BROWSER_ACK_COMMENT_EVENTS: 'embedded-browser:ack-comment-events',
    EMBEDDED_BROWSER_OPEN_EXTERNAL: 'embedded-browser:open-external',
    EMBEDDED_BROWSER_LIST_LOCAL_SERVERS: 'embedded-browser:list-local-servers',
    EMBEDDED_BROWSER_CAPTURE_FRAME: 'embedded-browser:capture-frame',
    EMBEDDED_BROWSER_AGENT_ACTION: 'embedded-browser:agent-action',
    // Plugin-owned Mini App surfaces
    MINIAPP_LIST: 'miniapp:list',
    MINIAPP_OPEN: 'miniapp:open',
    MINIAPP_REFRESH: 'miniapp:refresh',
    MINIAPP_STOP: 'miniapp:stop',
    MINIAPP_COMPOSER_REQUEST: 'miniapp:composer-request',
    MINIAPP_COMPOSER_REPLY: 'miniapp:composer-reply',
    BROWSER_PROFILE_IMPORT_LIST: 'browser-profile-import:list',
    BROWSER_PROFILE_IMPORT_START: 'browser-profile-import:start',
    BROWSER_PROFILE_IMPORT_CANCEL: 'browser-profile-import:cancel',
    BROWSER_PROFILE_IMPORT_PROGRESS: 'browser-profile-import:progress',
    // 更新器
    UPDATER_CHECK: 'updater:check',
    UPDATER_DOWNLOAD: 'updater:download',
    UPDATER_INSTALL: 'updater:install',
    UPDATER_GET_VERSION: 'updater:get-version',
    UPDATER_STATUS: 'updater:status',
    UPDATER_SET_AUTO_UPDATE: 'updater:set-auto-update',
    UPDATER_OPEN_MODAL: 'updater:open-modal',
    // Deep Link
    DEEPLINK_RECEIVED: 'deeplink:received',
    // file api
    // file tools
    FILE_READ: 'file:read',
    FILE_STAGE_ATTACHMENT: 'file:stage-attachment',
    FILE_WRITE: 'file:write',
    FILE_SAVE_WORKBOOK: 'file:save-workbook',
    FILE_EDIT: 'file:edit',
    FILE_MULTI_EDIT: 'file:multi-edit',
    FILE_GLOB: 'file:glob',
    FILE_GREP: 'file:grep',
    FILE_LIST: 'file:list',
    FILE_STAT: 'file:stat',
    FILE_DELETE: 'file:delete',
    FILE_MOVE: 'file:move',
    FILE_COPY: 'file:copy',
    FILE_TRASH: 'file:trash',
    FILE_DOWNLOAD: 'file:download',
    FILE_UPLOAD: 'file:upload',
    FILE_CHMOD: 'file:chmod',
    // sidebar terminal (interactive PTY)
    TERMINAL_CREATE: 'terminal:create',
    TERMINAL_LIST: 'terminal:list',
    TERMINAL_ATTACH: 'terminal:attach',
    TERMINAL_INPUT: 'terminal:input',
    TERMINAL_RESIZE: 'terminal:resize',
    TERMINAL_DISPOSE: 'terminal:dispose',
    TERMINAL_OUTPUT: 'terminal:output',
    TERMINAL_EXIT: 'terminal:exit',
    TERMINAL_TITLE: 'terminal:title',
    // 日志
    LOGGER_LOG: 'logger:log',
    // Observability outbox (main → preload → renderer)
    OBSERVABILITY_GET_APP_INSTANCE_ID: 'observability:get-app-instance-id',
    OBSERVABILITY_DRAIN_OUTBOX: 'observability:drain-outbox',
    OBSERVABILITY_ACK_OUTBOX: 'observability:ack-outbox',
    OBSERVABILITY_OUTBOX_EVENT: 'observability:outbox-event',
    OBSERVABILITY_STARTUP_MILESTONE: 'observability:startup-milestone',
    // Document preview source/backend bridge (mirrors config/constants.ts)
    DOCUMENT_PREVIEW_OPEN_SOURCE: 'document-preview:open-source',
    DOCUMENT_PREVIEW_SAVE_PPTX_NOTES: 'document-preview:save-pptx-notes',
    DOCUMENT_PREVIEW_OPEN_IN_SYSTEM: 'document-preview:open-in-system',
    DOCUMENT_PREVIEW_OPEN_ASSET_IN_APP: 'document-preview:open-asset-in-app',
    DOCUMENT_PREVIEW_STAGE_SOURCE: 'document-preview:stage-source',
    DOCUMENT_PREVIEW_OPEN_LEGACY_SOURCE: 'document-preview:open-legacy-source',
    DOCUMENT_PREVIEW_STAGE_LEGACY_SOURCE: 'document-preview:stage-legacy-source',
    DOCUMENT_PREVIEW_READ_SOURCE: 'document-preview:read-source',
    DOCUMENT_PREVIEW_PREPARE: 'document-preview:prepare',
    DOCUMENT_PREVIEW_CANCEL: 'document-preview:cancel',
    DOCUMENT_PREVIEW_RELEASE: 'document-preview:release',
    DOCUMENT_PREVIEW_GET_BACKEND_STATUSES: 'document-preview:get-backend-statuses',
    DOCUMENT_PREVIEW_CAPTURE_RENDERER_REGION: 'document-preview:capture-renderer-region',
    DOCUMENT_PREVIEW_RESOLVE_PPTX_SELECTION: 'document-preview:resolve-pptx-selection',
    DOCUMENT_PREVIEW_PROGRESS: 'document-preview:progress',
    DOCUMENT_PREVIEW_PPTX_CORE_CREATE: 'document-preview:pptx-core-create',
    DOCUMENT_PREVIEW_PPTX_CORE_BIND: 'document-preview:pptx-core-bind',
    DOCUMENT_PREVIEW_PPTX_CORE_CANCEL: 'document-preview:pptx-core-cancel',
    DOCUMENT_PREVIEW_PPTX_CORE_PORT: 'document-preview:pptx-core-port',
    PREVIEW_CLIPBOARD_WRITE: 'preview-clipboard:write',
    // PPT Preview WebContentsView
    PPT_PREVIEW_CREATE: 'ppt-preview:create',
    PPT_PREVIEW_LOAD: 'ppt-preview:load',
    PPT_PREVIEW_LOAD_SOURCE: 'ppt-preview:load-source',
    PPT_PREVIEW_RENDER_SLIDES: 'ppt-preview:render-slides',
    PPT_PREVIEW_SET_BOUNDS: 'ppt-preview:set-bounds',
    PPT_PREVIEW_SET_SELECTION_MODE: 'ppt-preview:set-selection-mode',
    PPT_PREVIEW_CLEAR_SELECTION: 'ppt-preview:clear-selection',
    PPT_PREVIEW_GET_SELECTION_EVENTS: 'ppt-preview:get-selection-events',
    PPT_PREVIEW_CAPTURE_SELECTION: 'ppt-preview:capture-selection',
    PPT_PREVIEW_CAPTURE_FRAME: 'ppt-preview:capture-frame',
    PPT_PREVIEW_GET_DEBUG_STATE: 'ppt-preview:get-debug-state',
    PPT_PREVIEW_SELECTION_BRIDGE_EVENT: 'ppt-preview:selection-bridge-event',
    PPT_PREVIEW_SELECTION_EVENT: 'ppt-preview:selection-event',
    PPT_PREVIEW_DESTROY: 'ppt-preview:destroy',
    // Runtime lifecycle.
    RUNTIME_READY: 'runtime:ready',
    RUNTIME_FAILED: 'runtime:failed',
    RUNTIME_CHECK_READY: 'runtime:check-ready',
    RUNTIME_SET_RUNAWAY_GUARD_CONFIG: 'runtime:set-runaway-guard-config',
    RUNTIME_SET_TOOL_RESULT_COMPACTION_CONFIG: 'runtime:set-tool-result-compaction-config',
    RUNTIME_SET_COLLECTION_POLICY_CONFIG: 'runtime:set-collection-policy-config',
    // Always-on Electron utility-process runtime transport.
    RUNTIME_TRANSPORT_REQUEST_PORT: 'runtime:transport-request-port',
    RUNTIME_TRANSPORT_GET_CURRENT: 'runtime:transport-get-current',
    RUNTIME_TRANSPORT_REQUEST_SWITCH: 'runtime:transport-request-switch',
    RUNTIME_TRANSPORT_LOST: 'runtime:transport-lost',
    LOCAL_ASR_SESSION_OPEN: 'local-asr:session-open',
    LOCAL_ASR_SESSION_FRAME: 'local-asr:session-frame',
    LOCAL_ASR_SESSION_AUDIO: 'local-asr:session-audio',
    LOCAL_ASR_SESSION_CLOSE: 'local-asr:session-close',
    LOCAL_ASR_SESSION_EVENT: 'local-asr:session-event',
    LOCAL_ASR_SESSION_CLOSED: 'local-asr:session-closed',
    // Archon Chat Window
    ARCHON_CHAT_OPEN: 'archon-chat:open',
    // Mini Chat Window
    MINI_CHAT_CREATE: 'mini-chat:create',
    MINI_CHAT_CLOSE: 'mini-chat:close',
    MINI_CHAT_SHOW: 'mini-chat:show',
    MINI_CHAT_HIDE: 'mini-chat:hide',
    MINI_CHAT_RESIZE: 'mini-chat:resize',
    MINI_CHAT_SET_IGNORE_MOUSE_EVENTS: 'mini-chat:set-ignore-mouse-events',
    MINI_CHAT_MAXIMIZE: 'mini-chat:maximize',
    MINI_CHAT_BLUR: 'mini-chat:blur',
    MINI_CHAT_FOCUS: 'mini-chat:focus',
    // Main Window Actions (从主进程发送到主窗口渲染进程)
    MAIN_WINDOW_SELECT_CHAT: 'main-window:select-chat',
    // Screenshot
    SCREENSHOT_START: 'screenshot:start',
    SCREENSHOT_CAPTURE_PAGE_REGION: 'screenshot:capture-page-region',
    // Tracking recorder (keep in sync with main/config/constants.ts)
    TRACKING_RECORDER_REGISTER_SCREENSHOT: 'tracking-recorder:register-screenshot',
    TRACKING_RECORDER_READ_SCREENSHOT: 'tracking-recorder:read-screenshot',
    TRACKING_RECORDER_AVAILABLE_SCREENSHOTS: 'tracking-recorder:available-screenshots',
    TRACKING_RECORDER_RELEASE_SCREENSHOTS: 'tracking-recorder:release-screenshots',
    TRACKING_RECORDER_RELOAD_RENDERER: 'tracking-recorder:reload-renderer',
    TRACKING_RECORDER_EXPORT_DIRECTORY: 'tracking-recorder:export-directory',
    // Log Viewer (仅测试环境)
    LOG_VIEWER_OPEN: 'log-viewer:open',
    LOG_VIEWER_GET_FILES: 'log-viewer:get-files',
    LOG_VIEWER_GET_CONTENT: 'log-viewer:get-content',
    // 系统通知
    NOTIFICATION_SHOW: 'notification:show',
    NOTIFICATION_CLICK: 'notification:click',
    // 热更新
    HOT_UPDATE_CHECK: 'hot-update:check',
    HOT_UPDATE_DOWNLOAD: 'hot-update:download',
    HOT_UPDATE_CLEAR_CACHE: 'hot-update:clear-cache',
    HOT_UPDATE_RELOAD: 'hot-update:reload',
    HOT_UPDATE_GET_VERSION: 'hot-update:get-version',
    HOT_UPDATE_GET_VERSION_SYNC: 'hot-update:get-version-sync',
    // 应用生命周期
    APP_BEFORE_QUIT: 'app:before-quit',
    APP_QUIT_CONFIRMATION_REQUEST: 'app:quit-confirmation-request',
    APP_QUIT_CONFIRMATION_RESULT: 'app:quit-confirmation-result',
    APP_QUIT_CONFIRMATION_ABORT: 'app:quit-confirmation-abort',
    APP_CONFIRM_QUIT: 'app:confirm-quit',
    APP_BRING_TO_FRONT: 'app:bring-to-front',
    // Dock file drop (macOS)
    DOCK_FILE_OPENED: 'dock:file-opened',
};
const pendingNotificationClicks = [];
const notificationClickListeners = new Set();
ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_CLICK, (_event, data) => {
    if (notificationClickListeners.size === 0) {
        pendingNotificationClicks.push(data);
        if (pendingNotificationClicks.length > 20)
            pendingNotificationClicks.shift();
        return;
    }
    for (const listener of notificationClickListeners)
        listener(data);
});
// 直接从 process.env 读取环境变量
const isDev = process.env.NODE_ENV === 'development';
const trackingRecorderEnabled = process.env.__MAVIS_BUILD_INSIDE !== 'true' &&
    (process.env.NEXT_PUBLIC_BUILD_ENV !== 'prod' || process.env.__MAVIS_BUILD_INTERNAL === 'true');
// Sandboxed preloads cannot load relative CommonJS modules. Keep this gate
// self-contained so the preload reaches every contextBridge exposure.
const proxyFetchDebugBuildEnv = process.env.NEXT_PUBLIC_BUILD_ENV;
const proxyFetchDebugEnabled = process.env.__MAVIS_BUILD_INSIDE !== 'true' &&
    (proxyFetchDebugBuildEnv === 'dev' ||
        proxyFetchDebugBuildEnv === 'development' ||
        proxyFetchDebugBuildEnv === 'test' ||
        proxyFetchDebugBuildEnv === 'staging' ||
        process.env.__MAVIS_BUILD_INTERNAL === 'true');
const DEFAULT_LOCALE = (process.env.NEXT_PUBLIC_LOCALE || 'en');
function getProcessArgument(prefix) {
    for (let index = process.argv.length - 1; index >= 0; index -= 1) {
        const argument = process.argv[index];
        if (argument.startsWith(prefix))
            return argument.slice(prefix.length);
    }
    return undefined;
}
// Sandboxed preload scripts may only require Electron's allowlisted modules.
// Keep these argument names local and import only shared types; Main owns and
// validates the values before passing them to the renderer process.
const DESKTOP_WINDOW_KIND_ARGUMENT_PREFIX = '--mavis-desktop-window-kind=';
const DESKTOP_APPEARANCE_CAPABILITY_ARGUMENT_PREFIX = '--mavis-desktop-appearance=';
const desktopWindowKind = (getProcessArgument(DESKTOP_WINDOW_KIND_ARGUMENT_PREFIX) ??
    'unknown');
const desktopWindowCapabilities = {
    appearance: getProcessArgument(DESKTOP_APPEARANCE_CAPABILITY_ARGUMENT_PREFIX) === '1',
};
const desktopAppearanceListeners = new Set();
// This fallback is used only if the synchronous Main snapshot is unavailable.
// Renderer normalization remains the source of truth for supported values.
let desktopAppearanceSnapshot = {
    themeMode: 'system',
    themePackId: 'mcode-default',
    visualThemeSource: 'pack',
    preferences: {
        uiFontFamily: 'theme',
        codeFontFamily: 'theme',
        uiFontWeight: 'theme',
        codeFontWeight: 'theme',
        density: 'comfortable',
        chatContentWidth: 'standard',
        contrast: 50,
        colors: {
            light: { accent: null, background: null, foreground: null },
            dark: { accent: null, background: null, foreground: null },
        },
    },
    wallpaperProfile: null,
    typography: { uiBaseFontSize: 14, codeFontSize: 12 },
};
function readDesktopAppearanceSnapshot(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    const typography = candidate.typography;
    if ((candidate.syncRevision !== undefined &&
        (!Number.isSafeInteger(candidate.syncRevision) || candidate.syncRevision < 0)) ||
        !typography ||
        typeof typography.uiBaseFontSize !== 'number' ||
        !Number.isFinite(typography.uiBaseFontSize) ||
        typeof typography.codeFontSize !== 'number' ||
        !Number.isFinite(typography.codeFontSize)) {
        return null;
    }
    return candidate;
}
function retainDesktopAppearanceSnapshot(snapshot) {
    const currentRevision = desktopAppearanceSnapshot.syncRevision;
    if (currentRevision !== undefined &&
        (snapshot.syncRevision === undefined || snapshot.syncRevision < currentRevision))
        return false;
    desktopAppearanceSnapshot = snapshot;
    return true;
}
// Every desktop window follows the theme mode, so the snapshot and the
// change feed are unconditional; the capability only gates theme packs,
// typography, and the settings surface.
{
    let receivedAppearanceBroadcast = false;
    ipcRenderer.on(IPC_CHANNELS.DESKTOP_APPEARANCE_CHANGED, (_, value) => {
        const snapshot = readDesktopAppearanceSnapshot(value);
        if (!snapshot || !retainDesktopAppearanceSnapshot(snapshot))
            return;
        receivedAppearanceBroadcast = true;
        for (const listener of desktopAppearanceListeners) {
            try {
                listener(structuredClone(desktopAppearanceSnapshot));
            }
            catch (error) {
                console.error('[preload] desktop appearance listener failed:', error);
            }
        }
    });
    try {
        const storedAppearance = ipcRenderer.sendSync(IPC_CHANNELS.STORAGE_GET_DESKTOP_APPEARANCE_SYNC);
        const snapshot = readDesktopAppearanceSnapshot(storedAppearance);
        if (!receivedAppearanceBroadcast && snapshot) {
            desktopAppearanceSnapshot = snapshot;
        }
    }
    catch {
        // Keep the renderer-safe fallback when Main is not ready.
    }
}
// 同步获取用户设置的语言（从主进程存储中读取）
// 使用 sendSync 确保在 preload 执行时就能获取到语言设置
let userLocale = DEFAULT_LOCALE;
try {
    const storedLanguage = ipcRenderer.sendSync(IPC_CHANNELS.STORAGE_GET_LANGUAGE_SYNC);
    if (storedLanguage === 'en' || storedLanguage === 'zh') {
        userLocale = storedLanguage;
    }
}
catch (e) {
    //
}
// ============================================
// 同步获取平台信息（在 preload 执行时立即可用）
// 这些信息在渲染进程启动时就能获取，无需异步等待
// ============================================
// 同步获取热更新版本（用于 platformInfo 初始化）
let hotUpdateVersion = null;
try {
    hotUpdateVersion = ipcRenderer.sendSync(IPC_CHANNELS.HOT_UPDATE_GET_VERSION_SYNC);
}
catch {
    // 主进程可能还没准备好，忽略错误
}
const platformInfo = {
    platform: process.platform,
    arch: process.arch,
    isElectron: true,
    buildEnv: process.env.NEXT_PUBLIC_BUILD_ENV,
    isDev: isDev,
    locale: userLocale,
    windowKind: desktopWindowKind,
    capabilities: desktopWindowCapabilities,
    hotUpdateVersion,
};
let appInstanceId = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
try {
    const preloadedAppInstanceId = ipcRenderer.sendSync(IPC_CHANNELS.OBSERVABILITY_GET_APP_INSTANCE_ID);
    if (typeof preloadedAppInstanceId === 'string' && preloadedAppInstanceId) {
        appInstanceId = preloadedAppInstanceId;
    }
}
catch {
    // Main outbox is best-effort; renderer will fall back to its own generated id.
}
const electronObservability = {
    appInstanceId,
    drainOutbox: () => ipcRenderer.invoke(IPC_CHANNELS.OBSERVABILITY_DRAIN_OUTBOX),
    ackOutboxEvents: (ids) => ipcRenderer.invoke(IPC_CHANNELS.OBSERVABILITY_ACK_OUTBOX, ids),
    onOutboxEvent: (callback) => {
        const handler = (_, event) => {
            callback(event);
        };
        ipcRenderer.on(IPC_CHANNELS.OBSERVABILITY_OUTBOX_EVENT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.OBSERVABILITY_OUTBOX_EVENT, handler);
    },
    markStartupMilestone: (milestone, surface) => {
        ipcRenderer.send(IPC_CHANNELS.OBSERVABILITY_STARTUP_MILESTONE, {
            milestone,
            surface,
            timestampEpochMs: performance.timeOrigin + performance.now(),
        });
    },
};
// ============================================
// Terminal API (interactive PTY) — defined above the `electronAPI` object so
// it can be embedded under `electronAPI.terminal`. See
// docs/design/sidebar-terminal-panel.md §6.3 for the contract.
// ============================================
const terminalAPI = {
    create: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, params),
    list: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LIST, params),
    attach: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_ATTACH, params),
    input: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_INPUT, params),
    resize: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, params),
    dispose: (params) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_DISPOSE, params),
    onOutput: (cb) => {
        const handler = (_, e) => cb(e);
        ipcRenderer.on(IPC_CHANNELS.TERMINAL_OUTPUT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_OUTPUT, handler);
    },
    onExit: (cb) => {
        const handler = (_, e) => cb(e);
        ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, handler);
    },
    onTitle: (cb) => {
        const handler = (_, e) => cb(e);
        ipcRenderer.on(IPC_CHANNELS.TERMINAL_TITLE, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_TITLE, handler);
    },
};
const trackingRecorderAPI = {
    registerScreenshot: (dataUrl) => ipcRenderer.invoke(IPC_CHANNELS.TRACKING_RECORDER_REGISTER_SCREENSHOT, dataUrl),
    readScreenshot: (screenshotId) => ipcRenderer.invoke(IPC_CHANNELS.TRACKING_RECORDER_READ_SCREENSHOT, screenshotId),
    availableScreenshotIds: (screenshotIds) => ipcRenderer.invoke(IPC_CHANNELS.TRACKING_RECORDER_AVAILABLE_SCREENSHOTS, screenshotIds),
    releaseScreenshots: (screenshotIds) => ipcRenderer.invoke(IPC_CHANNELS.TRACKING_RECORDER_RELEASE_SCREENSHOTS, screenshotIds),
    reloadRendererIgnoringCache: () => ipcRenderer.invoke(IPC_CHANNELS.TRACKING_RECORDER_RELOAD_RENDERER),
    exportDirectoryAndOpen: (request) => ipcRenderer.invoke(IPC_CHANNELS.TRACKING_RECORDER_EXPORT_DIRECTORY, request),
};
function createLocalAsrSessionId() {
    return `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
// 暴露安全的 API 到渲染进程
const electronAPI = {
    // 系统相关
    getSystemTheme: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_THEME),
    setNativeThemeSource: (themeSource) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_SET_THEME_SOURCE, themeSource),
    onSystemThemeChanged: (callback) => {
        const handler = (_, theme) => callback(theme);
        ipcRenderer.on(IPC_CHANNELS.SYSTEM_THEME_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.SYSTEM_THEME_CHANGED, handler);
    },
    openDir: (dirPath) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_DIR, dirPath),
    createDir: (dirPath) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_CREATE_DIR, dirPath),
    openFileInFolder: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_FILE_IN_FOLDER, filePath),
    showImageContextMenu: (params) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_SHOW_IMAGE_CONTEXT_MENU, params),
    getHomePath: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_HOME_PATH),
    getAppInstallDir: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_APP_INSTALL_DIR),
    // 窗口控制
    ...(process.platform === 'win32' && desktopWindowKind === 'main'
        ? {
            windowsTitlebar: {
                setAppearance: (value) => ipcRenderer.invoke('titlebar:appearance', value),
            },
        }
        : {}),
    windowMinimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
    windowRestore: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_RESTORE),
    windowMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
    windowClose: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
    onMaximizedChanged: (callback) => {
        const handler = (_, isMaximized) => callback(isMaximized);
        ipcRenderer.on(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_MAXIMIZED_CHANGED, handler);
    },
    isFullScreen: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_FULL_SCREEN),
    openNativeDevTools: () => ipcRenderer.invoke(IPC_CHANNELS.DEVTOOLS_OPEN),
    toggleNativeDevTools: () => ipcRenderer.invoke(IPC_CHANNELS.DEVTOOLS_TOGGLE),
    getDeveloperOptions: () => ipcRenderer.invoke(IPC_CHANNELS.DEVELOPER_OPTIONS_GET),
    onDeveloperOptionsChanged: (callback) => {
        const handler = (_, state) => callback(state);
        ipcRenderer.on(IPC_CHANNELS.DEVELOPER_OPTIONS_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.DEVELOPER_OPTIONS_CHANGED, handler);
    },
    getAppearanceSnapshot: () => structuredClone(desktopAppearanceSnapshot),
    onDesktopAppearanceChanged: (callback) => {
        callback(structuredClone(desktopAppearanceSnapshot));
        desktopAppearanceListeners.add(callback);
        return () => desktopAppearanceListeners.delete(callback);
    },
    getRuntimeMemoryMonitorState: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_GET),
    setRuntimeMemoryRecording: (enabled, intervalMs) => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_SET_RECORDING, enabled, intervalMs),
    clearRuntimeMemorySamples: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_CLEAR),
    startRuntimeHeapSampling: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_START_HEAP_SAMPLING),
    stopRuntimeHeapSampling: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_STOP_HEAP_SAMPLING),
    revealRuntimeHeapProfile: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_MEMORY_MONITOR_REVEAL_PROFILE),
    onFullScreenChanged: (callback) => {
        const handler = (_, isFullScreen) => callback(isFullScreen);
        ipcRenderer.on(IPC_CHANNELS.WINDOW_FULL_SCREEN_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.WINDOW_FULL_SCREEN_CHANGED, handler);
    },
    onAsrPushToTalkKeyUp: (callback) => {
        const handler = (_, input) => callback(input);
        ipcRenderer.on(IPC_CHANNELS.ASR_PUSH_TO_TALK_KEY_UP, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.ASR_PUSH_TO_TALK_KEY_UP, handler);
    },
    getHostZoomFactor: () => webFrame.getZoomFactor(),
    // 菜单事件
    onMenuNewChat: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.MENU_NEW_CHAT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_NEW_CHAT, handler);
    },
    onMenuOpenSettings: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.MENU_OPEN_SETTINGS, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_OPEN_SETTINGS, handler);
    },
    onMenuOpenFeedback: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.MENU_OPEN_FEEDBACK, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MENU_OPEN_FEEDBACK, handler);
    },
    // 检查登录状态
    checkAuthStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CHECK_STATUS),
    startAuthLogin: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN),
    cancelAuthLogin: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CANCEL_LOGIN),
    onAuthDeviceAuthorization: (callback) => {
        const handler = (_, prompt) => callback(prompt);
        ipcRenderer.on(IPC_CHANNELS.AUTH_DEVICE_AUTHORIZATION, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTH_DEVICE_AUTHORIZATION, handler);
    },
    // 代理请求 - 通过主进程发起请求，绕过 CORS
    proxyFetch: (options) => ipcRenderer.invoke(IPC_CHANNELS.PROXY_FETCH, options),
    proxyStreamStart: (options) => ipcRenderer.send(IPC_CHANNELS.PROXY_STREAM_START, options),
    proxyStreamAbort: (requestId) => ipcRenderer.send(IPC_CHANNELS.PROXY_STREAM_ABORT, requestId),
    onProxyStreamEvent: (callback) => {
        const handler = (_, event) => callback(event);
        ipcRenderer.on(IPC_CHANNELS.PROXY_STREAM_EVENT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.PROXY_STREAM_EVENT, handler);
    },
    ...(proxyFetchDebugEnabled
        ? {
            onProxyFetchDebugEvent: (callback) => {
                let active = true;
                const handler = (_, event) => {
                    if (!active)
                        return;
                    try {
                        callback(event);
                    }
                    catch {
                        // A debug consumer must never enter the proxy request path.
                    }
                };
                try {
                    ipcRenderer.on(IPC_CHANNELS.PROXY_FETCH_DEBUG_EVENT, handler);
                    ipcRenderer.send(IPC_CHANNELS.PROXY_FETCH_DEBUG_SUBSCRIBE);
                }
                catch {
                    active = false;
                    try {
                        ipcRenderer.removeListener(IPC_CHANNELS.PROXY_FETCH_DEBUG_EVENT, handler);
                    }
                    catch {
                        // Debug cleanup is best-effort.
                    }
                    return () => undefined;
                }
                return () => {
                    if (!active)
                        return;
                    active = false;
                    try {
                        ipcRenderer.removeListener(IPC_CHANNELS.PROXY_FETCH_DEBUG_EVENT, handler);
                    }
                    catch {
                        // Debug cleanup is best-effort.
                    }
                    try {
                        ipcRenderer.send(IPC_CHANNELS.PROXY_FETCH_DEBUG_UNSUBSCRIBE);
                    }
                    catch {
                        // Debug cleanup is best-effort.
                    }
                };
            },
        }
        : {}),
    // 对话框
    selectDirectory: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, options),
    selectFile: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILE, options),
    selectSessionHandoffPaths: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_HANDOFF_PATHS, options),
    inspectSessionHandoffPaths: (input) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_INSPECT_HANDOFF_PATHS, input),
    saveFile: (options) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE_FILE, options),
    // 获取 File 对象的本地路径（用于拖拽上传）
    // 注意：webUtils.getPathForFile 必须在 preload 中调用，不能通过 IPC
    getPathForFile: (file) => {
        try {
            const path = webUtils.getPathForFile(file);
            return { success: true, path: path };
        }
        catch (error) {
            console.error('[preload] getPathForFile error:', error);
            return {
                success: false,
                path: null,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    },
    // 存储 - Token（加密存储）
    getTokens: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_TOKENS),
    setTokens: (tokens) => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_TOKENS, tokens),
    clearTokens: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CLEAR_TOKENS),
    getLocalStorageConfig: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_LOCAL_STORAGE_CONFIG),
    getDesktopOnboardingMode: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_DESKTOP_ONBOARDING_MODE),
    setLocalStorageConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_LOCAL_STORAGE_CONFIG, config),
    clearLocalStorageConfig: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CLEAR_LOCAL_STORAGE_CONFIG),
    syncDaemonAuth: (data) => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SYNC_DAEMON_AUTH, data),
    // 存储 - 用户信息
    getUser: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_USER),
    onAccountChanged: (callback) => {
        const listener = (_event, account) => callback(account);
        ipcRenderer.on(IPC_CHANNELS.STORAGE_ACCOUNT_CHANGED, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.STORAGE_ACCOUNT_CHANGED, listener);
    },
    setUser: (user) => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_USER, user),
    clearUser: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CLEAR_USER),
    // 存储 - 应用配置
    getDesktopConfig: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_GET_DESKTOP_CONFIG),
    setDesktopConfig: async (config) => {
        const result = await ipcRenderer.invoke(IPC_CHANNELS.STORAGE_SET_DESKTOP_CONFIG, config);
        const snapshot = readDesktopAppearanceSnapshot(result?.appearanceSnapshot);
        if (snapshot)
            retainDesktopAppearanceSnapshot(snapshot);
        return result;
    },
    // 存储 - 清除所有数据（登出）
    clearAllStorage: () => ipcRenderer.invoke(IPC_CHANNELS.STORAGE_CLEAR_ALL),
    // 打开外部链接
    openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),
    // 认证
    logout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT),
    // 切换到登录窗口（销毁当前窗口，创建登录窗口）
    // source: 触发来源，用于日志追踪异常退出
    navigateToLogin: (source) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_NAVIGATE_TO_LOGIN, source),
    // 登录成功后切换到主窗口（销毁登录窗口，创建主窗口）
    loginComplete: (user) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGIN_COMPLETE, user),
    // 监听登出事件（主窗口使用，设置窗口触发登出后通知主窗口）
    onLoggedOut: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.AUTH_LOGGED_OUT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.AUTH_LOGGED_OUT, handler);
    },
    // 日志相关
    openLogFile: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_LOG_FILE),
    getLogFilePath: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_LOG_FILE_PATH),
    uploadLog: () => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_UPLOAD_LOG),
    uploadFeedbackLog: (data) => ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_UPLOAD_FEEDBACK_LOG, data),
    // 重启应用（支持指定启动后跳转的页面）
    relaunch: (options) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_RELAUNCH, options),
    // ============================================
    // 桌面设置 API
    // ============================================
    // 托盘设置
    setTrayVisible: (visible) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_SET_TRAY_VISIBLE, visible),
    getTrayVisible: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_GET_TRAY_VISIBLE),
    // 开机自启动
    setRunOnStartup: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_SET_RUN_ON_STARTUP, enabled),
    getRunOnStartup: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_GET_RUN_ON_STARTUP),
    // 保持唤醒
    setKeepAwake: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_SET_KEEP_AWAKE, enabled),
    getKeepAwake: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_GET_KEEP_AWAKE),
    startComputerUseRuntime: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_START_COMPUTER_USE_RUNTIME),
    // 快捷键
    setGlobalAccessShortcut: (globalAccessShortcut) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_SET_GLOBAL_ACCESS_SHORTCUT, globalAccessShortcut),
    getGlobalAccessShortcut: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_GET_GLOBAL_ACCESS_SHORTCUT),
    setShortcutOverrides: (overrides) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_SET_SHORTCUT_OVERRIDES, overrides),
    // 通知设置
    openNotificationSettings: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_OPEN_NOTIFICATION_SETTINGS),
    // 语言设置（需要重启）
    setLanguage: (language) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_SET_LANGUAGE, language),
    getLocalRuntimeDataDirInfo: () => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_GET_LOCAL_RUNTIME_DATA_DIR_INFO),
    relocateLocalRuntimeDataDir: (parentDir) => ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_RELOCATE_LOCAL_RUNTIME_DATA_DIR, parentDir),
    // Runtime lifecycle
    checkRuntimeReady: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_CHECK_READY),
    setRunawayGuardConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_SET_RUNAWAY_GUARD_CONFIG, config),
    setToolResultCompactionConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_SET_TOOL_RESULT_COMPACTION_CONFIG, config),
    // `config` is the raw Apollo value (object, JSON string, or `undefined` when
    // the key is absent). Main owns validation and the last-valid fallback.
    setCollectionPolicyConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_SET_COLLECTION_POLICY_CONFIG, config),
    createLocalAsrSession: async (handlers) => {
        const sessionId = createLocalAsrSessionId();
        let closed = false;
        const cleanup = () => {
            ipcRenderer.removeListener(IPC_CHANNELS.LOCAL_ASR_SESSION_EVENT, eventHandler);
            ipcRenderer.removeListener(IPC_CHANNELS.LOCAL_ASR_SESSION_CLOSED, closeHandler);
        };
        const eventHandler = (_event, payload) => {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload))
                return;
            const { sessionId: incomingSessionId, frame } = payload;
            if (incomingSessionId !== sessionId || !frame || typeof frame !== 'object')
                return;
            handlers.onFrame(frame);
        };
        const closeHandler = (_event, payload) => {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload))
                return;
            const { sessionId: incomingSessionId, reason } = payload;
            if (incomingSessionId !== sessionId)
                return;
            if (!closed) {
                closed = true;
                cleanup();
                handlers.onClose?.(typeof reason === 'string' ? reason : undefined);
            }
        };
        ipcRenderer.on(IPC_CHANNELS.LOCAL_ASR_SESSION_EVENT, eventHandler);
        ipcRenderer.on(IPC_CHANNELS.LOCAL_ASR_SESSION_CLOSED, closeHandler);
        const opened = (await ipcRenderer.invoke(IPC_CHANNELS.LOCAL_ASR_SESSION_OPEN, {
            sessionId,
        }));
        if (!opened?.success) {
            cleanup();
            throw new Error(opened?.error || 'Failed to create local ASR session');
        }
        return {
            sendFrame: (frame) => {
                if (closed)
                    return;
                ipcRenderer.send(IPC_CHANNELS.LOCAL_ASR_SESSION_FRAME, { sessionId, frame });
            },
            sendAudio: (data) => {
                if (closed)
                    return;
                ipcRenderer.send(IPC_CHANNELS.LOCAL_ASR_SESSION_AUDIO, { sessionId, data });
            },
            close: () => {
                if (closed)
                    return;
                closed = true;
                cleanup();
                ipcRenderer.send(IPC_CHANNELS.LOCAL_ASR_SESSION_CLOSE, { sessionId });
            },
        };
    },
    onRuntimeReady: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.RUNTIME_READY, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RUNTIME_READY, handler);
    },
    onRuntimeFailed: (callback) => {
        const handler = (_, reason) => callback(reason);
        ipcRenderer.on(IPC_CHANNELS.RUNTIME_FAILED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RUNTIME_FAILED, handler);
    },
    // Archon Chat Window
    openArchonChat: () => ipcRenderer.invoke(IPC_CHANNELS.ARCHON_CHAT_OPEN),
    // Mini Chat Window
    miniChatCreate: (chatId) => ipcRenderer.invoke(IPC_CHANNELS.MINI_CHAT_CREATE, chatId),
    miniChatClose: () => ipcRenderer.invoke(IPC_CHANNELS.MINI_CHAT_CLOSE),
    miniChatShow: () => ipcRenderer.invoke(IPC_CHANNELS.MINI_CHAT_SHOW),
    miniChatHide: () => ipcRenderer.invoke(IPC_CHANNELS.MINI_CHAT_HIDE),
    miniChatResize: (height) => ipcRenderer.invoke(IPC_CHANNELS.MINI_CHAT_RESIZE, height),
    miniChatSetIgnoreMouseEvents: (ignore) => ipcRenderer.invoke(IPC_CHANNELS.MINI_CHAT_SET_IGNORE_MOUSE_EVENTS, ignore),
    miniChatMaximize: (params) => ipcRenderer.invoke(IPC_CHANNELS.MINI_CHAT_MAXIMIZE, params),
    // Main Window Actions (主窗口监听来自主进程的消息)
    onSelectChat: (callback) => {
        const handler = (_, params) => callback(params);
        ipcRenderer.on(IPC_CHANNELS.MAIN_WINDOW_SELECT_CHAT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MAIN_WINDOW_SELECT_CHAT, handler);
    },
    // Mini Chat Window Events
    onMiniChatBlur: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.MINI_CHAT_BLUR, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MINI_CHAT_BLUR, handler);
    },
    onMiniChatFocus: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.MINI_CHAT_FOCUS, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.MINI_CHAT_FOCUS, handler);
    },
    // Screenshot
    screenshotStart: (workspaceDir) => ipcRenderer.invoke(IPC_CHANNELS.SCREENSHOT_START, { workspaceDir }),
    capturePageRegion: (rect) => ipcRenderer.invoke(IPC_CHANNELS.SCREENSHOT_CAPTURE_PAGE_REGION, rect),
    ...(trackingRecorderEnabled ? { trackingRecorder: trackingRecorderAPI } : {}),
    // 系统通知（主进程 Notification API）
    showNotification: (options) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_SHOW, options),
    // 监听通知点击事件；挂载前到达的事件由 preload 暂存，避免启动竞态丢失。
    onNotificationClick: (callback) => {
        notificationClickListeners.add(callback);
        for (const pending of pendingNotificationClicks.splice(0))
            callback(pending);
        return () => notificationClickListeners.delete(callback);
    },
    // ============================================
    // 应用生命周期 API
    // ============================================
    /**
     * 监听应用退出前事件
     * 当用户关闭应用时，主进程会先发送此事件，渲染进程可以执行清理操作
     * 渲染进程处理完毕后需要调用 confirmQuit() 确认退出
     */
    onBeforeQuit: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.APP_BEFORE_QUIT, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_BEFORE_QUIT, handler);
    },
    onQuitConfirmationRequest: (callback) => {
        const pending = new Map();
        const handler = (_event, requestId) => {
            if (typeof requestId !== 'string' || pending.has(requestId))
                return;
            const controller = new AbortController();
            pending.set(requestId, controller);
            const reply = (confirmed) => {
                pending.delete(requestId);
                if (!controller.signal.aborted) {
                    ipcRenderer.send(IPC_CHANNELS.APP_QUIT_CONFIRMATION_RESULT, { requestId, confirmed });
                }
            };
            try {
                // Proxy functions through contextBridge; AbortSignal itself is not transferable.
                const result = callback((listener) => {
                    controller.signal.addEventListener('abort', listener, { once: true });
                    return () => controller.signal.removeEventListener('abort', listener);
                });
                if (typeof result === 'boolean') {
                    reply(result);
                }
                else {
                    ipcRenderer.send(IPC_CHANNELS.APP_QUIT_CONFIRMATION_RESULT, { requestId, pending: true });
                    void result.then(reply, () => reply(false));
                }
            }
            catch {
                reply(false);
            }
        };
        const abort = (_event, requestId) => {
            pending.get(requestId)?.abort();
            pending.delete(requestId);
        };
        ipcRenderer.on(IPC_CHANNELS.APP_QUIT_CONFIRMATION_REQUEST, handler);
        ipcRenderer.on(IPC_CHANNELS.APP_QUIT_CONFIRMATION_ABORT, abort);
        return () => {
            for (const [requestId, controller] of pending) {
                ipcRenderer.send(IPC_CHANNELS.APP_QUIT_CONFIRMATION_RESULT, {
                    requestId,
                    confirmed: false,
                });
                controller.abort();
            }
            pending.clear();
            ipcRenderer.removeListener(IPC_CHANNELS.APP_QUIT_CONFIRMATION_REQUEST, handler);
            ipcRenderer.removeListener(IPC_CHANNELS.APP_QUIT_CONFIRMATION_ABORT, abort);
        };
    },
    /**
     * 确认退出应用
     * 渲染进程处理完退出前的清理工作后调用此方法确认退出
     */
    confirmQuit: () => ipcRenderer.send(IPC_CHANNELS.APP_CONFIRM_QUIT),
    /**
     * 请求恢复窗口到前台
     * 当有正在运行的任务需要显示确认弹窗时调用
     */
    bringToFront: () => ipcRenderer.send(IPC_CHANNELS.APP_BRING_TO_FRONT),
    /**
     * 监听 macOS Dock 文件拖放事件
     * 当用户将文件拖到 Dock 应用图标上时触发
     * @param callback 接收文件绝对路径
     */
    onDockFileOpened: (callback) => {
        const handler = (_, data) => {
            const filePaths = Array.isArray(data.filePaths)
                ? data.filePaths
                : data.filePath
                    ? [data.filePath]
                    : [];
            callback({ filePaths });
        };
        ipcRenderer.on(IPC_CHANNELS.DOCK_FILE_OPENED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.DOCK_FILE_OPENED, handler);
    },
    // Sidebar terminal panel (interactive PTY)
    terminal: terminalAPI,
};
// 通过 contextBridge 安全地暴露 API
contextBridge.exposeInMainWorld('electronAPI', electronAPI);
contextBridge.exposeInMainWorld('electronObservability', electronObservability);
// ============================================
// Always-on utility-process runtime transport bridge.
// The MessagePort itself cannot cross contextBridge, so the preload holds
// the port and exposes a minimal frame pipe: post / subscribe /
// subscribeDown. The port arrives via webContents.postMessage on
// RUNTIME_TRANSPORT_PORT_CHANNEL after the renderer calls requestPort().
// Only runtime-transport frames ride this pipe — no Node/Electron API leaks.
// ============================================
const RUNTIME_TRANSPORT_PORT_CHANNEL = 'runtime:transport-port';
// Sandboxed Electron preloads cannot require relative CommonJS modules, so
// this transport handshake must remain in the compiled single-file preload.
async function requestRuntimeTransport(options) {
    const result = await options.invoke();
    if (result?.mode === 'protocol') {
        return { mode: 'protocol', enabled: false, connected: false };
    }
    if (result?.connected !== true) {
        return {
            mode: 'direct',
            enabled: true,
            connected: false,
            ...(result?.terminal === true ? { terminal: true } : {}),
        };
    }
    if (options.hasPort()) {
        return { mode: 'direct', enabled: true, connected: true };
    }
    const connected = await options.waitForPort();
    return connected
        ? { mode: 'direct', enabled: true, connected: true }
        : { mode: 'direct', enabled: true, connected: false };
}
let runtimeTransportPort = null;
const runtimeTransportFrameListeners = new Set();
const runtimeTransportLostListeners = new Set();
let notifyRuntimeTransportPortReady = null;
function dropRuntimeTransportPort(message) {
    if (runtimeTransportPort) {
        try {
            runtimeTransportPort.close();
        }
        catch {
            // Already closed with its renderer context.
        }
        runtimeTransportPort = null;
    }
    for (const listener of [...runtimeTransportLostListeners]) {
        try {
            listener({ message });
        }
        catch {
            // Listener errors must not break the bridge.
        }
    }
}
ipcRenderer.on(RUNTIME_TRANSPORT_PORT_CHANNEL, (event) => {
    const port = event.ports[0];
    if (!port)
        return;
    if (runtimeTransportPort) {
        try {
            runtimeTransportPort.close();
        }
        catch {
            // Replacing a stale port; nothing else to release.
        }
    }
    runtimeTransportPort = port;
    port.onmessage = (messageEvent) => {
        for (const listener of [...runtimeTransportFrameListeners]) {
            try {
                listener(messageEvent.data);
            }
            catch {
                // Listener errors must not break the pipe for other listeners.
            }
        }
    };
    notifyRuntimeTransportPortReady?.();
    notifyRuntimeTransportPortReady = null;
});
ipcRenderer.on(IPC_CHANNELS.RUNTIME_TRANSPORT_LOST, () => {
    dropRuntimeTransportPort('runtime transport lost');
});
const runtimeTransportAPI = {
    /**
     * Asks Main for the effective transport mode. Direct mode waits for the
     * transferred renderer port; protocol mode returns without allocating one.
     * The `enabled` field remains for older renderer bundles.
     */
    requestPort: () => requestRuntimeTransport({
        invoke: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_TRANSPORT_REQUEST_PORT),
        hasPort: () => runtimeTransportPort !== null,
        waitForPort: () => new Promise((resolve) => {
            let portReadyTimeout = null;
            const onPortReady = () => {
                if (portReadyTimeout)
                    clearTimeout(portReadyTimeout);
                resolve(true);
            };
            notifyRuntimeTransportPortReady = onPortReady;
            portReadyTimeout = setTimeout(() => {
                if (notifyRuntimeTransportPortReady === onPortReady) {
                    notifyRuntimeTransportPortReady = null;
                }
                resolve(runtimeTransportPort !== null);
            }, 10000);
        }),
    }),
    getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_TRANSPORT_GET_CURRENT),
    requestSwitch: (targetMode) => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_TRANSPORT_REQUEST_SWITCH, targetMode),
    post: (frame) => {
        if (!runtimeTransportPort) {
            throw new Error('runtime transport port unavailable');
        }
        runtimeTransportPort.postMessage(frame);
    },
    subscribe: (listener) => {
        runtimeTransportFrameListeners.add(listener);
        return () => runtimeTransportFrameListeners.delete(listener);
    },
    subscribeLost: (listener) => {
        runtimeTransportLostListeners.add(listener);
        return () => runtimeTransportLostListeners.delete(listener);
    },
};
contextBridge.exposeInMainWorld('runtimeTransportAPI', runtimeTransportAPI);
// ============================================
// 同步暴露平台信息（无需 IPC，立即可用）
// 渲染进程可以通过 window.electronPlatform 同步访问
// ============================================
contextBridge.exposeInMainWorld('electronPlatform', platformInfo);
const embeddedBrowserAPI = {
    create: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_CREATE, params),
    show: (bounds, params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_SHOW, bounds, params),
    setBounds: (bounds, params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_SET_BOUNDS, bounds, params),
    setDevicePreviewMode: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_SET_DEVICE_PREVIEW_MODE, params),
    setNativeOverlayOcclusion: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_SET_NATIVE_OVERLAY_OCCLUSION, params),
    hide: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_HIDE, params),
    destroy: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_DESTROY, params),
    getState: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_GET_STATE, params),
    executeTool: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_EXECUTE_TOOL, params),
    navigate: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_NAVIGATE, params),
    goBack: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_GO_BACK, params),
    goForward: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_GO_FORWARD, params),
    reload: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_RELOAD, params),
    forceReload: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_FORCE_RELOAD, params),
    setZoom: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_SET_ZOOM, params),
    screenshot: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_SCREENSHOT, params),
    captureFrame: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_CAPTURE_FRAME, params),
    clearCookies: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_CLEAR_COOKIES, params),
    clearCache: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_CLEAR_CACHE, params),
    setCommentMode: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_SET_COMMENT_MODE, params),
    clearComments: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_CLEAR_COMMENTS, params),
    ackCommentEvents: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_ACK_COMMENT_EVENTS, params),
    openExternal: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_OPEN_EXTERNAL, params),
    listLocalServers: (params) => ipcRenderer.invoke(IPC_CHANNELS.EMBEDDED_BROWSER_LIST_LOCAL_SERVERS, params),
    onAgentAction: (callback) => {
        const handler = (_event, payload) => {
            if (!payload || typeof payload !== 'object')
                return;
            const { sessionId, action } = payload;
            if (typeof sessionId !== 'string' || typeof action !== 'string')
                return;
            callback({ sessionId, action });
        };
        ipcRenderer.on(IPC_CHANNELS.EMBEDDED_BROWSER_AGENT_ACTION, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.EMBEDDED_BROWSER_AGENT_ACTION, handler);
    },
};
contextBridge.exposeInMainWorld('embeddedBrowserAPI', embeddedBrowserAPI);
const openMiniApp = (params) => ipcRenderer.invoke(IPC_CHANNELS.MINIAPP_OPEN, params);
let miniAppAppendHandler = null;
// Install before React mounts so an unavailable receiver returns a result instead of losing a request.
ipcRenderer.on(IPC_CHANNELS.MINIAPP_COMPOSER_REQUEST, async (_event, request) => {
    let result = { success: false, code: 'target_unavailable' };
    try {
        if (miniAppAppendHandler) {
            result = await miniAppAppendHandler(request);
        }
    }
    catch {
        result = { success: false, code: 'result_unknown' };
    }
    try {
        ipcRenderer.send(IPC_CHANNELS.MINIAPP_COMPOSER_REPLY, {
            requestId: request.requestId,
            result,
        });
    }
    catch {
        // The Host document may be exiting. Main settles its outstanding request on document teardown.
    }
});
const miniAppComposer = {
    onAppendRequest: (handler) => {
        miniAppAppendHandler = handler;
        return () => {
            if (miniAppAppendHandler === handler)
                miniAppAppendHandler = null;
        };
    },
};
const miniAppAPI = {
    composer: miniAppComposer,
    list: () => ipcRenderer.invoke(IPC_CHANNELS.MINIAPP_LIST),
    open: openMiniApp,
    refresh: (params) => ipcRenderer.invoke(IPC_CHANNELS.MINIAPP_REFRESH, params),
    stop: (params) => ipcRenderer.invoke(IPC_CHANNELS.MINIAPP_STOP, params),
};
contextBridge.exposeInMainWorld('miniAppAPI', miniAppAPI);
const browserProfileImportAPI = {
    listProfiles: (source) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_LIST, source),
    importCookies: (params) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_START, params),
    cancel: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_CANCEL, { requestId }),
    onProgress: (callback) => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_PROGRESS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_PROFILE_IMPORT_PROGRESS, listener);
    },
};
contextBridge.exposeInMainWorld('browserProfileImportAPI', browserProfileImportAPI);
// ============================================
// Updater API
// 用于应用自动更新
// ============================================
const updaterOpenModalCallbacks = new Set();
let updaterOpenModalPending = false;
// 登录页和首次引导页会异步加载更新 UI。preload 先接住菜单事件，
// renderer 注册监听后再交付，避免用户快速点击时事件丢失。
ipcRenderer.on(IPC_CHANNELS.UPDATER_OPEN_MODAL, () => {
    if (updaterOpenModalCallbacks.size === 0) {
        updaterOpenModalPending = true;
        return;
    }
    for (const callback of updaterOpenModalCallbacks)
        callback();
});
const updaterAPI = {
    // 检查更新
    checkForUpdates: (options) => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_CHECK, options),
    // 用户确认后下载更新
    downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_DOWNLOAD),
    // 安装更新并重启
    quitAndInstall: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_INSTALL),
    // 设置是否自动安装更新（由 Apollo agentConfig.autoUpdateDesktopVersion 推送）
    setAutoUpdate: (enabled) => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE, enabled),
    // 获取当前版本
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATER_GET_VERSION),
    // 监听更新状态变化
    onStatusChange: (callback) => {
        const handler = (_, event) => callback(event);
        ipcRenderer.on(IPC_CHANNELS.UPDATER_STATUS, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.UPDATER_STATUS, handler);
    },
    // 监听打开更新弹窗事件（由菜单栏触发）
    onOpenModal: (callback) => {
        updaterOpenModalCallbacks.add(callback);
        if (updaterOpenModalPending) {
            updaterOpenModalPending = false;
            callback();
        }
        return () => {
            updaterOpenModalCallbacks.delete(callback);
        };
    },
};
contextBridge.exposeInMainWorld('updaterAPI', updaterAPI);
// ============================================
// Deep Link API
// 用于接收从网页唤起时传递的参数
// ============================================
const deepLinkAPI = {
    // 监听 deep link 事件
    onDeepLink: (callback) => {
        const handler = (_, action) => callback(action);
        ipcRenderer.on(IPC_CHANNELS.DEEPLINK_RECEIVED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.DEEPLINK_RECEIVED, handler);
    },
};
contextBridge.exposeInMainWorld('deepLinkAPI', deepLinkAPI);
// ============================================
// File Tool API
// 用于执行 File 工具
// ============================================
const fileToolAPI = {
    stageAttachment: (fileName, bytes) => ipcRenderer.invoke(IPC_CHANNELS.FILE_STAGE_ATTACHMENT, fileName, bytes),
    saveWorkbook: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE_WORKBOOK, params),
    read: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, params),
    write: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_WRITE, params),
    edit: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_EDIT, params),
    multiEdit: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_MULTI_EDIT, params),
    glob: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_GLOB, params),
    grep: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_GREP, params),
    list: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST, params),
    stat: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, params),
    delete: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, params),
    move: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_MOVE, params),
    copy: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_COPY, params),
    trash: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_TRASH, params),
    download: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_DOWNLOAD, params),
    upload: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_UPLOAD, params),
    chmod: (params) => ipcRenderer.invoke(IPC_CHANNELS.FILE_CHMOD, params),
};
contextBridge.exposeInMainWorld('fileToolAPI', fileToolAPI);
// ============================================
// Logger API
// 用于渲染进程上报关键日志到主进程
// ============================================
const loggerAPI = {
    debug: (message, data, options) => ipcRenderer.invoke(IPC_CHANNELS.LOGGER_LOG, {
        level: 'debug',
        message,
        data,
        category: options?.category,
        filenamePrefix: options?.filenamePrefix,
    }),
    info: (message, data, options) => ipcRenderer.invoke(IPC_CHANNELS.LOGGER_LOG, {
        level: 'info',
        message,
        data,
        category: options?.category,
        filenamePrefix: options?.filenamePrefix,
    }),
    warn: (message, data, options) => ipcRenderer.invoke(IPC_CHANNELS.LOGGER_LOG, {
        level: 'warn',
        message,
        data,
        category: options?.category,
        filenamePrefix: options?.filenamePrefix,
    }),
    error: (message, data, options) => ipcRenderer.invoke(IPC_CHANNELS.LOGGER_LOG, {
        level: 'error',
        message,
        data,
        category: options?.category,
        filenamePrefix: options?.filenamePrefix,
    }),
};
contextBridge.exposeInMainWorld('loggerAPI', loggerAPI);
// ============================================
// Document Preview API
// Keeps filesystem paths in the trusted main process after source opening.
// ============================================
const pptxCorePorts = new Map();
const pptxCoreFrameListeners = new Set();
const PPTX_CORE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u;
function decodePptxCoreCapability(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const input = value;
    const keys = Object.keys(input).sort();
    if (keys.join(',') !== ['coreSessionId', 'nonce', 'schema'].sort().join(','))
        return null;
    if (input.schema !== 'mavis.pptx_core_session.v1' ||
        typeof input.coreSessionId !== 'string' ||
        !PPTX_CORE_OPAQUE_ID.test(input.coreSessionId) ||
        typeof input.nonce !== 'string' ||
        !PPTX_CORE_OPAQUE_ID.test(input.nonce)) {
        return null;
    }
    return Object.freeze({
        schema: 'mavis.pptx_core_session.v1',
        coreSessionId: input.coreSessionId,
        nonce: input.nonce,
    });
}
function closePptxCorePort(coreSessionId) {
    const current = pptxCorePorts.get(coreSessionId);
    if (!current)
        return;
    pptxCorePorts.delete(coreSessionId);
    try {
        current.port.close();
    }
    catch {
        // The renderer context or main peer already closed the data plane.
    }
}
ipcRenderer.on(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_PORT, (event, payload) => {
    const capability = decodePptxCoreCapability(payload);
    const port = event.ports[0];
    if (!capability || !port) {
        try {
            port?.close();
        }
        catch {
            // Reject malformed delivery without retaining the transferred port.
        }
        return;
    }
    closePptxCorePort(capability.coreSessionId);
    pptxCorePorts.set(capability.coreSessionId, { capability, port });
    port.onmessage = (messageEvent) => {
        const current = pptxCorePorts.get(capability.coreSessionId);
        if (!current || current.port !== port || current.capability.nonce !== capability.nonce)
            return;
        const frame = { capability, message: messageEvent.data };
        for (const listener of [...pptxCoreFrameListeners]) {
            try {
                listener(frame);
            }
            catch {
                // One renderer listener must not prevent ACK delivery by another.
            }
        }
    };
});
const documentPreviewAPI = {
    openSource: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_SOURCE, input),
    savePptxNotes: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_SAVE_PPTX_NOTES, input),
    openInSystem: (claim) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_IN_SYSTEM, claim),
    openAssetInApp: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_ASSET_IN_APP, input),
    stageSource: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_STAGE_SOURCE, input),
    openLegacySource: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_OPEN_LEGACY_SOURCE, input),
    stageLegacySource: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_STAGE_LEGACY_SOURCE, input),
    readSource: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_READ_SOURCE, input),
    resolvePptxSelection: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_RESOLVE_PPTX_SELECTION, input),
    createPptxCoreSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_CREATE, input),
    bindPptxCoreSession: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_BIND, input),
    cancelPptxCoreSession: async (input) => {
        const result = await ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_PPTX_CORE_CANCEL, input);
        if (result?.ok === true)
            closePptxCorePort(input.coreSessionId);
        return result;
    },
    postPptxCorePortMessage: (frame) => {
        const capability = decodePptxCoreCapability(frame?.capability);
        if (!capability)
            return false;
        const current = pptxCorePorts.get(capability.coreSessionId);
        if (!current || current.capability.nonce !== capability.nonce)
            return false;
        try {
            current.port.postMessage(frame.message);
            return true;
        }
        catch {
            closePptxCorePort(capability.coreSessionId);
            return false;
        }
    },
    onPptxCorePortMessage: (callback) => {
        pptxCoreFrameListeners.add(callback);
        return () => pptxCoreFrameListeners.delete(callback);
    },
    prepare: (request) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_PREPARE, request),
    cancel: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_CANCEL, input),
    release: (input) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_RELEASE, input),
    getBackendStatuses: () => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_GET_BACKEND_STATUSES),
    captureRendererRegion: (rect) => ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_PREVIEW_CAPTURE_RENDERER_REGION, rect),
    onProgress: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on(IPC_CHANNELS.DOCUMENT_PREVIEW_PROGRESS, listener);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.DOCUMENT_PREVIEW_PROGRESS, listener);
    },
};
contextBridge.exposeInMainWorld('documentPreviewAPI', documentPreviewAPI);
const previewClipboardAPI = {
    write: (payload) => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_CLIPBOARD_WRITE, payload),
};
contextBridge.exposeInMainWorld('previewClipboardAPI', previewClipboardAPI);
// ============================================
// PPT Preview WebContentsView API
// Manages a native overlay for rendering qlmanage HTML previews
// ============================================
const pptPreviewViewAPI = {
    create: (bounds, viewport) => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_CREATE, bounds, viewport),
    renderQuickLookSlides: (sourceId) => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_RENDER_SLIDES, sourceId),
    loadSource: (sourceId) => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_LOAD_SOURCE, sourceId),
    setBounds: (bounds, viewport) => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_SET_BOUNDS, bounds, viewport),
    setSelectionMode: (options) => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_SET_SELECTION_MODE, options),
    clearSelection: () => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_CLEAR_SELECTION),
    getSelectionEvents: () => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_GET_SELECTION_EVENTS),
    captureSelection: (rect) => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_CAPTURE_SELECTION, rect),
    captureFrame: () => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_CAPTURE_FRAME),
    getDebugState: () => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_GET_DEBUG_STATE),
    onSelectionEvent: (callback) => {
        const listener = (_event, payload) => callback(payload);
        ipcRenderer.on(IPC_CHANNELS.PPT_PREVIEW_SELECTION_EVENT, listener);
        return () => {
            ipcRenderer.removeListener(IPC_CHANNELS.PPT_PREVIEW_SELECTION_EVENT, listener);
        };
    },
    destroy: (options) => ipcRenderer.invoke(IPC_CHANNELS.PPT_PREVIEW_DESTROY, options),
};
contextBridge.exposeInMainWorld('pptPreviewViewAPI', pptPreviewViewAPI);
const logViewerAPI = {
    open: () => ipcRenderer.invoke(IPC_CHANNELS.LOG_VIEWER_OPEN),
    getFiles: () => ipcRenderer.invoke(IPC_CHANNELS.LOG_VIEWER_GET_FILES),
    getContent: (filePath, maxLines) => ipcRenderer.invoke(IPC_CHANNELS.LOG_VIEWER_GET_CONTENT, filePath, maxLines),
};
contextBridge.exposeInMainWorld('logViewerAPI', logViewerAPI);
// ============================================
// Hot Update API
// 用于渲染进程热更新
// ============================================
const hotUpdateAPI = {
    check: (force) => ipcRenderer.invoke(IPC_CHANNELS.HOT_UPDATE_CHECK, force),
    clearCache: () => ipcRenderer.invoke(IPC_CHANNELS.HOT_UPDATE_CLEAR_CACHE),
    reload: () => ipcRenderer.invoke(IPC_CHANNELS.HOT_UPDATE_RELOAD),
    getCurrentVersion: () => ipcRenderer.invoke(IPC_CHANNELS.HOT_UPDATE_GET_VERSION),
};
contextBridge.exposeInMainWorld('hotUpdateAPI', hotUpdateAPI);
// ============================================
// Computer Use Permission API
// 屏幕录制权限的 IPC bridge (B 流程):
// status / request / openSettings 三个 channel.
// 权限逻辑在 main/modules/screenshot/permission.ts，本入口仅做 IPC 透传。
// ============================================
const cuPermissionAPI = {
    onRequired: (listener) => {
        const handler = () => listener();
        ipcRenderer.on('cu:permission:required', handler);
        return () => ipcRenderer.removeListener('cu:permission:required', handler);
    },
    getStatus: () => ipcRenderer.invoke('cu:permission:status'),
    request: (kind) => ipcRenderer.invoke('cu:permission:request', kind),
    openSettings: (kind, presentation) => ipcRenderer.invoke('cu:permission:openSettings', kind, presentation),
};
contextBridge.exposeInMainWorld('cuPermissionAPI', cuPermissionAPI);
function phaseToBinding(phase) {
    switch (phase) {
        case 'pairing':
            return 'pairing';
        case 'connecting':
        case 'connected':
        case 'reconnecting':
            return 'bound';
        default:
            return 'unbound';
    }
}
function toUIStatus(s) {
    return {
        binding: phaseToBinding(s.phase),
        connected: s.phase === 'connected',
        pairingCode: s.pairing_code,
        pairingExpiresAt: s.expires_in !== undefined ? Date.now() + s.expires_in * 1000 : undefined,
        ...(typeof s.binding_id === 'number' ? { bindingId: s.binding_id } : {}),
    };
}
function isErrorResult(v) {
    return typeof v === 'object' && v !== null && v.phase === 'error';
}
const remoteControlAPI = {
    getDeviceId: () => ipcRenderer.invoke(IPC_CHANNELS.RC_GET_DEVICE_ID),
    getDeviceName: () => ipcRenderer.invoke(IPC_CHANNELS.RC_GET_DEVICE_NAME),
    onStatusChanged: (callback) => {
        const handler = (_event, status) => {
            callback(toUIStatus(status));
        };
        ipcRenderer.on(IPC_CHANNELS.RC_STATUS_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RC_STATUS_CHANGED, handler);
    },
    requestBind: async () => {
        // Trigger main-process proxy.connect() for WS lifecycle after binding confirmed
        const raw = await ipcRenderer.invoke(IPC_CHANNELS.RC_CONNECT);
        if (isErrorResult(raw)) {
            return {
                code: raw.last_error?.code ?? 'unknown',
                message: raw.last_error?.message ?? 'Connection failed',
            };
        }
        return toUIStatus(raw);
    },
    notifyBindingReady: async (payload) => {
        const raw = await ipcRenderer.invoke(IPC_CHANNELS.RC_BINDING_READY, payload);
        if (raw && raw.success === false) {
            return { code: 'connect_failed', message: raw.error ?? 'Connect failed' };
        }
        const status = await ipcRenderer.invoke(IPC_CHANNELS.RC_GET_STATUS);
        return toUIStatus(status);
    },
    onRefreshBinding: (callback) => {
        const handler = () => callback();
        ipcRenderer.on(IPC_CHANNELS.RC_REFRESH_BINDING, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RC_REFRESH_BINDING, handler);
    },
    publishSessionComposerMode: (input) => ipcRenderer.invoke(IPC_CHANNELS.RC_PUBLISH_SESSION_COMPOSER_MODE, input),
    onSessionComposerModeChanged: (callback) => {
        const handler = (_event, input) => callback(input);
        ipcRenderer.on(IPC_CHANNELS.RC_SESSION_COMPOSER_MODE_CHANGED, handler);
        return () => ipcRenderer.removeListener(IPC_CHANNELS.RC_SESSION_COMPOSER_MODE_CHANGED, handler);
    },
    notifyBindingLost: async () => {
        await ipcRenderer.invoke(IPC_CHANNELS.RC_BINDING_LOST);
    },
    markUnbound: async () => {
        const raw = await ipcRenderer.invoke(IPC_CHANNELS.RC_MARK_UNBOUND);
        if (raw && raw.success === false) {
            return { code: 'mark_unbound_failed', message: raw.error ?? 'Mark unbound failed' };
        }
        const status = await ipcRenderer.invoke(IPC_CHANNELS.RC_GET_STATUS);
        return toUIStatus(status);
    },
    cancelBind: async () => {
        const raw = await ipcRenderer.invoke(IPC_CHANNELS.RC_DISCONNECT);
        if (raw && !raw.success) {
            return { code: 'cancel_failed', message: raw.error ?? 'Cancel failed' };
        }
        // After cancel, return idle status
        const status = await ipcRenderer.invoke(IPC_CHANNELS.RC_GET_STATUS);
        return toUIStatus(status);
    },
    unbind: async () => {
        const raw = await ipcRenderer.invoke(IPC_CHANNELS.RC_DISCONNECT, { unbind: true });
        if (raw && !raw.success) {
            return { code: 'unbind_failed', message: raw.error ?? 'Unbind failed' };
        }
        const status = await ipcRenderer.invoke(IPC_CHANNELS.RC_GET_STATUS);
        return toUIStatus(status);
    },
};
contextBridge.exposeInMainWorld('remoteControlAPI', remoteControlAPI);
try {
    ipcRenderer.send(IPC_CHANNELS.OBSERVABILITY_STARTUP_MILESTONE, {
        milestone: 'preload_ready',
        timestampEpochMs: performance.timeOrigin + performance.now(),
    });
}
catch {
    // Startup telemetry is best-effort and must never block preload completion.
}
contextBridge.exposeInMainWorld('cuPreviewAPI', {
    inspect: (sessionId, capture) => ipcRenderer.invoke('cu:preview:inspect', sessionId, capture),
});
contextBridge.exposeInMainWorld('wordEditorAPI', {
    register: (input) => ipcRenderer.invoke('word-editor:register', input),
    unregister: (documentId) => ipcRenderer.send('word-editor:unregister', documentId),
    onRequest: (callback) => {
        const handler = (_event, request) => callback(request);
        ipcRenderer.on('word-editor:request', handler);
        return () => ipcRenderer.removeListener('word-editor:request', handler);
    },
    onCancel: (callback) => {
        const handler = (_event, requestId) => callback(requestId);
        ipcRenderer.on('word-editor:cancel', handler);
        return () => ipcRenderer.removeListener('word-editor:cancel', handler);
    },
    reply: (result) => ipcRenderer.send('word-editor:result', result),
});
contextBridge.exposeInMainWorld('excelEditorAPI', {
    register: (input) => ipcRenderer.invoke('excel-editor:register', input),
    unregister: (documentId) => ipcRenderer.send('excel-editor:unregister', documentId),
    onRequest: (callback) => {
        const handler = (_event, request) => callback(request);
        ipcRenderer.on('excel-editor:request', handler);
        return () => ipcRenderer.removeListener('excel-editor:request', handler);
    },
    onCancel: (callback) => {
        const handler = (_event, requestId) => callback(requestId);
        ipcRenderer.on('excel-editor:cancel', handler);
        return () => ipcRenderer.removeListener('excel-editor:cancel', handler);
    },
    reply: (result) => ipcRenderer.send('excel-editor:result', result),
});
