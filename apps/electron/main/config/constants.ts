import { isDev, isEn, isTest, isStaging, isInternalBuild, isInsideBuild, isProd } from "./env";
import { resolveDevelopmentServerUrl } from "./development-server-url";
/**
 * User-facing display name for the app.
 * This is the brand name shown in window titles, menus, tray, etc.
 *
 * This is different from app.getName(), which can keep the legacy name for
 * userData path compatibility.
 *
 * 包身份（internal / inside）优先于后端环境（staging）：internal 包用预发后端
 * 构建（NEXT_PUBLIC_BUILD_ENV=staging + __MAVIS_BUILD_INTERNAL=true），显示名
 * 必须继续等于 electron-builder.{zh,en}.internal.json 的 productName。
 */
function getDisplayName() {
    if (isDev) {
        const devDisplayName = process.env.MAVIS_ELECTRON_DEV_DISPLAY_NAME?.trim();
        if (devDisplayName)
            return devDisplayName;
    }
    const isEnNonProd = isEn && (isDev || isTest || isStaging || isInternalBuild || isInsideBuild);
    const base = isEnNonProd ? 'MiniMaxEn' : 'MiniMax';
    // prettier-ignore
    const envPart = isDev ? ' Dev'
        : isTest && isInternalBuild ? ' Test Internal'
            : isTest ? ' Test'
                : isInternalBuild ? ' Internal'
                    : isInsideBuild ? ' Inside'
                        : isStaging ? ' Staging'
                            : '';
    return `${base}${envPart} Code`;
}
export let DISPLAY_NAME = getDisplayName();
export let MAIN_WINDOW_TITLE = DISPLAY_NAME;
export let FIREBASE_AUTH_DOMAIN = isProd || isStaging ? 'hailuo-ai.firebaseapp.com' : 'hailuoai-fd23b.firebaseapp.com';
export let GOOGLE_CLIENT_ID = isProd || isStaging
    ? '759297274593-pfid7m24v4g97qss70j7t5ac8u9mre80.apps.googleusercontent.com'
    : '849613179111-jsumti3qf3rlh48df6b8a97ug0ghtvh7.apps.googleusercontent.com';
export let MAIN_WINDOW_WIDTH = 1400;
export let MAIN_WINDOW_HEIGHT = 900;
export let MAIN_WINDOW_MIN_WIDTH = 480;
export let MAIN_WINDOW_MIN_HEIGHT = 600;
// 登录窗口尺寸（CN/EN 统一 SSO 登录）
export let LOGIN_WINDOW_WIDTH = 600;
export let LOGIN_WINDOW_HEIGHT = 660;
// 引导窗口尺寸
export let ONBOARDING_WINDOW_WIDTH = 1024;
export let ONBOARDING_WINDOW_HEIGHT = 614;
// 允许 OAuth 相关导航的域名（用于安全模块和窗口处理）
export let ALLOWED_OAUTH_DOMAINS = [
    // Google/Firebase OAuth
    'accounts.google.com',
    'firebaseapp.com',
    'googleapis.com',
    // Supabase OAuth
    'supabase.com',
    'supabase.io',
    'auth.supabase.io',
    // Apple Sign In OAuth
    'appleid.apple.com',
    'idmsa.apple.com',
    // 外部 OAuth 提供商
    'github.com',
    'gitlab.com',
    'bitbucket.org',
    'login.microsoftonline.com',
];
export let DEV_SERVER_URL = resolveDevelopmentServerUrl(process.env.MAVIS_ELECTRON_DEV_PORT);
// 生产环境协议
export let PROD_PROTOCOL = 'app://./';
const configuredDomainUrl = process.env.NEXT_PUBLIC_DOMAIN_URL;
export let DOMAIN_URL = configuredDomainUrl ||
    (isEn
        ? isProd
            ? 'https://agent.minimax.io'
            : isStaging
                ? 'https://matrix-overseas-pre.xaminim.com'
                : isDev
                    ? 'https://matrix-overseas-test.xaminim.com'
                    : 'https://matrix-overseas-test.xaminim.com'
        : isProd
            ? 'https://agent.minimax.cn'
            : isStaging
                ? 'https://matrix-pre.xaminim.com'
                : isDev
                    ? 'https://matrix-test.xaminim.com'
                    : 'https://matrix-test.xaminim.com');
