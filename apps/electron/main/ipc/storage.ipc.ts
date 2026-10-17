/**
 * 存储模块 IPC 处理
 * 使用 electron-store 存储配置
 */
import path from "path";
import fs from "fs";
import { app, BrowserWindow, session, ipcMain } from "electron";
import electronStore from "electron-store";
import { isProd, isStaging, isTest, isDev, isZh, LOCALE, isEn } from "../config/env";
import { SHORTCUT_KEYS, DEFAULT_SHORTCUT, IPC_CHANNELS } from "../config/constants";
import { setLocalRuntimeAuthContext, setLocalRuntimeContextWindowUsageEnabled, syncLocalRuntimeAuthContext } from "../modules/local-runtime";
import { logger } from "../utils";
import { scheduleMcodeToolsAuthorization, clearMcodeToolsAuthorization } from "../modules/mcode-tools";
import { resolveAccountOnboardingInstallCohort, resolveDesktopOnboardingMode } from "../windows/accountOnboardingEligibility";
import { DEFAULT_DESKTOP_TYPOGRAPHY, getDesktopTypographySnapshot, desktopTypographyEquals } from "../modules/desktop-typography";
import { DEFAULT_DESKTOP_APPEARANCE_STATE, getDesktopAppearanceState, desktopAppearanceStatesEqual, mergeDesktopAppearancePatch, emitDesktopAppearanceCommitted } from "../modules/desktop-appearance";
/**
 * 根据国内/海外版本和环境区分存储配置名称
 * 这样不同版本和环境可以共存而不互相影响
 *
 * 国内版:
 *   - 开发: minimax-agent-cn-config-dev
 *   - 测试: minimax-agent-cn-config-test
 *   - 预发: minimax-agent-cn-config-staging
 *   - 线上: minimax-agent-cn-config
 *
 * 海外版:
 *   - 开发: minimax-agent-config-dev
 *   - 测试: minimax-agent-config-test
 *   - 预发: minimax-agent-config-staging
 *   - 线上: minimax-agent-config
 */
function getEnvSuffix() {
    if (isProd)
        return '';
    if (isStaging)
        return '-staging';
    if (isTest)
        return '-test';
    if (isDev)
        return '-dev';
    return ''; // 默认为线上
}
const ENV_SUFFIX = getEnvSuffix();
const STORE_NAME = isZh
    ? `minimax-agent-cn-config${ENV_SUFFIX}`
    : `minimax-agent-config${ENV_SUFFIX}`;
const HAD_EXISTING_DESKTOP_STORE = fs.existsSync(path.join(app.getPath('userData'), `${STORE_NAME}.json`));
/**
 * 获取默认语言
 * 优先级：系统语言 > 构建时语言环境
 * 只支持 'en' 和 'zh' 两种语言
 */
