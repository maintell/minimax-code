/**
 * 系统信息 IPC 处理
 * 主题相关、语言设置等
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ipcMain, nativeTheme, shell } from "electron";
import { logger, isLogFile, getLogFilePath, getCategoryLogger, flushLogs, getLogDir } from "../utils";
import { getExtraLogSources, resolveRuntimeLogsDir } from "../utils/extra-log-source";
import { getDesktopAppInstallDir } from "../utils/install-dir";
import { importEsm } from "../utils/import-esm";
import { IPC_CHANNELS } from "../config/constants";
import { uploadToOSS } from "../modules/oss";
import { getUserInfo } from "./storage.ipc";
import { getMainWindow } from "../windows/mainWindow";
import { syncWindowBackgroundColors } from "../windows/utils";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { configureUtilityRuntimeDiagnosticsLogger, utilityRuntimeDiagnostics } from "../modules/local-runtime/utility/utility-runtime-diagnostics";
import { createRequiredUploadArtifact } from "../modules/diagnostics/required-upload-artifact";
import { writeDiagnosticArchive } from "../modules/diagnostics/diagnostic-archive";
import { collectDesktopEnvironment } from "../modules/diagnostics/desktop-environment";
configureUtilityRuntimeDiagnosticsLogger(logger);
const UPLOAD_LOG_MAX_FILES = 256;
const UPLOAD_LOG_MAX_BYTES = 512 * 1024 * 1024;
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
async function collectUploadDiagnosticBundle(input) {
    const runtime = await importEsm('@mavis/local-runtime');
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
            name: 'desktop-environment.json',
            content: JSON.stringify(await collectDesktopEnvironment(), null, 2),
        }));
    }
    catch {
        skippedArtifacts.push({ name: 'desktop-environment.json', reason: 'collection_failed' });
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
    ];
    const bundle = await runtime.collectDiagnosticBundle({
        sources,
        sinceMs: input.sinceMs,
        limits: {
            maxFiles: Math.max(UPLOAD_LOG_MAX_FILES, requiredArtifacts.length),
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
    // ============================================
    // 上传反馈日志（写 JSON 元数据 + 调用 uploadLog）
    // ============================================
    ipcMain.handle(IPC_CHANNELS.SYSTEM_UPLOAD_FEEDBACK_LOG, async (_event, data) => {
        return uploadFeedbackLog(data);
    });
}
/**
 * 上传日志到 OSS
 * 可在主进程中直接调用
 */
export async function uploadLog(extraFiles, sessionId) {
    try {
        logger.info('[UploadLog] Starting log upload...');
        // Snapshot synchronously before the original parallel flush. Both drains
        // stay best-effort and a stuck Utility cannot delay the main log flush.
        utilityRuntimeDiagnostics.writeSnapshot('feedback_upload');
        await Promise.allSettled([flushLogs(), flushRuntimeLogsSafe()]);
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
            sessionId,
        });
        if (bundle.artifacts.length === 0) {
            return { success: false, error: 'No diagnostic artifacts found in the last 2 days' };
        }
        // 按日期排序
        logFiles.sort((a, b) => a.date.getTime() - b.date.getTime());
        // 生成日期范围字符串 (格式: YYYYMMDD)
        const formatDate = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        };
        const fromDate = formatDate(logFiles[0]?.date ?? twoDaysAgo);
        const toDate = formatDate(logFiles[logFiles.length - 1]?.date ?? now);
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
/**
 * Upload feedback log: write a JSON metadata file to the log directory,
 * then call the standard uploadLog() to bundle everything and upload.
 */
async function uploadFeedbackLog(data) {
    try {
        const sessionReport = await collectSessionReportBestEffort(data.session_id);
        const logDir = getLogDir();
        await fs.promises.mkdir(logDir, { recursive: true });
        // Format timestamp for filename: YYYY-MM-DD-HH-mm
        const now = new Date();
        const ts = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0'),
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
        ].join('-');
        const fileName = `upload_meta_${ts}.json`;
        const filePath = path.join(logDir, fileName);
        // Write the feedback metadata JSON
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
        logger.info(`[UploadFeedbackLog] Wrote feedback metadata: ${fileName}`);
        // Now run the standard upload flow, injecting the metadata file
        const result = await uploadLog([{ name: fileName, path: filePath }, ...sessionReport], data.session_id);
        // Clean up the metadata file after upload (success or failure)
        try {
            await fs.promises.unlink(filePath).catch(() => { });
        }
        catch {
            // best-effort cleanup
        }
        return {
            success: result.success,
            uploadId: result.uploadId,
            error: result.error,
        };
    }
    catch (error) {
        logger.error(`[UploadFeedbackLog] Error: ${error}`);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
export async function collectSessionReportBestEffort(sessionId, collect = collectSessionReport) {
    try {
        return await collect(sessionId);
    }
    catch (error) {
        logger.warn(`[UploadFeedbackLog] Session report unavailable; uploading base diagnostics: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
async function collectSessionReport(sessionId) {
    const utility = await import('../modules/local-runtime/utility');
    const report = await utility.collectUtilityRuntimeSessionReport(sessionId);
    const artifacts = report.artifacts;
    if (!Array.isArray(artifacts))
        throw new Error('session_report_invalid_manifest');
    return artifacts.map((value) => decodeRequiredUploadArtifact(value));
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
