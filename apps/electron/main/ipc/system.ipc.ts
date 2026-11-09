/**
 * 系统信息 IPC 处理
 * 主题相关、语言设置等
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { app, ipcMain, nativeTheme, shell } from "electron";
import { logger, isLogFile, getLogFilePath, getCategoryLogger, flushLogs, getLogDir } from "../utils";
import { getExtraLogSources, resolveRuntimeLogsDir } from "../utils/extra-log-source";
import { getDesktopAppInstallDir } from "../utils/install-dir";
import { ensureDefaultProjectDir } from "../utils/default-project-dir";
import { importEsm } from "../utils/import-esm";
import { IPC_CHANNELS } from "../config/constants";
import { LOCAL_DESKTOP_RUNTIME_ID } from "@mavis/shared/desktop-runtime";
import { isInternalBuild } from "../config/env";
import { uploadToOSS } from "../modules/oss";
import { getUserInfo } from "./storage.ipc";
import { getMainWindow } from "../windows/mainWindow";
import { syncWindowBackgroundColors } from "../windows/utils";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { configureUtilityRuntimeDiagnosticsLogger, utilityRuntimeDiagnostics } from "../modules/local-runtime/utility/utility-runtime-diagnostics";
import { createRequiredUploadArtifact } from "../modules/diagnostics/required-upload-artifact";
import { writeDiagnosticArchive } from "../modules/diagnostics/diagnostic-archive";
import { collectDesktopEnvironment } from "../modules/diagnostics/desktop-environment";
import { orderSessionReportArtifacts } from "../modules/diagnostics/session-report-order";
configureUtilityRuntimeDiagnosticsLogger(logger);
const BROWSER_FEEDBACK_DIAGNOSTICS_FILE = 'browser-diagnostics.json';
/** Loaded on demand so feedback upload does not pull the Browser module graph into system IPC. */
async function collectBrowserDiagnosticsForUpload() {
    const [{ collectBrowserFeedbackDiagnostics }, { getEmbeddedBrowserFeedbackDiagnostics }, ipc] = await Promise.all([
        import('../modules/browser/browser-feedback-diagnostics'),
        import('../modules/browser/embedded-browser-manager'),
        import('./browserTelemetry.ipc'),
    ]);
    return collectBrowserFeedbackDiagnostics({
        pages: getEmbeddedBrowserFeedbackDiagnostics,
        renderer: () => getMainWindow()?.webContents,
        requestRenderer: ipc.requestBrowserRendererDiagnostics,
        appVersion: app.getVersion(),
        platform: process.platform,
    });
}
const UPLOAD_LOG_MAX_FILES = 4096;
// 排查台超过 550MB 拒收，总量上限保持 512MB。
const UPLOAD_LOG_MAX_BYTES = 512 * 1024 * 1024;
/** 排在所有日志之后的会话文件来源（工单会话的历史段、工具输出和子会话）。 */
const DEFERRED_SESSION_REPORT_SOURCE = 'session-report-deferred';
/** 内测版反馈附带的工作区快照，排在最后。 */
const WORKSPACE_SNAPSHOT_SOURCE = 'workspace-snapshot';
const WORKSPACE_SNAPSHOT_ARCHIVE_NAME = 'workspace/workspace.zip';
const WORKSPACE_SNAPSHOT_MANIFEST_NAME = 'workspace/manifest.json';
/**
 * 可用磁盘空间低于这个值就不拍工作区快照：日志才是反馈的基础。快照源码上限 1GB，压缩后一般几百 MB，
 * 装包时快照本身、暂存副本和日志包里各占一份，留足余量才开始拍。
 */
const WORKSPACE_SNAPSHOT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_LOG_WINDOW_MS = 2 * DAY_MS;
/**
 * The runtime disk log transports (`runtime-*.log` / `im-runtime-*.log`)
 * live inside the utility process, so flushing them requires a control-plane
 * round trip — calling `flushLocalRuntimeLogging()` in main would hit a
 * separate, never-configured module instance and silently no-op. Best-effort:
 * a stuck utility must not strand the upload path. The utility module is
 * loaded lazily at call time so this file's static graph stays small for
 * unit tests that mock a minimal `electron` surface.
 */