function getDefaultLanguage() {
    // 获取系统语言（如 'en-US', 'zh-CN', 'zh-TW' 等）
    const systemLocale = app.getLocale();
    // 如果系统语言以 'zh' 开头，使用中文
    if (systemLocale?.toLowerCase().startsWith('zh')) {
        return 'zh';
    }
    // 如果系统语言以 'en' 开头，使用英文
    if (systemLocale?.toLowerCase().startsWith('en')) {
        return 'en';
    }
    // 其他情况使用构建时的语言环境
    return LOCALE;
}
export function getDefaultShortcut() {
    return {
        [SHORTCUT_KEYS.MINI_CHAT_CREATE]: DEFAULT_SHORTCUT.MINI_CHAT_CREATE,
    };
}
const defaultConfig = {
    language: getDefaultLanguage(),
    workingDirectory: '',
    menuBarVisible: true,
    runOnStartup: true,
    appModePreference: null,
    earlyAccessUpdateEnabled: false,
    webLinkOpenDestination: 'embedded',
    localLinkOpenDestination: 'embedded',
    fileLineWrapEnabled: true,
    fileOpenInNewTabEnabled: true,
    contextWindowUsageEnabled: true,
    uiBaseFontSize: DEFAULT_DESKTOP_TYPOGRAPHY.uiBaseFontSize,
    codeFontSize: DEFAULT_DESKTOP_TYPOGRAPHY.codeFontSize,
    appearance: DEFAULT_DESKTOP_APPEARANCE_STATE,
    plainTextEditorEnabled: true,
    globalAccessShortcut: getDefaultShortcut(),
    shortcutOverrides: {},
    developerOptions: {
        enabled: true,
        autoOpenNativeDevTools: false,
    },
    recentWorkspaces: [],
    maxRecentWorkspaces: 3,
    swimLaneName: '',
    chatPermissions: {},
    maxChatPermissions: 50,
    /** 是否开启定时任务通知, 默认开启 */
    scheduleNotification: true,
};
const defaultLocalStorageConfig = {
    showWebChatHistoryTips: true,
    isOnboardingCompleted: false,
    accountOnboardingInstallCohort: resolveAccountOnboardingInstallCohort({
        persistedCohort: undefined,
        hadExistingDesktopStore: HAD_EXISTING_DESKTOP_STORE,
    }),
};
// 创建 store 实例
const store = new electronStore({
    name: STORE_NAME,
    defaults: {
        user: {},
        sharedUser: {},
        config: defaultConfig,
        localStorageConfig: defaultLocalStorageConfig,
        tokens: {},
        mainWindowState: null,
    },
});
let appearanceSyncRevision = 0;
// electron-store exposes defaults without necessarily writing them to disk. Persist the
// first-launch cohort before later user/config writes make the store look pre-existing.
const initialLocalStorageConfig = store.get('localStorageConfig') || {};
store.set('localStorageConfig', {
    ...initialLocalStorageConfig,
    accountOnboardingInstallCohort: initialLocalStorageConfig.accountOnboardingInstallCohort ??
        defaultLocalStorageConfig.accountOnboardingInstallCohort,
});
/**
 * 读取上次退出时的主窗口几何状态（未记录时为 null）。
 * 返回原始值，由调用方负责校验与越界兜底。
 */
export function getStoredMainWindowState() {
    return store.get('mainWindowState') ?? null;
}
/**
 * 记录主窗口几何状态。
 */
export function setStoredMainWindowState(state) {
    store.set('mainWindowState', state);
}
/**
 * 获取 tokens
 */
export function getTokens() {
    return store.get('tokens') || {};
}
/**
 * 保存 tokens
 */
export function setTokens(tokens) {
    store.set('tokens', tokens);
}
function readInjectedAccessToken() {
    return (process.env.__MAVIS_PARENT_ACCESS_TOKEN?.trim() ||
        process.env.MAVIS_ACCESS_TOKEN?.trim() ||
        null);
}
export function bootstrapTokensFromManagedRuntimeEnv() {
    const tokens = getTokens();
    if (tokens.accessToken)
        return tokens;
    const accessToken = readInjectedAccessToken();
    if (!accessToken)
        return tokens;
    const nextTokens = { ...tokens, accessToken };
    setTokens(nextTokens);
    logger.info('[Storage] Bootstrapped access token from managed runtime env');
    return nextTokens;
}
/**
 * 清除 tokens
 */
export function clearTokens() {
    store.set('tokens', {});
}
/**
 * 获取用户信息
 */
