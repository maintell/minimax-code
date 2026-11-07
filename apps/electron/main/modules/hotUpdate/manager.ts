/**
 * 热更新管理器
 *
 * 版本格式：{appVersion}-renderer.{n}
 *
 * 工作流程：
 * 1. 启动时（注册 app:// 协议前）resolveBootRenderer 决定本进程的渲染资源根目录：
 *    pending → active、未确认健康的 active 回滚、清理旧版本目录。
 * 2. 首屏可见（first_content_visible）后确认 active 健康，并延迟开始检查更新。
 * 3. 检查：拉取 `{cdnRoot}/{channel}/{appVersion}/manifest.json`，验签并校验通道、语言、
 *    appVersion、壳指纹；下载 → 校验 size/sha256 → 解压到 staging → rename 到 versions/<version>
 *    → 标记 pending，下次启动生效。
 * 4. 整包更新已下载待安装时跳过热更新。
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getIsEn } from "../../utils";
import { getCategoryLogger } from "../../utils/logger";
import { hasUpdateReady } from "../updater/state";
import { enqueueElectronObservabilityEvent } from "../observability/outbox";
import { HOT_UPDATE_CHANNEL, HOT_UPDATE_SIGNING_PUBLIC_KEYS, HOT_UPDATE_LOCALE, MAX_UNCONFIRMED_BOOTS, FIRST_CHECK_DELAY_AFTER_VISIBLE_MS, CHECK_INTERVAL, HOT_UPDATE_CDN_ROOT, MANIFEST_FILENAME, VERSION_COMPLETE_MARKER, FIRST_CHECK_FALLBACK_DELAY_MS } from "./config";
import { resolveBootRenderer, isVersionInstalled, confirmBootHealthy, DOWNLOADS_DIRNAME, STAGING_DIRNAME, getVersionDir } from "./boot";
import { validateManifest, compareRendererVersions } from "./manifest";
import { readState, updateState } from "./state";
import { readShellFingerprint, getHotUpdateDir, getBaseAppVersion, getAppVersion, fetchText, downloadFile } from "./utils";
const logger = getCategoryLogger('update');
function track(stage, payload) {
    try {
        enqueueElectronObservabilityEvent(`hot_update.${stage}`, { domain: 'hot_update', channel: HOT_UPDATE_CHANNEL ?? 'none', ...payload }, payload.result === 'error' ? 'error' : 'action');
    }
    catch {
        // 埋点失败不影响热更新流程
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export class HotUpdateManager {
    constructor() {
        this.statusCallbacks = new Set();
        this.isChecking = false;
        this.isDownloading = false;
        this.checkTimer = null;
        this.firstCheckTimer = null;
        this.autoCheckStarted = false;
        this.firstContentVisible = false;
        this.bootRenderer = null;
    }
    static getInstance() {
        if (!HotUpdateManager.instance) {
            HotUpdateManager.instance = new HotUpdateManager();
        }
        return HotUpdateManager.instance;
    }
    onStatus(callback) {
        this.statusCallbacks.add(callback);
        return () => this.statusCallbacks.delete(callback);
    }
    emitStatus(status) {
        logger.info(`[HotUpdate] Status: ${JSON.stringify(status)}`);
        this.statusCallbacks.forEach((cb) => {
            try {
                cb(status);
            }
            catch (error) {
                logger.error(`[HotUpdate] Status callback error: ${error}`);
            }
        });
    }
    getShellFingerprint() {
        if (this.shellFingerprint === undefined) {
            this.shellFingerprint = readShellFingerprint();
        }
        return this.shellFingerprint;
    }
    /** 该构建是否具备热更新能力（通道、签名公钥、壳指纹齐全） */
    isSupported() {
        return (HOT_UPDATE_CHANNEL !== null &&
            HOT_UPDATE_SIGNING_PUBLIC_KEYS.length > 0 &&
            this.getShellFingerprint() !== null);
    }
    /** 热更新是否启用（具备能力且未被关闭） */
    isEnabled() {
        return this.isSupported() && readState(getHotUpdateDir()).enabled;
    }
    setEnabled(enabled) {
        updateState(getHotUpdateDir(), (state) => {
            state.enabled = enabled;
        });
    }
    /**
     * 决定本进程的渲染资源根目录。只在第一次调用时读写磁盘，之后返回同一结果。
     * 必须在注册 app:// 协议前调用。
     */
    getBootRenderer() {
        if (this.bootRenderer)
            return this.bootRenderer;
        const bundledRoot = path.join(app.getAppPath(), 'out');
        let boot = { source: 'bundled', version: null, root: bundledRoot };
        if (this.isEnabled()) {
            try {
                boot = resolveBootRenderer({
                    hotUpdateDir: getHotUpdateDir(),
                    bundledRoot,
                    channel: HOT_UPDATE_CHANNEL,
                    locale: HOT_UPDATE_LOCALE,
                    baseAppVersion: getBaseAppVersion(),
                    shellFingerprint: this.getShellFingerprint(),
                    maxUnconfirmedBoots: MAX_UNCONFIRMED_BOOTS,
                });
            }
            catch (error) {
                logger.error(`[HotUpdate] Boot resolution failed, using bundled: ${errorMessage(error)}`);
            }
        }
        this.bootRenderer = boot;
        logger.info(`[HotUpdate] Boot renderer: source=${boot.source} version=${boot.version ?? 'bundled'} ` +
            `app=${getAppVersion()} channel=${HOT_UPDATE_CHANNEL ?? 'none'} root=${boot.root}`);
        if (boot.rollbackReason) {
            logger.warn(`[HotUpdate] Rolled back at boot: ${boot.rollbackReason}`);
            track('rollback', { reason: boot.rollbackReason, version: boot.version ?? 'bundled' });
        }
        if (boot.source === 'hot-update' || boot.promotedVersion) {
            track('boot', {
                version: boot.version ?? 'bundled',
                promoted: boot.promotedVersion !== undefined,
            });
        }
        return boot;
    }
    /** 当前进程实际使用的热更新版本；null 表示安装包内置资源 */
    getCurrentVersion() {
        return this.getBootRenderer().version;
    }
    isHotUpdateInstalled() {
        return this.getBootRenderer().source === 'hot-update';
    }
    getIsDownloading() {
        return this.isDownloading;
    }
    getPendingVersion() {
        const pending = readState(getHotUpdateDir()).pending;
        return pending && isVersionInstalled(getHotUpdateDir(), pending) ? pending : null;
    }
    hasPendingRestart() {
        return this.getPendingVersion() !== null;
    }
    /**
     * 渲染进程首屏可见：确认当前热更新版本健康，并安排首次检查。
     */
    handleFirstContentVisible() {
        if (this.firstContentVisible)
            return;
        this.firstContentVisible = true;
        const boot = this.getBootRenderer();
        if (boot.source === 'hot-update' && boot.version) {
            try {
                if (confirmBootHealthy(getHotUpdateDir(), boot.version)) {
                    logger.info(`[HotUpdate] Confirmed healthy: ${boot.version}`);
                    track('confirm', { version: boot.version });
                }
            }
            catch (error) {
                logger.error(`[HotUpdate] Confirm healthy failed: ${errorMessage(error)}`);
            }
        }
        if (this.autoCheckStarted)
            this.scheduleFirstCheck(FIRST_CHECK_DELAY_AFTER_VISIBLE_MS);
    }
    async checkForUpdate(force = false) {
        const isEn = getIsEn();
        const currentVersion = this.getCurrentVersion();
        if (!this.isEnabled()) {
            return {
                success: false,
                error: isEn ? 'Hot update is disabled' : '热更新已禁用',
                currentVersion,
            };
        }
        if (this.isDownloading) {
            return { success: true, hasUpdate: true, isDownloading: true, currentVersion };
        }
        if (this.isChecking) {
            return {
                success: false,
                error: isEn ? 'Already checking for update' : '正在检查更新',
                currentVersion,
            };
        }
        if (hasUpdateReady()) {
            return {
                success: true,
                hasUpdate: false,
                currentVersion,
                skipped: true,
                skipReason: isEn ? 'A full app update is ready to install' : '整包更新已下载，待安装',
            };
        }
        const hotUpdateDir = getHotUpdateDir();
        if (!force && Date.now() - readState(hotUpdateDir).lastCheckTime < CHECK_INTERVAL) {
            return {
                success: true,
                hasUpdate: false,
                currentVersion,
                skipped: true,
                skipReason: isEn ? 'recent hot update has been checked' : '最近已检查过，非强制模式',
            };
        }
        this.isChecking = true;
        this.emitStatus({ type: 'checking' });
        try {
            const baseAppVersion = getBaseAppVersion();
            const manifestUrl = `${HOT_UPDATE_CDN_ROOT}/${HOT_UPDATE_CHANNEL}/${baseAppVersion}/${MANIFEST_FILENAME}`;
            logger.info(`[HotUpdate] Fetching manifest: ${manifestUrl}`);
            const raw = await fetchText(manifestUrl);
            updateState(hotUpdateDir, (state) => {
                state.lastCheckTime = Date.now();
            });
            const pendingVersion = this.getPendingVersion();
            if (raw === null) {
                this.emitStatus({ type: 'not-available', currentVersion });
                return this.upToDateResult(currentVersion, pendingVersion, isEn);
            }
            const validation = validateManifest(raw, {
                channel: HOT_UPDATE_CHANNEL,
                locale: HOT_UPDATE_LOCALE,
                baseAppVersion,
                shellFingerprint: this.getShellFingerprint(),
                publicKeys: HOT_UPDATE_SIGNING_PUBLIC_KEYS,
            });
            if (!validation.ok) {
                logger.warn(`[HotUpdate] Manifest rejected: ${validation.reason}`);
                track('check', { result: 'rejected', reason: validation.reason });
                this.emitStatus({ type: 'not-available', currentVersion });
                return {
                    success: true,
                    hasUpdate: false,
                    currentVersion,
                    skipped: true,
                    skipReason: isEn
                        ? `Manifest rejected: ${validation.reason}`
                        : `清单不适用于当前安装包：${validation.reason}`,
                };
            }
            const manifest = validation.manifest;
            const state = readState(hotUpdateDir);
            const newest = compareRendererVersions(pendingVersion, currentVersion) > 0
                ? pendingVersion
                : currentVersion;
            // 更新与回滚共用持久化水位；即使已回到内置资源，也不能重放旧的有效签名清单。
            if (state.revoked.includes(manifest.version) ||
                compareRendererVersions(manifest.version, state.latestManifestVersion) <= 0 ||
                compareRendererVersions(manifest.version, newest) <= 0) {
                track('check', { result: 'up_to_date', version: manifest.version });
                this.emitStatus({ type: 'not-available', currentVersion });
                return this.upToDateResult(currentVersion, pendingVersion, isEn);
            }
            if (manifest.rollback) {
                return this.applyRollbackManifest(manifest, currentVersion, isEn);
            }
            logger.info(`[HotUpdate] Update available: ${newest ?? 'bundled'} -> ${manifest.version}`);
            track('check', { result: 'available', version: manifest.version });
            this.emitStatus({ type: 'available', manifest });
            this.isChecking = false;
            const installed = await this.downloadAndInstall(manifest);
            return installed
                ? {
                    success: true,
                    hasUpdate: true,
                    pendingRestart: true,
                    isUpToDate: false,
                    currentVersion,
                    manifest,
                }
                : { success: false, error: isEn ? 'Install failed' : '安装失败', currentVersion };
        }
        catch (error) {
            const message = errorMessage(error);
            logger.error(`[HotUpdate] Check failed: ${message}`);
            track('check', { result: 'error', reason: message.slice(0, 200) });
            this.emitStatus({ type: 'error', error: message });
            return { success: false, error: message, currentVersion };
        }
        finally {
            this.isChecking = false;
        }
    }
    upToDateResult(currentVersion, pendingVersion, isEn) {
        if (pendingVersion) {
            return { success: true, hasUpdate: true, pendingRestart: true, currentVersion };
        }
        if (currentVersion && readState(getHotUpdateDir()).resetToBundled) {
            return {
                success: true,
                hasUpdate: false,
                pendingRestart: true,
                currentVersion,
                skipReason: isEn ? 'Restart to use bundled resources' : '重启后使用内置资源',
            };
        }
        return {
            success: true,
            hasUpdate: false,
            isUpToDate: true,
            skipReason: isEn
                ? `Already up to date: ${currentVersion ?? 'bundled'}`
                : `已是最新版本: ${currentVersion ?? '内置版本'}`,
            currentVersion,
        };
    }
    applyRollbackManifest(manifest, currentVersion, isEn) {
        const state = readState(getHotUpdateDir());
        const needsReset = state.active !== null || state.pending !== null;
        updateState(getHotUpdateDir(), (next) => {
            next.latestManifestVersion = manifest.version;
            if (needsReset) {
                next.pending = null;
                next.resetToBundled = true;
            }
        });
        if (needsReset && !state.resetToBundled) {
            logger.warn(`[HotUpdate] Rollback manifest received (${manifest.version})`);
            track('rollback', { reason: 'manifest', version: currentVersion ?? 'bundled' });
        }
        this.emitStatus({ type: 'not-available', currentVersion });
        return {
            success: true,
            hasUpdate: false,
            pendingRestart: currentVersion !== null,
            currentVersion,
            skipReason: isEn ? 'Hot update rolled back by publisher' : '热更新已被发布方回滚',
        };
    }
    /**
     * 下载并安装到 versions/<version>，标记为 pending（下次启动生效）。
     * 不触碰当前进程正在使用的版本目录。
     */
    async downloadAndInstall(manifest) {
        if (this.isDownloading)
            return false;
        this.isDownloading = true;
        const hotUpdateDir = getHotUpdateDir();
        const suffix = `${manifest.version}-${crypto.randomBytes(4).toString('hex')}`;
        const downloadPath = path.join(hotUpdateDir, DOWNLOADS_DIRNAME, `${suffix}.zip`);
        const stagingDir = path.join(hotUpdateDir, STAGING_DIRNAME, suffix);
        const targetDir = getVersionDir(hotUpdateDir, manifest.version);
        const startedAt = Date.now();
        try {
            logger.info(`[HotUpdate] Downloading ${manifest.url}`);
            await downloadFile(manifest.url, downloadPath, {
                expectedSha256: manifest.sha256,
                expectedSize: manifest.size,
                onProgress: (downloaded, total) => {
                    this.emitStatus({ type: 'downloading', progress: downloaded, total });
                },
            });
            track('download', {
                result: 'success',
                version: manifest.version,
                duration_ms: Date.now() - startedAt,
            });
            this.emitStatus({ type: 'downloaded', version: manifest.version });
            this.emitStatus({ type: 'applying' });
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const extractZip = require('extract-zip');
            await extractZip(downloadPath, { dir: stagingDir });
            let sourceDir = stagingDir;
            const entries = fs.readdirSync(stagingDir);
            if (entries.length === 1 && fs.statSync(path.join(stagingDir, entries[0])).isDirectory()) {
                sourceDir = path.join(stagingDir, entries[0]);
            }
            if (!fs.existsSync(path.join(sourceDir, 'index.html'))) {
                throw new Error('Package does not contain index.html');
            }
            fs.writeFileSync(path.join(sourceDir, VERSION_COMPLETE_MARKER), JSON.stringify({
                version: manifest.version,
                sha256: manifest.sha256,
                installedAt: Date.now(),
            }));
            // targetDir 只可能是之前中断留下的残骸：manifest.version 严格大于 active/pending。
            fs.rmSync(targetDir, { recursive: true, force: true });
            fs.mkdirSync(path.dirname(targetDir), { recursive: true });
            fs.renameSync(sourceDir, targetDir);
            updateState(hotUpdateDir, (state) => {
                state.latestManifestVersion = manifest.version;
                state.pending = manifest.version;
                state.resetToBundled = false;
                state.lastUpdateTime = Date.now();
            });
            logger.info(`[HotUpdate] Installed ${manifest.version}, active on next launch`);
            track('install', { result: 'success', version: manifest.version });
            this.emitStatus({ type: 'applied', version: manifest.version });
            return true;
        }
        catch (error) {
            const message = errorMessage(error);
            logger.error(`[HotUpdate] Download/install failed: ${message}`);
            track('install', {
                result: 'error',
                version: manifest.version,
                reason: message.slice(0, 200),
            });
            this.emitStatus({ type: 'error', error: message });
            return false;
        }
        finally {
            for (const target of [downloadPath, path.join(hotUpdateDir, STAGING_DIRNAME, suffix)]) {
                try {
                    fs.rmSync(target, { recursive: true, force: true });
                }
                catch {
                    // 下次启动清理
                }
            }
            this.isDownloading = false;
        }
    }
    /** 清除热更新：下次启动回到安装包内置资源 */
    async clearCache() {
        try {
            updateState(getHotUpdateDir(), (state) => {
                state.pending = null;
                state.resetToBundled = true;
            });
            logger.info('[HotUpdate] Cache cleared, bundled renderer on next launch');
            return true;
        }
        catch (error) {
            logger.error(`[HotUpdate] Clear cache failed: ${errorMessage(error)}`);
            return false;
        }
    }
    scheduleFirstCheck(delayMs) {
        if (this.firstCheckTimer)
            clearTimeout(this.firstCheckTimer);
        this.firstCheckTimer = setTimeout(() => {
            this.firstCheckTimer = null;
            void this.checkForUpdate(true);
            if (!this.checkTimer) {
                this.checkTimer = setInterval(() => void this.checkForUpdate(), CHECK_INTERVAL);
                this.checkTimer.unref?.();
            }
        }, delayMs);
        this.firstCheckTimer.unref?.();
    }
    /** 启动自动检查：首屏可见后延迟检查；首屏迟迟不可见时兜底检查 */
    startAutoCheck() {
        if (this.autoCheckStarted)
            return;
        if (!this.isEnabled()) {
            logger.info(`[HotUpdate] Auto check not started (channel=${HOT_UPDATE_CHANNEL ?? 'none'}, ` +
                `shell=${this.getShellFingerprint() ? 'present' : 'missing'})`);
            return;
        }
        this.autoCheckStarted = true;
        this.scheduleFirstCheck(this.firstContentVisible ? FIRST_CHECK_DELAY_AFTER_VISIBLE_MS : FIRST_CHECK_FALLBACK_DELAY_MS);
        logger.info('[HotUpdate] Auto check started');
    }
    stopAutoCheck() {
        this.autoCheckStarted = false;
        if (this.firstCheckTimer) {
            clearTimeout(this.firstCheckTimer);
            this.firstCheckTimer = null;
        }
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = null;
        }
    }
    getStatus() {
        const state = readState(getHotUpdateDir());
        return {
            enabled: this.isEnabled(),
            channel: HOT_UPDATE_CHANNEL,
            currentVersion: this.getCurrentVersion(),
            pendingVersion: this.getPendingVersion(),
            lastKnownGoodVersion: state.lastKnownGood,
            appVersion: getAppVersion(),
            isHotUpdateInstalled: this.isHotUpdateInstalled(),
            lastCheckTime: state.lastCheckTime,
            lastUpdateTime: state.lastUpdateTime,
        };
    }
}

HotUpdateManager.instance = null;