async function flushRuntimeLogsSafe() {
    try {
        const utility = await import('../modules/local-runtime/utility');
        const flushed = await utility.flushUtilityRuntimeLogs();
        if (!flushed) {
            logger.warn('[UploadLog] utility runtime log flush skipped (runtime not ready or timed out)');
        }
    }
    catch (err) {
        logger.warn(`[UploadLog] utility runtime log flush failed: ${String(err)}`);
    }
}
function toSharedFileSource(runtime, source) {
    return new runtime.FileDiagnosticArtifactSource({
        id: source.prefix.replace(/\/$/u, '') || 'external',
        label: source.prefix.replace(/\/$/u, '') || 'External diagnostics',
        dir: source.dir,
        match: source.match,
        prefix: source.prefix,
        privacy: 'sensitive',
        uploadDefault: 'consent-required',
        ...(source.recursive ? { recursive: true } : {}),
        ...(source.maxBytesPerFile ? { maxBytesPerFile: source.maxBytesPerFile } : {}),
        ...(source.errorContext ? { errorContext: source.errorContext } : {}),
    });
}
/**
 * 装包分档，装不下时先丢后面的：
 * ① 必装：调用方给的文件（如 upload_meta）、浏览器诊断、桌面环境、工单会话的核心文件；
 * ② 日志：各日志来源，顺序不变；
 * ③ 其余会话文件：工单会话的历史段和工具输出、子会话；
 * ④ 内测版反馈附带的工作区快照。
 */
async function collectUploadDiagnosticBundle(input) {
    const runtime = await importEsm('@mavis/local-runtime-v2/diagnostics');
    const goalDiagnostics = await importEsm('@mavis/local-runtime-v2');
    const runtimeDataDir = resolveLocalRuntimeDataDir();
    const requiredArtifacts = [];
    const skippedArtifacts = [];
    if (input.extraFiles && input.extraFiles.length > 0) {
        for (const ef of input.extraFiles) {
            try {
                requiredArtifacts.push(await createRequiredUploadArtifact(ef));
            }
            catch {
                skippedArtifacts.push({ name: ef.name, reason: 'stat_failed' });
            }
        }
    }
    try {
        requiredArtifacts.push(await createRequiredUploadArtifact({
            name: BROWSER_FEEDBACK_DIAGNOSTICS_FILE,
            content: JSON.stringify(await collectBrowserDiagnosticsForUpload(), null, 2),
        }));
    }
    catch {
        skippedArtifacts.push({ name: BROWSER_FEEDBACK_DIAGNOSTICS_FILE, reason: 'collection_failed' });
    }
    try {
        requiredArtifacts.push(await createRequiredUploadArtifact({
            name: 'desktop-environment.json',
            content: JSON.stringify(await collectDesktopEnvironment(), null, 2),
        }));
    }
    catch {
        skippedArtifacts.push({ name: 'desktop-environment.json', reason: 'collection_failed' });
    }
    for (const artifact of input.sessionReport?.required ?? []) {
        try {
            requiredArtifacts.push(await createRequiredUploadArtifact(artifact));
        }
        catch {
            skippedArtifacts.push({ name: artifact.name, reason: 'stat_failed' });
        }
    }
    const deferredArtifacts = [];
    for (const artifact of input.sessionReport?.deferred ?? []) {
        try {
            deferredArtifacts.push(await createRequiredUploadArtifact(artifact, DEFERRED_SESSION_REPORT_SOURCE));
        }
        catch {
            skippedArtifacts.push({ name: artifact.name, reason: 'stat_failed' });
        }
    }
    const workspaceArtifacts = [];
    const snapshot = input.workspaceSnapshot;
    if (snapshot && 'skipped' in snapshot) {
        skippedArtifacts.push({ name: WORKSPACE_SNAPSHOT_ARCHIVE_NAME, reason: snapshot.skipped });
    }
    for (const artifact of snapshot && 'artifacts' in snapshot ? snapshot.artifacts : []) {
        try {
            workspaceArtifacts.push(await createRequiredUploadArtifact(artifact, WORKSPACE_SNAPSHOT_SOURCE));
        }
        catch {
            skippedArtifacts.push({ name: artifact.name, reason: 'stat_failed' });
        }
    }
    const sources = [
        ...(requiredArtifacts.length > 0
            ? [
                new runtime.StaticDiagnosticArtifactSource('required-upload-artifacts', 'Required upload artifacts', requiredArtifacts),
            ]
            : []),
        new runtime.FileDiagnosticArtifactSource({
            id: 'electron-logs',
            label: 'Electron logs',
            dir: input.logDir,
            match: isLogFile,
            prefix: '',
            privacy: 'sensitive',
            uploadDefault: 'consent-required',
        }),
        new runtime.LocalAssetManifestDiagnosticSource(resolveLocalRuntimeDataDir()),
        new goalDiagnostics.ThreadGoalDecisionDiagnosticSource((query) => goalDiagnostics.readGoalDiagnosticRows(runtimeDataDir, query)),
        ...getExtraLogSources().map((source) => toSharedFileSource(runtime, source)),
        runtime.createRuntimeSessionLogSource(resolveRuntimeLogsDir(), input.sessionId),
        ...(deferredArtifacts.length > 0
            ? [
                new runtime.StaticDiagnosticArtifactSource(DEFERRED_SESSION_REPORT_SOURCE, 'Session report (history segments, tool outputs, child sessions)', deferredArtifacts),
            ]
            : []),
        ...(workspaceArtifacts.length > 0
            ? [
                new runtime.StaticDiagnosticArtifactSource(WORKSPACE_SNAPSHOT_SOURCE, 'Workspace snapshot (internal builds)', workspaceArtifacts),
            ]
            : []),
    ];
    const bundle = await runtime.collectDiagnosticBundle({
        sources,
        sinceMs: input.sinceMs,
        ...(input.untilMs === undefined ? {} : { untilMs: input.untilMs }),
        limits: {
            maxFiles: UPLOAD_LOG_MAX_FILES,
            maxBytes: UPLOAD_LOG_MAX_BYTES,
        },
    });
    bundle.manifest.skippedArtifacts = [
        ...skippedArtifacts,
        ...(bundle.manifest.skippedArtifacts ?? []),
    ];
    return bundle;
}
/**
 * 设置系统信息 IPC 处理器
 */