export function getUserInfo() {
    return store.get(sharedAuthStorageEnabled ? 'sharedUser' : 'user') || {};
}
let sharedAuthStorageEnabled = false;
function isCredentialFieldName(key) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    return (normalized === 'authorization' ||
        normalized === 'cookie' ||
        normalized.endsWith('token') ||
        normalized.endsWith('credential') ||
        normalized.endsWith('secret'));
}
function hasCredentialFields(value) {
    return Object.entries(value).some(([key, fieldValue]) => isCredentialFieldName(key) &&
        fieldValue !== undefined &&
        fieldValue !== null &&
        String(fieldValue).trim().length > 0);
}
function withoutCredentialFields(user) {
    return Object.fromEntries(Object.entries(user).filter(([key]) => !isCredentialFieldName(key)));
}
const userInfoChangedListeners = new Set();
const swimLaneNameChangedListeners = new Set();
function effectiveSwimLaneName(value) {
    return typeof value === 'string' ? value.trim() : '';
}
export function onSwimLaneNameChanged(listener) {
    swimLaneNameChangedListeners.add(listener);
    return () => {
        swimLaneNameChangedListeners.delete(listener);
    };
}
export function onUserInfoChanged(listener) {
    userInfoChangedListeners.add(listener);
    return () => {
        userInfoChangedListeners.delete(listener);
    };
}
function emitUserInfoChanged() {
    for (const listener of userInfoChangedListeners) {
        try {
            listener();
        }
        catch (err) {
            logger.warn(`[Storage] user-info listener threw: ${String(err)}`);
        }
    }
}
function emitSwimLaneNameChanged(nextLane, previousLane) {
    for (const listener of swimLaneNameChangedListeners) {
        try {
            listener(nextLane, previousLane);
        }
        catch (err) {
            logger.warn(`[Storage] swim-lane listener threw: ${String(err)}`);
        }
    }
}
/**
 * 保存用户信息
 */
export function setUserInfo(user) {
    store.set(sharedAuthStorageEnabled ? 'sharedUser' : 'user', {
        ...(getUserInfo() || {}),
        ...user,
    });
    emitUserInfoChanged();
}
/** Replace account fields after Main verifies them with the current OAuth bearer. */
export function replaceSharedUserInfo(user) {
    const current = getUserInfo();
    const next = {
        ...(current.realUserID === user.realUserID ? current : { deviceID: current.deviceID }),
        ...user,
    };
    if (JSON.stringify(current) === JSON.stringify(next))
        return;
    store.set('sharedUser', next);
    emitUserInfoChanged();
    if (user.realUserID && user.realUserID !== current.realUserID) {
        // Only Main-verified account adoption emits this event. No credentials cross IPC.
        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed() || window.webContents.isDestroyed())
                continue;
            try {
                window.webContents.send(IPC_CHANNELS.STORAGE_ACCOUNT_CHANGED, {
                    realUserID: user.realUserID,
                });
            }
            catch {
                // A window may close between enumeration and send; adoption must still complete.
                logger.warn('[Storage] account-change notification could not reach a window');
            }
        }
    }
}
/**
 * 清除用户信息
 */
export function clearUserInfo() {
    store.set(sharedAuthStorageEnabled ? 'sharedUser' : 'user', {});
    emitUserInfoChanged();
}
export async function syncStoredLocalRuntimeAuthContext(options = {}) {
    const tokens = getTokens();
    const user = getUserInfo();
    void scheduleMcodeToolsAuthorization({
        accessToken: tokens.accessToken,
        subject: user.realUserID ?? user.userID,
    }).catch(() => logger.warn('[Storage] mcode-tools authorization scheduling failed'));
    await setLocalRuntimeAuthContext({
        accessToken: tokens.accessToken ?? null,
        realUserID: user.realUserID ?? user.userID ?? null,
        userEmail: user.userMail ?? user.email ?? null,
        userName: user.userName ?? user.username ?? null,
        subUserName: user.subUserName ?? null,
    }, {
        prepare: options.prepare ?? false,
        deferPersistenceUntilPrepared: shouldDeferLocalRuntimeAuthPersistence(),
    });
}
function shouldDeferLocalRuntimeAuthPersistence() {
    return isTest;
}
/**
 * 获取应用配置
 * 确保返回的配置包含所有必要的默认值
 */
