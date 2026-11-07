/**
 * 热更新本地状态读写（纯 fs，不依赖 Electron）
 */

import * as fs from "fs";
import * as path from "path";
import { STATE_FILENAME } from "./config";
import { parseRendererVersion, compareRendererVersions } from "./manifest";
export function createDefaultState() {
    return {
        schemaVersion: 2,
        enabled: true,
        channel: null,
        locale: null,
        appVersion: null,
        shellFingerprint: null,
        latestManifestVersion: null,
        active: null,
        pending: null,
        lastKnownGood: null,
        bootAttempts: 0,
        resetToBundled: false,
        revoked: [],
        lastCheckTime: 0,
        lastUpdateTime: 0,
    };
}
function stringOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
/**
 * 读取状态。文件缺失、损坏或为旧格式（v1：currentVersion + resources/）时返回默认状态，
 * 仅保留旧格式中的 enabled 开关。
 */
export function readState(hotUpdateDir) {
    const state = createDefaultState();
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(path.join(hotUpdateDir, STATE_FILENAME), 'utf8'));
    }
    catch {
        return state;
    }
    if (!raw || typeof raw !== 'object')
        return state;
    const record = raw;
    if (typeof record.enabled === 'boolean')
        state.enabled = record.enabled;
    if (record.schemaVersion !== 2)
        return state;
    state.channel = stringOrNull(record.channel);
    state.locale = stringOrNull(record.locale);
    state.appVersion = stringOrNull(record.appVersion);
    state.shellFingerprint = stringOrNull(record.shellFingerprint);
    state.active = stringOrNull(record.active);
    state.pending = stringOrNull(record.pending);
    state.lastKnownGood = stringOrNull(record.lastKnownGood);
    state.bootAttempts = finiteNumber(record.bootAttempts);
    state.resetToBundled = record.resetToBundled === true;
    const revoked = Array.isArray(record.revoked)
        ? record.revoked.filter((item) => typeof item === 'string')
        : [];
    state.revoked = revoked.slice(-50);
    state.lastCheckTime = finiteNumber(record.lastCheckTime);
    state.lastUpdateTime = finiteNumber(record.lastUpdateTime);
    // 兼容缺少水位字段的 v2 状态，并保证水位不低于仍有记录的已接受版本。
    for (const version of [
        stringOrNull(record.latestManifestVersion),
        state.active,
        state.pending,
        state.lastKnownGood,
        ...revoked,
    ]) {
        if (version &&
            parseRendererVersion(version)?.appVersion === state.appVersion &&
            compareRendererVersions(version, state.latestManifestVersion) > 0) {
            state.latestManifestVersion = version;
        }
    }
    return state;
}
/** 原子写入：先写临时文件再 rename，避免进程中断留下半个 JSON */
export function writeState(hotUpdateDir, state) {
    fs.mkdirSync(hotUpdateDir, { recursive: true });
    const target = path.join(hotUpdateDir, STATE_FILENAME);
    const temp = `${target}.${process.pid}.tmp`;
    const content = JSON.stringify(state, null, 2);
    try {
        fs.writeFileSync(temp, content);
        fs.renameSync(temp, target);
    }
    catch {
        // Windows 上 state.json 可能被杀毒软件短暂占用导致 rename 失败，退化为直接覆盖。
        try {
            fs.rmSync(temp, { force: true });
        }
        catch {
            // ignore
        }
        fs.writeFileSync(target, content);
    }
}
export function updateState(hotUpdateDir, mutate) {
    const state = readState(hotUpdateDir);
    mutate(state);
    writeState(hotUpdateDir, state);
    return state;
}