// Keep this environment mapping aligned with packages/ui/src/const/urls.ts.
// Electron Main needs the exact Open Platform origin to scope Shared OAuth
// Bearer injection without granting credentials to arbitrary proxy targets.
export let OPEN_PLATFORM_API_ORIGIN = isEn
    ? isProd
        ? 'https://platform.minimax.io'
        : isStaging
            ? 'https://mmx-pre.xaminim.com'
            : 'https://mmx-test.xaminim.com'
    : isProd
        ? 'https://www.minimaxi.com'
        : isStaging
            ? 'https://open-platform-for-online-test.xaminim.com'
            : 'https://openplatform-test.xaminim.com';
export let IPC_CHANNELS = {
    // 系统相关
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
    // 全局快捷键设置
    DESKTOP_SET_GLOBAL_ACCESS_SHORTCUT: 'desktop:set-global-access-shortcut',
    DESKTOP_GET_GLOBAL_ACCESS_SHORTCUT: 'desktop:get-global-access-shortcut',
    DESKTOP_SET_SHORTCUT_OVERRIDES: 'desktop:set-shortcut-overrides',
    DESKTOP_SHORTCUTS_CHANGED: 'desktop:shortcuts-changed',
    DESKTOP_OPEN_NOTIFICATION_SETTINGS: 'desktop:open-notification-settings',
    DESKTOP_SET_LANGUAGE: 'desktop:set-language',
    DESKTOP_GET_LOCAL_RUNTIME_DATA_DIR_INFO: 'desktop:get-local-runtime-data-dir-info',
    DESKTOP_RELOCATE_LOCAL_RUNTIME_DATA_DIR: 'desktop:relocate-local-runtime-data-dir',
    // 系统通知
    NOTIFICATION_SHOW: 'notification:show',
    NOTIFICATION_CLICK: 'notification:click',
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
    EMBEDDED_BROWSER_COMMENT_BRIDGE_EVENT: 'embedded-browser:comment-bridge-event',
    EMBEDDED_BROWSER_AGENT_CURSOR_EVENT: 'embedded-browser:agent-cursor-event',
    EMBEDDED_BROWSER_OPEN_EXTERNAL: 'embedded-browser:open-external',
    EMBEDDED_BROWSER_LIST_LOCAL_SERVERS: 'embedded-browser:list-local-servers',
    EMBEDDED_BROWSER_CAPTURE_FRAME: 'embedded-browser:capture-frame',
    EMBEDDED_BROWSER_AGENT_ACTION: 'embedded-browser:agent-action',
    // Plugin-owned Mini App surfaces
    MINIAPP_LIST: 'miniapp:list',
    MINIAPP_OPEN: 'miniapp:open',
    MINIAPP_REFRESH: 'miniapp:refresh',
    MINIAPP_STOP: 'miniapp:stop',
    MINIAPP_DETACH: 'miniapp:detach',
    MINIAPP_ATTACH: 'miniapp:attach',
    MINIAPP_COMPOSER_APPEND: 'miniapp:composer-append',
    MINIAPP_COMPOSER_REQUEST: 'miniapp:composer-request',
    MINIAPP_COMPOSER_REPLY: 'miniapp:composer-reply',
    MINIAPP_AGENT_RUN: 'miniapp:agent-run',
    MINIAPP_AGENT_CANCEL: 'miniapp:agent-cancel',
    MINIAPP_AGENT_EVENT: 'miniapp:agent-event',
    MINIAPP_AGENT_REPLY: 'miniapp:agent-reply',
    MINIAPP_AGENT_ANSWER: 'miniapp:agent-answer',
    MINIAPP_AGENT_OPEN: 'miniapp:agent-open',
    MINIAPP_AGENT_MODELS: 'miniapp:agent-models',
    MINIAPP_AGENT_AGENTS: 'miniapp:agent-agents',
    MINIAPP_AGENT_CREATE: 'miniapp:agent-create',
    // Main -> Host renderer: show a Mini App session in the host chat's side panel.
    MINIAPP_AGENT_OPEN_SESSION: 'miniapp:agent-open-session',
    // Host renderer -> Main: the preload's answer to MINIAPP_AGENT_OPEN_SESSION (same requestId).
    MINIAPP_AGENT_OPEN_SESSION_REPLY: 'miniapp:agent-open-session-reply',
    // Host renderer -> Main: the user closed a Mini App session tab.
    MINIAPP_AGENT_PANEL_CLOSED: 'miniapp:agent-panel-closed',
    // Page-facing window handle; invoked only by the Mini App preload.
    MINIAPP_WINDOW_GET_STATE: 'miniapp:window-get-state',
    MINIAPP_WINDOW_UPDATE: 'miniapp:window-update',
    MINIAPP_WINDOW_FOCUS: 'miniapp:window-focus',
    // Browser profile import (trusted host renderer only)
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
    UPDATER_OPEN_MODAL: 'updater:open-modal', // 通知渲染进程打开更新弹窗
    // Deep Link
    DEEPLINK_RECEIVED: 'deeplink:received',
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
    // sidebar terminal (interactive PTY) — see docs/design/sidebar-terminal-panel.md
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
    // Versioned document preview source and backend bridge
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
    // PPT Preview WebContentsView (qlmanage HTML overlay)
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
    SSH_CONNECTIONS_LIST: 'ssh-connections:list',
    SSH_CONNECTIONS_OPERATION_STATES: 'ssh-connections:operation-states',
    SSH_CONNECTIONS_OPERATION_STATE: 'ssh-connections:operation-state',
    SSH_CONNECTIONS_ADD: 'ssh-connections:add',
    SSH_CONNECTIONS_CANCEL_ADD: 'ssh-connections:cancel-add',
    SSH_CONNECTIONS_ADD_PROGRESS: 'ssh-connections:add-progress',
    SSH_CONNECTIONS_UPDATE: 'ssh-connections:update',
    SSH_CONNECTIONS_SET_ENABLED: 'ssh-connections:set-enabled',
    SSH_CONNECTIONS_REMOTE_ACCOUNT: 'ssh-connections:remote-account',
    SSH_CONNECTIONS_REMOVE: 'ssh-connections:remove',
    SSH_CONNECTIONS_DISCOVER: 'ssh-connections:discover',
    SSH_CONNECTIONS_PROBE: 'ssh-connections:probe',
    SSH_CONNECTIONS_CONNECT: 'ssh-connections:connect',
    SSH_CONNECTIONS_SETUP_CLI: 'ssh-connections:setup-cli',
    SSH_CONNECTIONS_LIST_DIRECTORIES: 'ssh-connections:list-directories',
    SSH_PROJECTS_LIST: 'ssh-projects:list',
    SSH_PROJECTS_CREATE: 'ssh-projects:create',
    SSH_PROJECTS_UPDATE: 'ssh-projects:update',
    SSH_PROJECTS_REMOVE: 'ssh-projects:remove',
    SSH_PROJECTS_UPLOAD_ATTACHMENT: 'ssh-projects:upload-attachment',
    PROJECT_RUNTIME_TRANSPORT_REQUEST_PORT: 'project-runtime:transport-request-port',
    PROJECT_RUNTIME_TRANSPORT_DISCONNECT: 'project-runtime:transport-disconnect',
    PROJECT_RUNTIME_GET_STATUS: 'project-runtime:get-status',
    PROJECT_RUNTIME_TRANSPORT_LOST: 'project-runtime:transport-lost',
    PROJECT_RUNTIME_FAILED: 'project-runtime:failed',
    PROJECT_RUNTIME_STATUS: 'project-runtime:status',
    PROJECT_RUNTIME_NETWORK_ONLINE: 'project-runtime:network-online',
    PROJECT_RUNTIME_ACTIVE_PROJECT: 'project-runtime:active-project',
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
    // Tracking recorder (Electron local/test/staging/internal preview only)
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
    // 热更新
    HOT_UPDATE_CHECK: 'hot-update:check',
    HOT_UPDATE_CLEAR_CACHE: 'hot-update:clear-cache',
    HOT_UPDATE_RELOAD: 'hot-update:reload',
    HOT_UPDATE_GET_VERSION: 'hot-update:get-version',
    HOT_UPDATE_GET_VERSION_SYNC: 'hot-update:get-version-sync',
    // Remote Control bridge (plan §8.2)
    RC_CONNECT: 'rc:connect',
    RC_DISCONNECT: 'rc:disconnect',
    RC_GET_STATUS: 'rc:get-status',
    RC_STATUS_CHANGED: 'rc:status-changed',
    RC_CHECK_BINDING: 'rc:check-binding',
    RC_REQUEST_CODE: 'rc:request-code',
    RC_GET_DEVICE_ID: 'rc:get-device-id',
    RC_GET_DEVICE_NAME: 'rc:get-device-name',
    // Renderer → main: "binding is now active, here's the binding_id + ticket +
    // endpoint — please spin up the WS". This replaces the main process
    // polling /binding itself; the renderer owns the binding state because its
    // token (localStorage) is the source of truth, while the main process
    // token (storage.ipc) can drift out of sync.
    RC_BINDING_READY: 'rc:binding-ready',
    // Main → renderer: "the WS lost its ticket and the main process cannot
    // sign GET /binding — please re-sign via your axios pipeline and push the
    // result back (binding-ready when bound, binding-lost when state=none)".
    RC_REFRESH_BINDING: 'rc:refresh-binding',
    // Renderer → main: "GET /binding returned state=none — no mobile binding
    // owns this desktop". The ONLY disconnect trigger (self-heal design §4.2).
    RC_BINDING_LOST: 'rc:binding-lost',
    // Renderer → main: "I have already issued the unbind HTTP call via the
    // renderer's axios pipeline (which carries the matrix gateway signature
    // material that the main process cannot produce) — please stop the WS
    // and clear local binding state, do NOT call pairingClient.unbind again".
    // Distinct from rc:disconnect({unbind:true}) which assumes the main
    // process owns the unbind HTTP call (kept for the account-switch path,
    // which has no renderer axios available).
    RC_MARK_UNBOUND: 'rc:mark-unbound',
    // Renderer → main: "用户点了解绑，请给我这次 producer 全删的 request_id"。
    // request_id 由 main 生成并持久化（ADR-011 D12：renderer 刷新会丢），
    // 已存在未确认记录时复用同一个 id —— 幂等重放靠的就是它（方案 §4.5.4）。
    RC_BEGIN_UNBIND: 'rc:begin-unbind',
    // Renderer → main: 冷启动时读取未确认解绑记录，用于恢复重放。
    RC_GET_PENDING_UNBIND: 'rc:get-pending-unbind',
    // Renderer → main: 解绑得到**确定结果**（confirmed / rejected）。
    // 超时与网络错误不走这里 —— 那些保持待确认，不能凭 HTTP 超时判定未解绑。
    RC_RESOLVE_UNBIND: 'rc:resolve-unbind',
    RC_PUBLISH_SESSION_COMPOSER_MODE: 'rc:publish-session-composer-mode',
    RC_SESSION_COMPOSER_MODE_CHANGED: 'rc:session-composer-mode-changed',
    // 应用生命周期
    APP_BEFORE_QUIT: 'app:before-quit',
    APP_QUIT_CONFIRMATION_REQUEST: 'app:quit-confirmation-request',
    APP_QUIT_CONFIRMATION_RESULT: 'app:quit-confirmation-result',
    APP_QUIT_CONFIRMATION_ABORT: 'app:quit-confirmation-abort',
    APP_CONFIRM_QUIT: 'app:confirm-quit',
    APP_BRING_TO_FRONT: 'app:bring-to-front',
    // Dock file drop (macOS)
    DOCK_FILE_OPENED: 'dock:file-opened',
    DOCK_FILE_RECEIVER_READY: 'dock:file-receiver-ready',
};
/** 全局快捷键键值 */
export let SHORTCUT_KEYS = {
    MINI_CHAT_CREATE: 'miniChatCreate',
    MINI_CHAT_TOGGLE: 'miniChat.toggle',
};