export function getDesktopConfig() {
    const config = store.get('config') || {};
    let changed = false;
    // Migrate the removed one-shot DevTools flag into the application-level
    // developer policy. Keep this in the existing config seam so the migration
    // is idempotent and runs before any consumer reads the policy.
    const legacyAutoOpenNativeDevTools = config.enableTabDevTools === true;
    const persistedDeveloperOptions = config.developerOptions;
    if (!persistedDeveloperOptions || typeof persistedDeveloperOptions !== 'object') {
        config.developerOptions = {
            enabled: true,
            autoOpenNativeDevTools: legacyAutoOpenNativeDevTools,
        };
        changed = true;
    }
    else {
        const developerOptions = persistedDeveloperOptions;
        const normalizedDeveloperOptions = {
            enabled: developerOptions.enabled !== false,
            autoOpenNativeDevTools: legacyAutoOpenNativeDevTools || developerOptions.autoOpenNativeDevTools === true,
        };
        if (developerOptions.enabled !== normalizedDeveloperOptions.enabled ||
            developerOptions.autoOpenNativeDevTools !== normalizedDeveloperOptions.autoOpenNativeDevTools) {
            config.developerOptions = normalizedDeveloperOptions;
            changed = true;
        }
    }
    if (Object.prototype.hasOwnProperty.call(config, 'enableTabDevTools')) {
        delete config.enableTabDevTools;
        changed = true;
    }
    if (!config.globalAccessShortcut) {
        config.globalAccessShortcut = getDefaultShortcut();
        changed = true;
    }
    if (config.shortcutOverrides === undefined) {
        const legacyShortcuts = config.globalAccessShortcut;
        const hasLegacyMiniChat = Object.prototype.hasOwnProperty.call(legacyShortcuts, SHORTCUT_KEYS.MINI_CHAT_CREATE);
        const legacyMiniChat = legacyShortcuts[SHORTCUT_KEYS.MINI_CHAT_CREATE];
        if (!hasLegacyMiniChat || !legacyMiniChat) {
            config.shortcutOverrides = {
                [SHORTCUT_KEYS.MINI_CHAT_TOGGLE]: null,
            };
        }
        else if (legacyMiniChat === DEFAULT_SHORTCUT.MINI_CHAT_CREATE) {
            config.shortcutOverrides = {};
        }
        else {
            config.shortcutOverrides = {
                [SHORTCUT_KEYS.MINI_CHAT_TOGGLE]: legacyMiniChat,
            };
        }
        changed = true;
    }
    /** 确保 scheduleNotification 有默认值，或者目录不存在时重新创建 */
    if (config.scheduleNotification === undefined) {
        config.scheduleNotification = true;
        changed = true;
    }
    if (config.keepAwake === undefined) {
        config.keepAwake = true;
        changed = true;
    }
    if (config.webLinkOpenDestination !== 'embedded' && config.webLinkOpenDestination !== 'system') {
        config.webLinkOpenDestination = defaultConfig.webLinkOpenDestination;
        changed = true;
    }
    if (config.localLinkOpenDestination !== 'embedded' &&
        config.localLinkOpenDestination !== 'system') {
        config.localLinkOpenDestination = defaultConfig.localLinkOpenDestination;
        changed = true;
    }
    if (typeof config.fileOpenInNewTabEnabled !== 'boolean') {
        config.fileOpenInNewTabEnabled = defaultConfig.fileOpenInNewTabEnabled;
        changed = true;
    }
    if (typeof config.plainTextEditorEnabled !== 'boolean') {
        config.plainTextEditorEnabled = true;
    }
    if (typeof config.fileLineWrapEnabled !== 'boolean') {
        config.fileLineWrapEnabled = defaultConfig.fileLineWrapEnabled;
        changed = true;
    }
    // Context-window usage is enabled by default. Preserve an explicit false
    // opt-out, while migrating missing or invalid legacy values to true.
    if (config.contextWindowUsageEnabled !== true && config.contextWindowUsageEnabled !== false) {
        config.contextWindowUsageEnabled = defaultConfig.contextWindowUsageEnabled;
        changed = true;
    }
    const typography = getDesktopTypographySnapshot(config);
    if (config.uiBaseFontSize !== typography.uiBaseFontSize ||
        config.codeFontSize !== typography.codeFontSize) {
        config.uiBaseFontSize = typography.uiBaseFontSize;
        config.codeFontSize = typography.codeFontSize;
        changed = true;
    }
    const appearance = getDesktopAppearanceState(config);
    if (!config.appearance ||
        !desktopAppearanceStatesEqual(appearance, getDesktopAppearanceState({ appearance: config.appearance }))) {
        config.appearance = appearance;
        changed = true;
    }
    if (changed) {
        store.set('config', config);
    }
    return config;
}
/**
 * 更新应用配置
 */