export function setupSystemIPC(options = {}) {
    // 获取系统主题
    ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_THEME, () => {
        return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    });
    ipcMain.handle(IPC_CHANNELS.SYSTEM_SET_THEME_SOURCE, (_, themeSource) => {
        nativeTheme.themeSource = themeSource;
        syncWindowBackgroundColors();
        return {
            success: true,
            themeSource: nativeTheme.themeSource,
        };
    });
    // 监听系统主题变化
    nativeTheme.on('updated', () => {
        syncWindowBackgroundColors();
        getMainWindow()?.webContents.send(IPC_CHANNELS.SYSTEM_THEME_CHANGED, nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    });
    // 获取日志文件路径
    ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_LOG_FILE_PATH, () => {
        return getLogFilePath();
    });
    // 打开日志文件（使用系统默认应用）
    ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_LOG_FILE, async () => {
        const logPath = getLogFilePath();
        try {
            await shell.openPath(logPath);
            return { success: true, path: logPath };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 重启应用（支持指定启动后跳转的页面）
    ipcMain.handle(IPC_CHANNELS.DESKTOP_RELAUNCH, async (_, relaunchOptions) => {
        if (!options.requestQuit) {
            logger.error('[System] lifecycle quit coordinator is unavailable for relaunch');
            return { success: false, error: 'LIFECYCLE_UNAVAILABLE' };
        }
        const result = await options.requestQuit({
            kind: 'relaunch',
            source: 'desktop-relaunch',
            ...(relaunchOptions?.targetUrl
                ? {
                    options: {
                        args: process.argv.slice(1).concat([`--target-url=${relaunchOptions.targetUrl}`]),
                    },
                }
                : {}),
        });
        if (result.status !== 'accepted') {
            return { success: false, error: result.reason };
        }
        if (result.plan.kind !== 'relaunch') {
            logger.warn(`[System] relaunch intent was superseded by a concurrent '${result.plan.kind}' quit`);
            return { success: false, error: 'RELAUNCH_SUPERSEDED' };
        }
        if (result.terminalOutcome !== 'dispatched') {
            logger.error('[System] Electron relaunch terminal action failed');
            return { success: false, error: 'RELAUNCH_FAILED' };
        }
        return { success: true };
    });
    // ============================================
    // 工作区目录
    // ============================================
    // 创建工作区目录（如果已存在则不创建）
    ipcMain.handle(IPC_CHANNELS.SYSTEM_CREATE_DIR, async (_, dirPath) => {
        try {
            // 使用 recursive: true 可以创建多级目录，且如果目录已存在不会报错
            await fs.promises.mkdir(dirPath, { recursive: true });
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 未选择文件夹时新建项目使用的 Documents/MiniMax/<项目名>
    ipcMain.handle(IPC_CHANNELS.SYSTEM_ENSURE_DEFAULT_PROJECT_DIR, (_, projectName) => typeof projectName === 'string'
        ? ensureDefaultProjectDir(app.getPath('documents'), projectName)
        : { success: false, error: 'invalid-name' });
    // 打开指定文件夹
    ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_DIR, async (_, dirPath) => {
        try {
            const error = await shell.openPath(dirPath);
            if (error)
                return { success: false, error };
            return { success: true };
        }
        catch (error) {
            return { success: false, error: String(error) };
        }
    });
    // 在文件夹中显示文件
    ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_FILE_IN_FOLDER, async (_, filePath) => {
        try {
            shell.showItemInFolder(filePath);
            return { success: true };
        }
        catch (error) {
            console.error('[FileModule] Show in folder error:', error);
            return { success: false, error: String(error) };
        }
    });
    // 获取用户 home 目录路径
    // macOS/Linux: ~
    // Windows: %USERPROFILE%
    ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_HOME_PATH, () => {
        return os.homedir();
    });
    ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_APP_INSTALL_DIR, () => {
        return getDesktopAppInstallDir();
    });
    // 安装包版本（同步，用于 preload 初始化 platformInfo.appVersion）
    ipcMain.on(IPC_CHANNELS.SYSTEM_GET_APP_VERSION_SYNC, (event) => {
        event.returnValue = app.getVersion();
    });
    // ============================================
    // 渲染进程日志上报
    // ============================================
    ipcMain.handle(IPC_CHANNELS.LOGGER_LOG, (_, params) => {
        const { level, message, data, category, filenamePrefix } = params;
        const prefix = '[Renderer]';
        const logContent = data !== undefined ? { msg: `${prefix} ${message}`, data } : `${prefix} ${message}`;
        // 根据传入的 category 选择对应的 logger，默认 Main。
        // category 为 'main' 时同样要尊重 filenamePrefix：否则渲染进程无法写入
        // main-<prefix>-<date>.log，日志会被并入 main 主文件并在 dev 下被文件白
        // 名单直接丢弃。
        const targetLogger = category && category !== 'main'
            ? getCategoryLogger(category, filenamePrefix)
            : filenamePrefix
                ? getCategoryLogger('main', filenamePrefix)
                : logger;
        switch (level) {
            case 'debug':
                targetLogger.debug(logContent);
                break;
            case 'info':
                targetLogger.info(logContent);
                break;
            case 'warn':
                targetLogger.warn(logContent);
                break;
            case 'error':
                targetLogger.error(logContent);
                break;
            default:
                targetLogger.info(logContent);
        }
        return { success: true };
    });
    // ============================================
    // 上传日志到 OSS
    // ============================================
    ipcMain.handle(IPC_CHANNELS.SYSTEM_UPLOAD_LOG, async () => {
        return uploadLog();
    });
}
/** 装包前把快照和日志刷到磁盘；两边都是尽力而为，卡住的 Utility 不拖住 main 日志。 */
async function flushDiagnosticsForUpload() {
    // Snapshot synchronously before the original parallel flush. Both drains
    // stay best-effort and a stuck Utility cannot delay the main log flush.
    utilityRuntimeDiagnostics.writeSnapshot('feedback_upload');
    await Promise.allSettled([flushLogs(), flushRuntimeLogsSafe()]);
}
/** zip 文件名里的日期：YYYYMMDD。 */
function formatArchiveDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}
/**
 * 上传日志到 OSS
 * 可在主进程中直接调用
 */
