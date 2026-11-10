/**
 * 普通 test 包的分支身份。
 *
 * 构建时由 apps/electron/scripts/test-branch-build.mjs 写入 dist/test-build-info.json；
 * 分支指针由 scripts/mmx-agent/publish-test-branch-updates.mjs 发布。分支规范化与
 * branchKey 计算必须与构建脚本一致（见 test-branch.test.ts 的一致性用例）。
 */
import { app } from "electron";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isTest, isDev, isInsideBuild, isInternalBuild, isZh } from "../../config/env";
const REPOSITORY = 'matrix/agent-archon';
export function isTestBranchUpdateBuild() {
    return getTestBuildInfo() !== null;
}
export function normalizeTestBranch(value) {
    if (typeof value !== 'string')
        throw new Error('TEST_BRANCH_INVALID');
    const branch = value.trim().replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/, '');
    if (!branch ||
        branch.length > 512 ||
        branch === '@' ||
        branch === 'HEAD' ||
        branch === 'unknown' ||
        branch.startsWith('refs/') ||
        /^[a-f0-9]{40}$/i.test(branch) ||
        branch.startsWith('-') ||
        branch.includes('..') ||
        branch.includes('@{') ||
        /[\s\x00-\x1f\x7f~^:?*[\\]/u.test(branch) ||
        branch
            .split('/')
            .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))
        throw new Error('TEST_BRANCH_INVALID');
    return branch;
}
/** 分支名须先规范化；与客户端/打包端的资格规则保持一致。 */
export function isTestBranchUpdateBranch(branch) {
    return branch.startsWith('feat/');
}
export function testBranchKey(branch) {
    return createHash('sha256')
        .update(`${REPOSITORY}\0${normalizeTestBranch(branch)}`)
        .digest('hex');
}
export function parseTestBuildInfo(value) {
    if (!value || typeof value !== 'object')
        return null;
    const record = value;
    try {
        const branch = normalizeTestBranch(record.branch);
        if (!isTestBranchUpdateBranch(branch) ||
            record.repository !== REPOSITORY ||
            record.branch !== branch ||
            record.branchKey !== testBranchKey(branch) ||
            typeof record.commit !== 'string' ||
            typeof record.appVersion !== 'string' ||
            (record.locale !== 'zh' && record.locale !== 'en') ||
            !Number.isSafeInteger(record.startedAt) ||
            record.startedAt <= 0 ||
            typeof record.buildUrl !== 'string')
            return null;
        return {
            branch,
            branchKey: record.branchKey,
            commit: record.commit,
            appVersion: record.appVersion,
            locale: record.locale,
            startedAt: record.startedAt,
            buildUrl: record.buildUrl,
        };
    }
    catch {
        return null;
    }
}
/** 当前安装包的 feat 分支身份；非普通 test 包、非 feat 分支、缺失或版本/语言不符时为 null。 */
export function getTestBuildInfo() {
    if (!isTest || isDev || isInsideBuild || isInternalBuild)
        return null;
    try {
        const info = parseTestBuildInfo(JSON.parse(readFileSync(path.join(app.getAppPath(), 'dist', 'test-build-info.json'), 'utf8')));
        return info?.appVersion === app.getVersion() && info.locale === (isZh ? 'zh' : 'en')
            ? info
            : null;
    }
    catch {
        return null;
    }
}
/** 分支指针所在目录（generic provider 的 feed URL）。 */
export function testBranchFeedUrl(locale, branchKey) {
    const cdn = locale === 'zh' ? 'https://filecdn.minimax.chat' : 'https://file.cdn.minimax.io';
    const platform = process.platform === 'win32' ? 'win' : 'mac';
    return `${cdn}/public/minimax-agent-test/release/branches/${branchKey}/${platform}/`;
}
/** 分支指针（electron-updater 的 UpdateInfo）里携带的构建身份。 */
export function readTestBuild(info) {
    return parseTestBuildInfo(info?.testBuild);
}
/** a 是否比 b 开始得更晚；开始时间相同时按 buildUrl 确定先后。 */
export function isNewerTestBuild(a, b) {
    return a.startedAt > b.startedAt || (a.startedAt === b.startedAt && a.buildUrl > b.buildUrl);
}