export function setDesktopConfig(config) {
    const current = getDesktopConfig();
    const previousLane = effectiveSwimLaneName(current.swimLaneName);
    const previousTypography = getDesktopTypographySnapshot(current);
    const previousAppearance = getDesktopAppearanceState(current);
    const mergedConfig = { ...current, ...config };
    const nextTypography = getDesktopTypographySnapshot(mergedConfig);
    const nextAppearance = config.appearance === undefined
        ? previousAppearance
        : mergeDesktopAppearancePatch(previousAppearance, config.appearance);
    const nextConfig = { ...mergedConfig, ...nextTypography, appearance: nextAppearance };
    store.set('config', nextConfig);
    const appearanceChanged = !desktopTypographyEquals(previousTypography, nextTypography) ||
        !desktopAppearanceStatesEqual(previousAppearance, nextAppearance);
    const appearanceSnapshot = {
        ...nextAppearance,
        typography: nextTypography,
        syncRevision: appearanceChanged ? ++appearanceSyncRevision : appearanceSyncRevision,
    };
    if (appearanceChanged) {
        emitDesktopAppearanceCommitted(appearanceSnapshot);
    }
    const nextLane = effectiveSwimLaneName(nextConfig.swimLaneName);
    if (nextLane !== previousLane) {
        emitSwimLaneNameChanged(nextLane, previousLane);
    }
    if (config.contextWindowUsageEnabled !== undefined &&
        nextConfig.contextWindowUsageEnabled !== current.contextWindowUsageEnabled) {
        setLocalRuntimeContextWindowUsageEnabled(nextConfig.contextWindowUsageEnabled !== false);
    }
    return appearanceSnapshot;
}
/**
 * 清除应用配置
 * 保留系统级设置（开机启动、托盘、语言、快捷键等），这些是应用级偏好，不应随登出被重置
 */
export function clearDesktopConfig() {
    const current = getDesktopConfig();
    store.set('config', {
        ...defaultConfig,
        // 保留应用级设置（不随登出清除）
        runOnStartup: current.runOnStartup ?? defaultConfig.runOnStartup,
        menuBarVisible: current.menuBarVisible ?? defaultConfig.menuBarVisible,
        language: current.language ?? defaultConfig.language,
        appModePreference: current.appModePreference ?? defaultConfig.appModePreference,
        earlyAccessUpdateEnabled: current.earlyAccessUpdateEnabled ?? defaultConfig.earlyAccessUpdateEnabled,
        webLinkOpenDestination: current.webLinkOpenDestination ?? defaultConfig.webLinkOpenDestination,
        localLinkOpenDestination: current.localLinkOpenDestination ?? defaultConfig.localLinkOpenDestination,
        fileLineWrapEnabled: current.fileLineWrapEnabled ?? defaultConfig.fileLineWrapEnabled,
        uiBaseFontSize: current.uiBaseFontSize ?? defaultConfig.uiBaseFontSize,
        codeFontSize: current.codeFontSize ?? defaultConfig.codeFontSize,
        appearance: current.appearance ?? defaultConfig.appearance,
        plainTextEditorEnabled: current.plainTextEditorEnabled ?? true,
        fileOpenInNewTabEnabled: current.fileOpenInNewTabEnabled ?? defaultConfig.fileOpenInNewTabEnabled,
        globalAccessShortcut: current.globalAccessShortcut ?? defaultConfig.globalAccessShortcut,
        shortcutOverrides: current.shortcutOverrides ?? defaultConfig.shortcutOverrides,
        loginItemInitialized: current.loginItemInitialized,
        workingDirectory: current.workingDirectory ?? defaultConfig.workingDirectory,
        swimLaneName: current.swimLaneName ?? defaultConfig.swimLaneName,
        scheduleNotification: current.scheduleNotification ?? defaultConfig.scheduleNotification,
        localRuntimeDataParentDir: current.localRuntimeDataParentDir,
        localRuntimePreviousDataParentDirs: current.localRuntimePreviousDataParentDirs,
        developerOptions: current.developerOptions ?? defaultConfig.developerOptions,
        // Remote collection policy, not user data. Dropping it on sign-out would
        // silently re-open collection until Apollo is reachable again.
        collectionPolicy: current.collectionPolicy,
    });
}
/**
 * 获取 localStorage 配置
 */