export async function uploadLog(extraFiles) {
    try {
        logger.info('[UploadLog] Starting log upload...');
        await flushDiagnosticsForUpload();
        // 获取日志目录
        const logDir = getLogDir();
        if (!fs.existsSync(logDir)) {
            if (extraFiles && extraFiles.length > 0) {
                await fs.promises.mkdir(logDir, { recursive: true });
            }
            else {
                return { success: false, error: 'Log directory not found' };
            }
        }
        // 获取最近 2 天的所有类别日志文件
        const now = new Date();
        const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        const logFiles = [];
        const files = await fs.promises.readdir(logDir);
        for (const file of files) {
            // 匹配所有类别的日志文件（main-、update-、api-、heartbeat-、chat-）
            if (isLogFile(file)) {
                const filePath = path.join(logDir, file);
                let stat;
                try {
                    stat = await fs.promises.stat(filePath);
                }
                catch {
                    // A rotated or unreadable log must not prevent uploading Session evidence.
                    continue;
                }
                // 检查文件修改时间是否在最近 2 天内
                if (stat.mtime >= twoDaysAgo) {
                    logFiles.push({
                        name: file,
                        path: filePath,
                        date: stat.mtime,
                    });
                }
            }
        }
        // Append caller-supplied extra files (e.g. feedback metadata JSON)
        if (extraFiles) {
            for (const ef of extraFiles) {
                if (!ef.path)
                    continue;
                try {
                    const stat = await fs.promises.stat(ef.path);
                    logFiles.push({ name: ef.name, path: ef.path, date: stat.mtime });
                }
                catch {
                    // Skip missing extra files
                }
            }
        }
        const sinceMs = twoDaysAgo.getTime();
        const bundle = await collectUploadDiagnosticBundle({
            logDir,
            sinceMs,
            extraFiles,
        });
        if (bundle.artifacts.length === 0) {
            return { success: false, error: 'No diagnostic artifacts found in the last 2 days' };
        }
        // 按日期排序
        logFiles.sort((a, b) => a.date.getTime() - b.date.getTime());
        const fromDate = formatArchiveDate(logFiles[0]?.date ?? twoDaysAgo);
        const toDate = formatArchiveDate(logFiles[logFiles.length - 1]?.date ?? now);
        // 获取设备标识（使用 userID 或生成随机 ID）
        const userInfo = getUserInfo();
        const deviceId = userInfo.realUserID || userInfo.userID || `anonymous_${Date.now()}`;
        // 生成 zip 文件名: logs_YYYYMMDD-YYYYMMDD_timestamp.zip
        const timestamp = Date.now();
        const zipFileName = `logs_${fromDate}-${toDate}_${timestamp}.zip`;
        const zipFilePath = path.join(logDir, zipFileName);
        logger.info(`[UploadLog] Creating zip file: ${zipFileName} with ${bundle.artifacts.length} diagnostic artifacts`);
        // 创建 zip 文件
        await writeDiagnosticArchive(zipFilePath, bundle);
        // 上传到 OSS
        logger.info(`[UploadLog] Uploading to OSS: ${zipFilePath}`);
        const uploadResult = await uploadToOSS({
            file_path: zipFilePath,
        }, true);
        // 删除本地 zip 文件
        try {
            await fs.promises.unlink(zipFilePath);
            logger.info(`[UploadLog] Deleted local zip file: ${zipFilePath}`);
        }
        catch (deleteError) {
            logger.warn(`[UploadLog] Failed to delete local zip file: ${deleteError}`);
        }
        // 检查上传结果
        if (uploadResult.success === 1) {
            const resultPath = `${deviceId}/${zipFileName}`;
            logger.info(`[UploadLog] Upload successful: ${resultPath}`);
            return { success: true, path: resultPath, uploadId: uploadResult.upload_id };
        }
        else {
            logger.error(`[UploadLog] Upload failed: ${uploadResult.err_msg}`);
            return { success: false, error: uploadResult.err_msg || 'Upload failed' };
        }
    }
    catch (error) {
        logger.error(`[UploadLog] Error: ${error}`);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
const FEEDBACK_CATEGORIES = new Set(['general', 'browser', 'plugin']);
const BROWSER_CONTEXT_BACKENDS = new Set(['web-contents-view', 'webview']);
const BROWSER_CONTEXT_SURFACES = new Set(['browser', 'miniapp']);
/** Renderer-supplied feedback metadata is untrusted: keep bounded enum/number fields only. */
export function sanitizeFeedbackMetadata(data) {
    const result = {};
    if (typeof data.feedback_category === 'string' && FEEDBACK_CATEGORIES.has(data.feedback_category))
        result.feedback_category = data.feedback_category;
    const raw = data.browser_context;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const input = raw;
        const context = {};
        if (typeof input.rendererBackend === 'string' &&
            BROWSER_CONTEXT_BACKENDS.has(input.rendererBackend))
            context.rendererBackend = input.rendererBackend;
        if (typeof input.surfaceKind === 'string' && BROWSER_CONTEXT_SURFACES.has(input.surfaceKind))
            context.surfaceKind = input.surfaceKind;
        if (typeof input.urlScheme === 'string' && /^[a-z]{1,16}$/.test(input.urlScheme))
            context.urlScheme = input.urlScheme;
        if (Number.isSafeInteger(input.tabId))
            context.tabId = input.tabId;
        if (Object.keys(context).length)
            result.browser_context = context;
    }
    return result;
}
/** 与 IDL FeedbackCategory 一致（matrix/api_common/feedback.thrift）；1~3 不用。 */
export let FEEDBACK_ISSUE_CATEGORY = {
    SESSION_ISSUE: 4,
    APP_ISSUE: 5,
    SUGGESTION: 6,
    MESSAGE_DISLIKE: 7,
};
const FEEDBACK_TICKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_FEEDBACK_ID_LENGTH = 256;
const FEEDBACK_ISSUE_CATEGORIES = Object.values(FEEDBACK_ISSUE_CATEGORY);
function isPlainRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function boundedId(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed && trimmed.length <= MAX_FEEDBACK_ID_LENGTH ? trimmed : undefined;
}
/** 渲染进程传来的入队参数不可信：工单号、类型、会话 ID 和时间都要校验，元数据只留已知字段。 */
export function sanitizeFeedbackLogRequest(raw) {
    if (!isPlainRecord(raw))
        return undefined;
    const ticketId = typeof raw.ticketId === 'string' ? raw.ticketId.trim() : '';
    if (!FEEDBACK_TICKET_ID_PATTERN.test(ticketId))
        return undefined;
    const category = typeof raw.category === 'number' && FEEDBACK_ISSUE_CATEGORIES.includes(raw.category)
        ? raw.category
        : undefined;
    const sessionId = boundedId(raw.sessionId);
    const conversationSource = boundedId(raw.conversationSource);
    const lastActiveAtMs = typeof raw.sessionLastActiveAtMs === 'number' &&
        Number.isFinite(raw.sessionLastActiveAtMs) &&
        raw.sessionLastActiveAtMs > 0
        ? raw.sessionLastActiveAtMs
        : undefined;
    const metadata = isPlainRecord(raw.metadata) ? raw.metadata : {};
    const messageId = boundedId(metadata.message_id);
    return {
        ticketId,
        ...(category ? { category } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(conversationSource ? { conversationSource } : {}),
        ...(lastActiveAtMs ? { sessionLastActiveAtMs: lastActiveAtMs } : {}),
        metadata: {
            feedback_text: typeof metadata.feedback_text === 'string' ? metadata.feedback_text : '',
            upload_time: typeof metadata.upload_time === 'string' ? metadata.upload_time : '',
            session_id: typeof metadata.session_id === 'string' ? metadata.session_id : '',
            session_status: isPlainRecord(metadata.session_status) ? metadata.session_status : {},
            message_list: Array.isArray(metadata.message_list) ? metadata.message_list : [],
            ...sanitizeFeedbackMetadata(metadata),
            ...(messageId ? { message_id: messageId } : {}),
        },
    };
}
/**
 * 这份反馈带不带会话内容：会话问题、消息点踩带；不带类型的入口（浏览器问题）指定了会话时也带，
 * 保持原来的内容；App 问题、意见建议即使传了会话 ID 也不带。
 */
function feedbackSessionId(request) {
    if (!request.sessionId)
        return undefined;
    return request.category === undefined ||
        request.category === FEEDBACK_ISSUE_CATEGORY.SESSION_ISSUE ||
        request.category === FEEDBACK_ISSUE_CATEGORY.MESSAGE_DISLIKE
        ? request.sessionId
        : undefined;
}
/**
 * 日志时间范围：本地会话最后活跃在 2 天内（或没有活跃时间、不带本地会话）时取最近 2 天；
 * 更早的会话取最后活跃前 2 天到之后 1 天。
 */
export function resolveFeedbackLogWindow(input) {
    const recentSinceMs = input.nowMs - RECENT_LOG_WINDOW_MS;
    const lastActiveAtMs = input.localSessionLastActiveAtMs;
    if (lastActiveAtMs === undefined || lastActiveAtMs >= recentSinceMs) {
        return { sinceMs: recentSinceMs };
    }
    return { sinceMs: lastActiveAtMs - RECENT_LOG_WINDOW_MS, untilMs: lastActiveAtMs + DAY_MS };
}
/** upload_meta 文件名里的时间：YYYY-MM-DD-HH-mm。 */
function formatUploadMetaTime(date) {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
        String(date.getHours()).padStart(2, '0'),
        String(date.getMinutes()).padStart(2, '0'),
    ].join('-');
}
/**
 * 按反馈类型装包，zip 写进 outputDir（先写临时文件再改名）。供反馈日志后台上传队列调用，不上传。
 * - 会话问题 / 消息点踩 + 本地会话：会话报告（分档）+ 公共日志，日志范围按会话最后活跃时间定；
 * - 会话问题 / 消息点踩 + 云端会话：本地没有会话文件，只带公共日志（最近 2 天），upload_meta 记会话 ID；
 * - App 问题 / 意见建议 / 不带会话：公共日志 + 最近会话的日志和 manifest，不带 message_list。
 * 内测版的本地会话反馈（消息点踩除外）另带该会话的工作区快照，排在最后一档。
 */
export async function writeFeedbackDiagnosticArchive(request, outputDir,
/** nowMs：反馈时间。重启后补装包时传建单时间，日志范围仍按反馈当时算；不传用当前时间。 */
options = {}) {
    await flushDiagnosticsForUpload();
    const nowMs = options.nowMs ?? Date.now();
    const sessionId = feedbackSessionId(request);
    const localSessionId = sessionId && request.conversationSource !== 'cloud' ? sessionId : undefined;
    const window = resolveFeedbackLogWindow({
        nowMs,
        ...(localSessionId && request.sessionLastActiveAtMs
            ? { localSessionLastActiveAtMs: request.sessionLastActiveAtMs }
            : {}),
    });
    const report = localSessionId ? await collectSessionReportBestEffort(localSessionId) : undefined;
    const sessionReport = report ? await orderSessionReportArtifacts(report) : undefined;
    const uploadMeta = {
        ...request.metadata,
        session_id: sessionId ?? '',
        session_status: sessionId ? request.metadata.session_status : {},
        message_list: sessionId ? request.metadata.message_list : [],
        ticket_id: request.ticketId,
        ...(request.category ? { category: request.category } : {}),
    };
    await fs.promises.mkdir(outputDir, { recursive: true });
    // 只拍明确属于本机 runtime 的会话：SSH 会话的 ID 不该拿去本机按 ID 找工作区。
    const wantsSnapshot = isInternalBuild &&
        !!localSessionId &&
        request.conversationSource === LOCAL_DESKTOP_RUNTIME_ID &&
        request.category !== FEEDBACK_ISSUE_CATEGORY.MESSAGE_DISLIKE;
    // 日志是反馈的基础：磁盘快满时主动不拍快照。查不到可用空间时照常拍，装包失败还有下面的兜底。
    const freeBytes = wantsSnapshot
        ? await fs.promises.statfs(outputDir).then((stats) => stats.bavail * stats.bsize, () => Number.POSITIVE_INFINITY)
        : Number.POSITIVE_INFINITY;
    const lowDisk = freeBytes < WORKSPACE_SNAPSHOT_MIN_FREE_BYTES;
    // 快照目录跟着 zip 放在队列目录里，装完就删；进程中途退出留下的残留由队列启动时清掉。
    const snapshotDir = wantsSnapshot && !lowDisk
        ? await fs.promises.mkdtemp(path.join(outputDir, '.workspace-snapshot-'))
        : undefined;
    const fromDate = formatArchiveDate(new Date(window.sinceMs));
    const toDate = formatArchiveDate(new Date(window.untilMs ?? nowMs));
    const fileName = `logs_${fromDate}-${toDate}_${nowMs}.zip`;
    const zipPath = path.join(outputDir, fileName);
    const partialPath = `${zipPath}.partial`;
    const writeArchive = async (workspaceSnapshot) => {
        const bundle = await collectUploadDiagnosticBundle({
            logDir: getLogDir(),
            sinceMs: window.sinceMs,
            ...(window.untilMs === undefined ? {} : { untilMs: window.untilMs }),
            extraFiles: [
                {
                    name: `upload_meta_${formatUploadMetaTime(new Date(nowMs))}.json`,
                    content: JSON.stringify(uploadMeta, null, 2),
                },
            ],
            ...(sessionReport ? { sessionReport } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(workspaceSnapshot ? { workspaceSnapshot } : {}),
        });
        try {
            await writeDiagnosticArchive(partialPath, bundle);
            await fs.promises.rename(partialPath, zipPath);
        }
        catch (error) {
            await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
            throw error;
        }
        return bundle;
    };
    try {
        if (lowDisk) {
            logger.info(`[FeedbackLog] Skipping Workspace snapshot: only ${freeBytes} bytes free`);
        }
        const workspaceSnapshot = lowDisk
            ? { skipped: 'workspace_snapshot_skipped_low_disk' }
            : snapshotDir && localSessionId
                ? await collectWorkspaceSnapshotBestEffort(localSessionId, snapshotDir)
                : undefined;
        let bundle;
        try {
            bundle = await writeArchive(workspaceSnapshot);
        }
        catch (error) {
            if (!snapshotDir || !workspaceSnapshot || !('artifacts' in workspaceSnapshot))
                throw error;
            // 带快照装包失败（多半是磁盘写满）：删掉快照腾出空间，马上只装日志，基础文件优先传上去。
            const code = error?.code ?? 'archive_failed';
            logger.warn(`[FeedbackLog] Archive with Workspace snapshot failed (${code}); rebuilding without it`);
            await fs.promises.rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
            bundle = await writeArchive({ skipped: `workspace_snapshot_dropped:${code}` });
        }
        logger.info(`[FeedbackLog] Built ${fileName} for ticket ${request.ticketId} with ${bundle.artifacts.length} diagnostic artifacts`);
        return { zipPath, fileName };
    }
    finally {
        if (snapshotDir) {
            await fs.promises.rm(snapshotDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}
/**
 * 内测版反馈附带的工作区快照：runtime 按加速索引同一套扫描、过滤和打包规则写进 dir，不看索引开关。
 * 不是用户选择的工作区、超出快照上限或失败时只记原因，不影响日志包，也不触发重试。
 */
async function collectWorkspaceSnapshotBestEffort(sessionId, dir) {
    let snapshot;
    try {
        const utility = await import('../modules/local-runtime/utility');
        snapshot = await utility.captureUtilityRuntimeWorkspaceSnapshot(sessionId, dir);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[UploadFeedbackLog] Workspace snapshot failed: ${message}`);
        return { skipped: `workspace_snapshot_failed:${message}`.slice(0, 256) };
    }
    const { status, reason, archivePath, manifestPath } = snapshot;
    if (status !== 'captured') {
        const detail = typeof reason === 'string' ? `${String(status)}:${reason}` : String(status);
        return { skipped: `workspace_snapshot_${detail}`.slice(0, 256) };
    }
    // 路径来自 runtime，只收 dir 里的文件：装完包会整个删掉 dir。
    const inside = (value) => {
        if (typeof value !== 'string')
            return false;
        const relative = path.relative(dir, value);
        return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    };
    if (!inside(archivePath) || !inside(manifestPath)) {
        return { skipped: 'workspace_snapshot_invalid_result' };
    }
    return {
        artifacts: [
            { name: WORKSPACE_SNAPSHOT_MANIFEST_NAME, path: manifestPath },
            { name: WORKSPACE_SNAPSHOT_ARCHIVE_NAME, path: archivePath },
        ],
    };
}
/**
 * 本地 runtime 暂时不可用导致的会话报告失败，文案来自 utility-process-manager / utility-server：
 * 未就绪（含 manager 未创建）、请求超时、发送失败、utility 退出。稍后重试能拿到，不能当成“没有会话报告”。
 */
const TRANSIENT_SESSION_REPORT_ERRORS = new Set([
    'session_report_runtime_unavailable',
    'session_report_request_timeout',
    'session_report_request_failed',
    'session_report_runtime_stopped',
]);
/** 会话报告暂时拿不到；反馈装包遇到它要整体失败，交给队列稍后重试。 */
export class SessionReportTemporarilyUnavailableError extends Error {
    constructor(reason) {
        super(`session report temporarily unavailable: ${reason}`);
        this.name = 'SessionReportTemporarilyUnavailableError';
    }
}

/**
 * 取会话报告；会话不存在、报告格式不对等非暂时性错误时返回 undefined，只带公共日志。
 * runtime 暂时不可用时抛 SessionReportTemporarilyUnavailableError。
 */
export async function collectSessionReportBestEffort(sessionId, collect = collectSessionReport) {
    try {
        return await collect(sessionId);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (TRANSIENT_SESSION_REPORT_ERRORS.has(message)) {
            logger.warn(`[UploadFeedbackLog] Session report temporarily unavailable: ${message}`);
            throw new SessionReportTemporarilyUnavailableError(message);
        }
        logger.warn(`[UploadFeedbackLog] Session report unavailable; uploading base diagnostics: ${message}`);
        return undefined;
    }
}
async function collectSessionReport(sessionId) {
    const utility = await import('../modules/local-runtime/utility');
    const report = await utility.collectUtilityRuntimeSessionReport(sessionId);
    const artifacts = report.artifacts;
    if (!Array.isArray(artifacts))
        throw new Error('session_report_invalid_manifest');
    const sessionIds = Array.isArray(report.sessionIds)
        ? report.sessionIds.filter((id) => typeof id === 'string')
        : [];
    return {
        rootSessionId: typeof report.rootSessionId === 'string' && report.rootSessionId
            ? report.rootSessionId
            : sessionId,
        sessionIds,
        artifacts: artifacts.map((value) => decodeRequiredUploadArtifact(value)),
    };
}
function decodeRequiredUploadArtifact(value) {
    if (!value || typeof value !== 'object')
        throw new Error('session_report_invalid_artifact');
    const name = Reflect.get(value, 'name');
    const path = Reflect.get(value, 'path');
    const content = Reflect.get(value, 'content');
    const bytes = Reflect.get(value, 'bytes');
    const required = Reflect.get(value, 'required');
    if (typeof name !== 'string' ||
        !name ||
        required !== true ||
        (path !== undefined && typeof path !== 'string') ||
        (content !== undefined && typeof content !== 'string') ||
        (path === undefined) === (content === undefined) ||
        typeof bytes !== 'number' ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0) {
        throw new Error('session_report_invalid_artifact');
    }
    return {
        name,
        ...(path === undefined ? {} : { path }),
        ...(content === undefined ? {} : { content }),
        bytes,
    };
}
