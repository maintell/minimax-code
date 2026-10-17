/**
 * 热更新管理器
 *
 * 版本格式：{appVersion}-renderer.{n}
 * 例如：3.0.3-renderer.1, 3.0.3-renderer.2
 *
 * 工作流程：
 * 1. 构建 App 时使用默认的 out/ 资源（没有热更新版本）
 * 2. 发布热更新时，生成 manifest.json 和 zip 包上传到 CDN
 * 3. 用户打开 App → 检测到热更新 → 下载 → 应用
 * 4. 如需回退，清除缓存即可使用打包时的版本
 */

import * as path from "path";
import * as fs from "fs";
import { getIsEn, compareVersions } from "../../utils";
import { getCategoryLogger } from "../../utils/logger";
const logger = getCategoryLogger('update');
import { HOT_UPDATE_BASE_URL, CHECK_INTERVAL, MANIFEST_FILENAME, DEFAULT_MIN_APP_VERSION } from "./config";
import { getHotUpdateResourceDir, fetchText, getBaseAppVersion, compareRendererVersions, getHotUpdateDir, downloadFile, ensureDir, getAppVersion, parseRendererVersion } from "./utils";
import { readState, saveState } from "./state";
/**
 * 热更新管理器类
 */
export class HotUpdateManager {
    constructor() {
        this.statusCallbacks = new Set();
        this.isChecking = false;
        this.isDownloading = false;
        this.checkTimer = null;
        /** 本次会话中是否有新版本被应用（需要重启/刷新才能生效） */
        this.pendingRestart = false;
        /** 本次会话应用的新版本号 */
        this.appliedVersion = null;
        // Private constructor for singleton
    }
    static getInstance() {
        if (!HotUpdateManager.instance) {
            HotUpdateManager.instance = new HotUpdateManager();
        }
        return HotUpdateManager.instance;
    }
    /**
     * 注册状态回调
     */
    onStatus(callback) {
        this.statusCallbacks.add(callback);
        return () => this.statusCallbacks.delete(callback);
    }
    /**
     * 发送状态通知
     */
    emitStatus(status) {
        logger.info(`[HotUpdate] Status: ${status.type} ${JSON.stringify(status)}`);
        this.statusCallbacks.forEach((cb) => {
            try {
                cb(status);
            }
            catch (error) {
                logger.error(`[HotUpdate] Status callback error: ${error}`);
            }
        });
    }
    /**
     * 获取当前热更新版本
     * 返回 null 表示使用打包版本
     */
    getCurrentVersion() {
        const state = readState();
        if (state.currentVersion && this.isHotUpdateInstalled()) {
            return state.currentVersion;
        }
        return null;
    }
    /**
     * 检查是否已安装热更新
     */
    isHotUpdateInstalled() {
        const resourceDir = getHotUpdateResourceDir();
        const indexPath = path.join(resourceDir, 'index.html');
        return fs.existsSync(indexPath);
    }
    /**
     * 检查热更新是否启用
     */
    isEnabled() {
        // 开发环境不启用热更新
        if (!HOT_UPDATE_BASE_URL) {
            return false;
        }
        const state = readState();
        return state.enabled;
    }
    /**
     * 设置热更新启用状态
     */
    setEnabled(enabled) {
        saveState({ enabled });
    }
    /**
     * 检查是否正在下载中
     */
    getIsDownloading() {
        return this.isDownloading;
    }
    /**
     * 检查是否有待重启的更新
     */
    hasPendingRestart() {
        return this.pendingRestart;
    }
    /**
     * 获取已应用但待重启的版本号
     */
    getAppliedVersion() {
        return this.appliedVersion;
    }
    /**
     * 检查更新
     * @returns 检查结果，包含是否有更新、是否已是最新版本等信息
     */
    async checkForUpdate(force = false) {
        const isEn = getIsEn();
        const currentVersion = this.getCurrentVersion();
        if (!this.isEnabled()) {
            logger.info('[HotUpdate] Hot update is disabled');
            return {
                success: false,
                error: isEn ? 'Hot update is disabled' : '热更新已禁用',
                currentVersion,
            };
        }
        // 如果正在下载中，返回下载状态
        if (this.isDownloading) {
            logger.info('[HotUpdate] Update is downloading');
            return {
                success: true,
                hasUpdate: true,
                isDownloading: true,
                currentVersion,
            };
        }
        // 如果有待重启的更新，直接返回（不需要再检查）
        if (this.pendingRestart && this.appliedVersion) {
            logger.info(`[HotUpdate] Pending restart for version: ${this.appliedVersion}`);
            return {
                success: true,
                hasUpdate: true,
                pendingRestart: true,
                currentVersion,
                manifest: { version: this.appliedVersion },
            };
        }
        if (this.isChecking) {
            logger.info('[HotUpdate] Already checking for update');
            return {
                success: false,
                error: isEn ? 'Already checking for update' : '正在检查更新',
                currentVersion,
            };
        }
        // 检查是否需要检查（非强制模式下，检查间隔）
        if (!force) {
            const state = readState();
            const now = Date.now();
            if (now - state.lastCheckTime < CHECK_INTERVAL) {
                logger.info('[HotUpdate] Skip check, last check was recent');
                return {
                    success: true,
                    hasUpdate: false,
                    currentVersion,
                    skipped: true,
                    skipReason: isEn ? 'recent hot update has been checked' : '最近已检查过，非强制模式',
                };
            }
        }
        this.isChecking = true;
        this.emitStatus({ type: 'checking' });
        try {
            const manifestUrl = `${HOT_UPDATE_BASE_URL}/${MANIFEST_FILENAME}`;
            logger.info(`[HotUpdate] Fetching manifest from: ${manifestUrl}`);
            const manifestContent = await fetchText(manifestUrl);
            const manifest = JSON.parse(manifestContent);
            saveState({ lastCheckTime: Date.now() });
            // 检查热更新是否基于当前应用版本（只比较基础版本号，忽略 -test.xx 等后缀）
            const baseAppVersion = getBaseAppVersion();
            if (manifest.appVersion !== baseAppVersion) {
                logger.info(`[HotUpdate] Manifest appVersion ${manifest.appVersion} ` +
                    `does not match current app base version ${baseAppVersion}`);
                this.emitStatus({
                    type: 'not-available',
                    currentVersion,
                });
                return {
                    success: true,
                    hasUpdate: false,
                    currentVersion,
                    skipped: true,
                    skipReason: isEn
                        ? 'Manifest appVersion does not match current app base version'
                        : '清单应用版本与当前应用基础版本不匹配',
                };
            }
            // 检查最低客户端版本要求（默认 3.0.6，从该版本开始支持热更新）
            const minAppVersion = manifest.minAppVersion || DEFAULT_MIN_APP_VERSION;
            if (compareVersions(baseAppVersion, minAppVersion) < 0) {
                logger.info(`[HotUpdate] App version ${baseAppVersion} is below min required ${minAppVersion}`);
                this.emitStatus({
                    type: 'not-available',
                    currentVersion,
                });
                return {
                    success: true,
                    hasUpdate: false,
                    currentVersion,
                    skipped: true,
                    skipReason: isEn
                        ? 'App version is below min required version'
                        : '应用版本低于最低支持版本',
                };
            }
            // 比较版本
            if (compareRendererVersions(manifest.version, currentVersion) > 0) {
                logger.info(`[HotUpdate] Update available: ${currentVersion} -> ${manifest.version}`);
                this.emitStatus({ type: 'available', manifest });
                // 自动下载并应用更新
                this.isChecking = false; // 先释放检查锁，允许下载
                await this.downloadAndApply(manifest);
                return {
                    success: true,
                    hasUpdate: true,
                    isUpToDate: false,
                    currentVersion,
                    manifest,
                };
            }
            else {
                logger.info(`[HotUpdate] Already up to date: ${currentVersion}`);
                this.emitStatus({ type: 'not-available', currentVersion });
                return {
                    success: true,
                    hasUpdate: false,
                    isUpToDate: true,
                    skipReason: isEn
                        ? `Already up to date: ${currentVersion}`
                        : `已是最新版本: ${currentVersion}`,
                    currentVersion,
                };
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[HotUpdate] Check failed: ${errorMessage}`);
            this.emitStatus({ type: 'error', error: errorMessage });
            return {
                success: false,
                error: errorMessage,
                currentVersion,
            };
        }
        finally {
            this.isChecking = false;
        }
    }
    /**
     * 下载并安装更新
     */
    async downloadAndApply(manifest) {
        if (this.isDownloading) {
            logger.info('[HotUpdate] Already downloading');
            return false;
        }
        this.isDownloading = true;
        try {
            const hotUpdateDir = getHotUpdateDir();
            const downloadPath = path.join(hotUpdateDir, 'download', `${manifest.version}.zip`);
            const tempExtractDir = path.join(hotUpdateDir, 'temp');
            const resourceDir = getHotUpdateResourceDir();
            // 清理临时目录和可能存在的不完整下载文件
            if (fs.existsSync(tempExtractDir)) {
                fs.rmSync(tempExtractDir, { recursive: true });
            }
            if (fs.existsSync(downloadPath)) {
                fs.unlinkSync(downloadPath);
            }
            // 下载更新包（带 SHA256 校验）
            logger.info(`[HotUpdate] Downloading update from: ${manifest.url}`);
            await downloadFile(manifest.url, downloadPath, {
                expectedSha256: manifest.sha256,
                onProgress: (downloaded, total) => {
                    this.emitStatus({ type: 'downloading', progress: downloaded, total });
                },
            });
            this.emitStatus({ type: 'downloaded', version: manifest.version });
            // 解压更新包
            logger.info('[HotUpdate] Extracting update...');
            this.emitStatus({ type: 'applying' });
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const extractZip = require('extract-zip');
            await extractZip(downloadPath, { dir: tempExtractDir });
            // 删除旧版本（如果存在）
            if (fs.existsSync(resourceDir)) {
                fs.rmSync(resourceDir, { recursive: true });
            }
            // 移动新版本到资源目录
            ensureDir(path.dirname(resourceDir));
            // 检查解压后的目录结构（可能有一层子目录）
            const extractedItems = fs.readdirSync(tempExtractDir);
            let sourceDir = tempExtractDir;
            if (extractedItems.length === 1) {
                const singleItem = path.join(tempExtractDir, extractedItems[0]);
                if (fs.statSync(singleItem).isDirectory()) {
                    sourceDir = singleItem;
                }
            }
            fs.renameSync(sourceDir, resourceDir);
            // 清理下载文件和临时目录
            fs.unlinkSync(downloadPath);
            if (fs.existsSync(tempExtractDir) && tempExtractDir !== sourceDir) {
                fs.rmSync(tempExtractDir, { recursive: true });
            }
            // 更新状态
            saveState({
                currentVersion: manifest.version,
                lastUpdateTime: Date.now(),
            });
            // 标记需要重启
            this.pendingRestart = true;
            this.appliedVersion = manifest.version;
            logger.info(`[HotUpdate] Update applied successfully: ${manifest.version}`);
            this.emitStatus({ type: 'applied', version: manifest.version });
            return true;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[HotUpdate] Download/apply failed: ${errorMessage}`);
            this.emitStatus({ type: 'error', error: errorMessage });
            return false;
        }
        finally {
            this.isDownloading = false;
        }
    }
    /**
     * 清除热更新缓存，回退到打包时的版本
     */
    async clearCache() {
        try {
            const resourceDir = getHotUpdateResourceDir();
            if (fs.existsSync(resourceDir)) {
                fs.rmSync(resourceDir, { recursive: true });
            }
            saveState({ currentVersion: null });
            logger.info('[HotUpdate] Cache cleared, will use bundled version');
            return true;
        }
        catch (error) {
            logger.error(`[HotUpdate] Clear cache failed: ${error}`);
            return false;
        }
    }
    /**
     * 启动定时检查
     */
    startAutoCheck() {
        if (this.checkTimer) {
            return;
        }
        // 打印当前热更新状态
        const currentVersion = this.getCurrentVersion();
        const appVersion = getAppVersion();
        const baseAppVersion = getBaseAppVersion();
        const isInstalled = this.isHotUpdateInstalled();
        logger.info(`[HotUpdate] Initializing - App version: ${appVersion}, Base version: ${baseAppVersion}, ` +
            `Hot update version: ${currentVersion || 'none'}, Installed: ${isInstalled}`);
        // 清理过期的热更新缓存（App 版本升级后，旧的热更新不再适用）
        this.cleanupOutdatedCache();
        // 清理可能存在的不完整下载文件
        this.cleanupIncompleteDownloads();
        // 启动时强制检查一次（忽略上次检查时间）
        this.checkForUpdate(true);
        // 定时检查
        this.checkTimer = setInterval(() => {
            this.checkForUpdate();
        }, CHECK_INTERVAL);
        logger.info('[HotUpdate] Auto check started');
    }
    /**
     * 清理不完整的下载文件
     *
     * 判断依据：正常流程中，下载完成后会立即解压并删除 zip 文件。
     * 如果 download/ 目录中存在 .zip 文件，说明下载或解压过程中断了。
     */
    cleanupIncompleteDownloads() {
        try {
            const hotUpdateDir = getHotUpdateDir();
            const downloadDir = path.join(hotUpdateDir, 'download');
            const tempDir = path.join(hotUpdateDir, 'temp');
            // 清理 download/ 目录中的 zip 文件（不完整的下载）
            if (fs.existsSync(downloadDir)) {
                const files = fs.readdirSync(downloadDir);
                for (const file of files) {
                    if (file.endsWith('.zip')) {
                        const filePath = path.join(downloadDir, file);
                        logger.info(`[HotUpdate] Cleaning incomplete download: ${file}`);
                        fs.unlinkSync(filePath);
                    }
                }
            }
            // 清理 temp/ 目录（解压过程中断的残留）
            if (fs.existsSync(tempDir)) {
                logger.info('[HotUpdate] Cleaning incomplete extraction');
                fs.rmSync(tempDir, { recursive: true });
            }
        }
        catch (error) {
            logger.error(`[HotUpdate] Failed to cleanup incomplete downloads: ${error}`);
        }
    }
    /**
     * 清理过期的热更新缓存
     * 当 App 版本升级后，旧版本的热更新缓存不再适用，应该清理
     */
    cleanupOutdatedCache() {
        const state = readState();
        if (!state.currentVersion) {
            return; // 没有热更新缓存
        }
        // 解析缓存的热更新版本
        const parsed = parseRendererVersion(state.currentVersion);
        if (!parsed) {
            return;
        }
        // 比较热更新的 appVersion 与当前 App 的基础版本
        const baseAppVersion = getBaseAppVersion();
        if (parsed.appVersion !== baseAppVersion) {
            logger.info(`[HotUpdate] Cleaning outdated cache: ${state.currentVersion} ` +
                `(for app ${parsed.appVersion}, current app is ${baseAppVersion})`);
            this.clearCache();
        }
    }
    /**
     * 停止定时检查
     */
    stopAutoCheck() {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
            logger.info('[HotUpdate] Auto check stopped');
        }
    }
    /**
     * 获取热更新状态信息
     */
    getStatus() {
        const state = readState();
        return {
            enabled: this.isEnabled(),
            currentVersion: this.getCurrentVersion(),
            appVersion: getAppVersion(),
            isHotUpdateInstalled: this.isHotUpdateInstalled(),
            lastCheckTime: state.lastCheckTime,
            lastUpdateTime: state.lastUpdateTime,
        };
    }
}

HotUpdateManager.instance = null;