export function getLocalStorageConfig() {
    return store.get('localStorageConfig') || {};
}
/**
 * 更新 localStorage 配置
 */
export function setLocalStorageConfig(config) {
    const current = getLocalStorageConfig();
    store.set('localStorageConfig', { ...current, ...config });
}
export function getAccountOnboardingInstallCohort() {
    return resolveAccountOnboardingInstallCohort({
        persistedCohort: getLocalStorageConfig().accountOnboardingInstallCohort,
        hadExistingDesktopStore: HAD_EXISTING_DESKTOP_STORE,
    });
}
/**
 * 清除 localStorage 配置
 * 保留应用级标记（不随登出清除），与 clearDesktopConfig 策略对齐
 */
export function clearLocalStorageConfig() {
    const current = store.get('localStorageConfig') || {};
    store.set('localStorageConfig', {
        ...defaultLocalStorageConfig,
        isOnboardingCompleted: current.isOnboardingCompleted ?? defaultLocalStorageConfig.isOnboardingCompleted,
        accountOnboardingInstallCohort: current.accountOnboardingInstallCohort ??
            defaultLocalStorageConfig.accountOnboardingInstallCohort,
    });
}
/**
 * 根据当前环境和语言获取需要种 cookie 的域名配置
 * 国内版和海外版使用不同域名，只种对应版本的 cookie
 */
function getTokenCookieDomains() {
    if (isTest || isDev) {
        return isZh
            ? [{ url: 'https://openplatform-test.xaminim.com/', domain: 'openplatform-test.xaminim.com' }]
            : [{ url: 'https://mmx-test.xaminim.com/', domain: 'mmx-test.xaminim.com' }];
    }
    if (isStaging) {
        return isZh
            ? [
                {
                    url: 'https://open-platform-for-online-test.xaminim.com/',
                    domain: 'open-platform-for-online-test.xaminim.com',
                },
            ]
            : [{ url: 'https://mmx-pre.xaminim.com/', domain: 'mmx-pre.xaminim.com' }];
    }
    return isZh
        ? [{ url: 'https://www.minimaxi.com/', domain: 'www.minimaxi.com' }]
        : [{ url: 'https://platform.minimax.io/', domain: 'platform.minimax.io' }];
}
/**
 * 登录成功后，将 accessToken 同步种到开平域名的 cookie 中
 * 与安卓 CookieManager.setCookie 对齐，但使用全域名而非通配符域名
 */
export async function syncTokenToCookies(accessToken) {
    const domains = getTokenCookieDomains();
    console.log('[Storage] syncTokenToCookies called, domains:', domains.map((d) => d.url));
    for (const { url, domain } of domains) {
        try {
            await session.defaultSession.cookies.set({
                url,
                domain,
                name: '_token',
                value: accessToken,
                path: '/',
                secure: true,
                sameSite: 'no_restriction',
                expirationDate: Math.floor(Date.now() / 1000) + 39 * 24 * 60 * 60, // 39天，服务端有效期40天
            });
            console.log(`[Storage] Cookie set for ${url}`);
        }
        catch (error) {
            console.error(`[Storage] Failed to set cookie for ${url}:`, error);
        }
    }
}
/**
 * 登出时清除开平域名上的 _token cookie
 */
