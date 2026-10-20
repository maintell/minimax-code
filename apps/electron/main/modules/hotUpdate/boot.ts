/**
 * 启动期渲染资源决策（纯 fs，不依赖 Electron）
 *
 * 在注册 app:// 协议之前调用一次，决定本进程使用的渲染资源根目录：
 * 1. 发布通道、语言、安装包版本或壳指纹变化 → 状态整体重置，回到内置资源；
 * 2. pending 版本完整 → 升级为 active；
 * 3. active 连续 N 次启动未确认首屏可见 → 回滚到 lastKnownGood 或内置资源；
 * 4. 清理不再引用的版本目录与旧版（v1）残留。
 *
 * 根目录在进程生命周期内固定，不做逐文件回退，避免新旧资源混用。
 */

import * as fs from "fs";
import * as path from "path";
import { VERSION_COMPLETE_MARKER } from "./config";
import { parseRendererVersion } from "./manifest";
import { readState, writeState } from "./state";
export let VERSIONS_DIRNAME = 'versions';
export let STAGING_DIRNAME = 'staging';
export let DOWNLOADS_DIRNAME = 'downloads';
/** v1 遗留目录，启动时清理 */
const LEGACY_DIRNAMES = ['resources', 'temp', 'download'];
export function getVersionDir(hotUpdateDir, version) {
    return path.join(hotUpdateDir, VERSIONS_DIRNAME, version);
}
/** 版本目录完整：版本号合法、完成标记存在且包含 index.html */
export function isVersionInstalled(hotUpdateDir, version) {
    if (!version || !parseRendererVersion(version))
        return false;
    const dir = getVersionDir(hotUpdateDir, version);
    return (fs.existsSync(path.join(dir, VERSION_COMPLETE_MARKER)) &&
        fs.existsSync(path.join(dir, 'index.html')));
}
function resetVersions(state) {
    state.latestManifestVersion = null;
    state.active = null;
    state.pending = null;
    state.lastKnownGood = null;
    state.bootAttempts = 0;
    state.resetToBundled = false;
    state.revoked = [];
}
function revoke(state, version) {
    if (!state.revoked.includes(version))
        state.revoked.push(version);
    if (state.lastKnownGood === version)
        state.lastKnownGood = null;
}
function removeQuietly(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    }
    catch {
        // Windows 上目录可能被占用；下次启动再清理。
    }
}
/** 删除未被引用的版本目录、未完成的下载/解压目录和 v1 遗留目录 */
export function cleanupHotUpdateDir(hotUpdateDir, keep) {
    for (const name of [...LEGACY_DIRNAMES, STAGING_DIRNAME, DOWNLOADS_DIRNAME]) {
        removeQuietly(path.join(hotUpdateDir, name));
    }
    const versionsDir = path.join(hotUpdateDir, VERSIONS_DIRNAME);
    let entries;
    try {
        entries = fs.readdirSync(versionsDir);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!keep.has(entry))
            removeQuietly(path.join(versionsDir, entry));
    }
}
export function resolveBootRenderer(input) {
    const bundled = {
        source: 'bundled',
        version: null,
        root: input.bundledRoot,
    };
    const { hotUpdateDir } = input;
    const state = readState(hotUpdateDir);
    let rollbackReason;
    let promotedVersion;
    if (!input.shellFingerprint ||
        !input.channel ||
        state.channel !== input.channel ||
        state.locale !== input.locale ||
        state.appVersion !== input.baseAppVersion ||
        state.shellFingerprint !== input.shellFingerprint) {
        resetVersions(state);
        state.channel = input.channel;
        state.locale = input.locale;
        state.appVersion = input.baseAppVersion;
        state.shellFingerprint = input.shellFingerprint;
        state.lastCheckTime = 0;
        state.lastUpdateTime = 0;
    }
    if (state.resetToBundled) {
        if (state.active)
            rollbackReason = 'reset_to_bundled';
        for (const version of [state.active, state.lastKnownGood]) {
            if (version)
                revoke(state, version);
        }
        state.active = null;
        state.lastKnownGood = null;
        state.bootAttempts = 0;
        state.resetToBundled = false;
    }
    if (state.pending) {
        if (!state.revoked.includes(state.pending) && isVersionInstalled(hotUpdateDir, state.pending)) {
            state.active = state.pending;
            state.bootAttempts = 0;
            promotedVersion = state.pending;
        }
        state.pending = null;
    }
    if (state.active) {
        let fallbackReason;
        if (state.revoked.includes(state.active)) {
            fallbackReason = 'revoked';
        }
        else if (!isVersionInstalled(hotUpdateDir, state.active)) {
            fallbackReason = 'missing_files';
        }
        else if (state.bootAttempts >= input.maxUnconfirmedBoots) {
            fallbackReason = 'unconfirmed_boots';
            revoke(state, state.active);
        }
        if (fallbackReason) {
            rollbackReason = fallbackReason;
            const lastKnownGood = state.lastKnownGood;
            state.active =
                lastKnownGood &&
                    lastKnownGood !== state.active &&
                    !state.revoked.includes(lastKnownGood) &&
                    isVersionInstalled(hotUpdateDir, lastKnownGood)
                    ? lastKnownGood
                    : null;
            state.bootAttempts = 0;
        }
    }
    if (state.active)
        state.bootAttempts += 1;
    const keep = new Set([state.active, state.lastKnownGood].filter((v) => !!v));
    try {
        writeState(hotUpdateDir, state);
        cleanupHotUpdateDir(hotUpdateDir, keep);
    }
    catch {
        // 状态无法持久化时不能保证回滚计数，安全起见使用内置资源。
        return { ...bundled, rollbackReason, promotedVersion };
    }
    if (!state.active || !input.shellFingerprint) {
        return { ...bundled, rollbackReason, promotedVersion };
    }
    return {
        source: 'hot-update',
        version: state.active,
        root: getVersionDir(hotUpdateDir, state.active),
        rollbackReason,
        promotedVersion,
    };
}
/** 本进程首屏可见：把 active 记为 lastKnownGood 并清零启动计数 */
export function confirmBootHealthy(hotUpdateDir, version) {
    const state = readState(hotUpdateDir);
    if (state.active !== version)
        return false;
    state.bootAttempts = 0;
    state.lastKnownGood = version;
    writeState(hotUpdateDir, state);
    return true;
}