export async function clearTokenCookies() {
    const domains = getTokenCookieDomains();
    for (const { url } of domains) {
        try {
            await session.defaultSession.cookies.remove(url, '_token');
            console.log(`[Storage] Cookie cleared for ${url}`);
        }
        catch (error) {
            console.error(`[Storage] Failed to clear cookie for ${url}:`, error);
        }
    }
}
async function clearLocalRuntimeAuthContext() {
    try {
        await setLocalRuntimeAuthContext({
            accessToken: null,
            realUserID: null,
            userEmail: null,
            userName: null,
            subUserName: null,
        }, {
            prepare: false,
            deferPersistenceUntilPrepared: shouldDeferLocalRuntimeAuthPersistence(),
        });
    }
    catch {
        // Local runtime may already be stopped during logout / app shutdown.
    }
}
/**
 * 清除所有数据（登出时调用）
 */
export async function clearAll(options = {}) {
    clearTokens();
    clearUserInfo();
    const mcodeToolsCleanup = options.skipMcodeToolsAuthorizationCleanup
        ? Promise.resolve()
        : clearMcodeToolsAuthorization().catch(() => logger.warn('[Storage] mcode-tools logout cleanup failed'));
    try {
        await clearLocalRuntimeAuthContext();
        clearLocalStorageConfig();
        clearDesktopConfig();
        await clearTokenCookies();
    }
    finally {
        await mcodeToolsCleanup;
    }
}
/**
 * 设置存储 IPC 处理器
 */
export function setupStorageIPC(options = {}) {
    sharedAuthStorageEnabled = options.sharedAuthEnabled === true;
    const sharedCredentialError = {
        success: false,
        error: 'Legacy credential IPC is disabled while Shared MCode OAuth is enabled.',
    };
    // 使用 ipcMain.on + event.returnValue 实现同步通信
    ipcMain.on(IPC_CHANNELS.STORAGE_GET_LANGUAGE_SYNC, (event) => {
        const config = getDesktopConfig();
        event.returnValue = config.language || (isEn ? 'en' : 'zh');
    });
    ipcMain.on(IPC_CHANNELS.STORAGE_GET_DESKTOP_APPEARANCE_SYNC, (event) => {
        const config = getDesktopConfig();
        const snapshot = {
            ...getDesktopAppearanceState(config),
            typography: getDesktopTypographySnapshot(config),
            syncRevision: appearanceSyncRevision,
        };
        event.returnValue = snapshot;
    });
    // Token 相关
    ipcMain.handle(IPC_CHANNELS.STORAGE_GET_TOKENS, () => {
        return options.sharedAuthEnabled ? {} : getTokens();
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_SET_TOKENS, async (_, tokens) => {
        if (options.sharedAuthEnabled)
            return sharedCredentialError;
        setTokens(tokens);
        await syncStoredLocalRuntimeAuthContext();
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_CLEAR_TOKENS, async () => {
        if (options.sharedAuthEnabled)
            return sharedCredentialError;
        clearTokens();
        const mcodeToolsCleanup = clearMcodeToolsAuthorization().catch(() => logger.warn('[Storage] mcode-tools token cleanup failed'));
        try {
            await clearLocalRuntimeAuthContext();
        }
        finally {
            await mcodeToolsCleanup;
        }
        return { success: true };
    });
    // 用户信息相关
    ipcMain.handle(IPC_CHANNELS.STORAGE_GET_USER, () => {
        const user = getUserInfo();
        return options.sharedAuthEnabled ? withoutCredentialFields(user) : user;
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_SET_USER, async (_, user) => {
        if (options.sharedAuthEnabled && hasCredentialFields(user))
            return sharedCredentialError;
        const currentAccount = getUserInfo().realUserID;
        if (options.sharedAuthEnabled &&
            currentAccount &&
            user.realUserID &&
            user.realUserID !== currentAccount) {
            return { success: false, error: 'Desktop account changed. Refresh account information.' };
        }
        setUserInfo(user);
        if (options.sharedAuthEnabled) {
            await options.onSharedIdentityChanged?.(getUserInfo());
        }
        else {
            await syncStoredLocalRuntimeAuthContext();
        }
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_CLEAR_USER, async () => {
        clearUserInfo();
        if (options.sharedAuthEnabled) {
            await options.onSharedIdentityChanged?.({});
        }
        else {
            await clearMcodeToolsAuthorization().catch(() => logger.warn('[Storage] mcode-tools user cleanup failed'));
        }
        return { success: true };
    });
    // 配置相关
    ipcMain.handle(IPC_CHANNELS.STORAGE_GET_DESKTOP_CONFIG, () => {
        return getDesktopConfig();
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_SET_DESKTOP_CONFIG, (_, config) => {
        const appearanceSnapshot = setDesktopConfig(config);
        return config.appearance === undefined
            ? { success: true }
            : { success: true, appearanceSnapshot };
    });
    // 清除所有数据
    ipcMain.handle(IPC_CHANNELS.STORAGE_CLEAR_ALL, async () => {
        if (options.sharedAuthEnabled)
            return sharedCredentialError;
        await clearAll();
        return { success: true };
    });
    // localStorage 配置相关
    ipcMain.handle(IPC_CHANNELS.STORAGE_GET_LOCAL_STORAGE_CONFIG, () => {
        return getLocalStorageConfig();
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_GET_DESKTOP_ONBOARDING_MODE, () => {
        return resolveDesktopOnboardingMode({
            installCohort: getAccountOnboardingInstallCohort(),
        });
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_SET_LOCAL_STORAGE_CONFIG, (_, config) => {
        setLocalStorageConfig(config);
        return { success: true };
    });
    ipcMain.handle(IPC_CHANNELS.STORAGE_CLEAR_LOCAL_STORAGE_CONFIG, () => {
        clearLocalStorageConfig();
        return { success: true };
    });
    // 保留历史 IPC channel 名称，主进程内改为直接同步给 local runtime。
    ipcMain.handle(IPC_CHANNELS.STORAGE_SYNC_DAEMON_AUTH, async (_, data) => {
        try {
            const realUserID = data.realUserID?.trim() || undefined;
            const userID = data.userID?.trim() || undefined;
            const subject = realUserID || userID;
            if (options.sharedAuthEnabled) {
                if (hasCredentialFields(data))
                    return sharedCredentialError;
                const currentAccount = getUserInfo().realUserID;
                if (realUserID && currentAccount && realUserID !== currentAccount) {
                    return {
                        success: false,
                        error: 'Desktop account changed. Refresh account information.',
                    };
                }
                if (subject) {
                    setUserInfo({
                        userID,
                        realUserID,
                        userMail: data.userMail,
                        email: data.email,
                        userName: data.userName,
                        subUserName: data.subUserName,
                    });
                    await options.onSharedIdentityChanged?.(getUserInfo());
                }
                return { success: true };
            }
            if (subject) {
                setUserInfo({
                    userID,
                    realUserID,
                    userMail: data.userMail,
                    email: data.email,
                    userName: data.userName,
                    subUserName: data.subUserName,
                });
            }
            void scheduleMcodeToolsAuthorization({
                accessToken: data.accessToken,
                subject,
            }).catch(() => logger.warn('[Storage] mcode-tools authorization scheduling failed'));
            await syncLocalRuntimeAuthContext({
                accessToken: data.accessToken ?? null,
                realUserID: subject ?? null,
                userEmail: data.userMail ?? data.email ?? null,
                userName: data.userName ?? null,
                subUserName: data.subUserName ?? null,
            }, {
                deferPersistenceUntilPrepared: shouldDeferLocalRuntimeAuthPersistence(),
            });
            return { success: true };
        }
        catch (err) {
            logger.warn(`[Storage] local runtime auth-context sync threw: ${String(err)}`);
            return { success: false, error: String(err) };
        }
    });
}
