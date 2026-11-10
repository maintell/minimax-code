/**
 * Developer Tools 切换测试分支：查询目标分支指针，确认后下载目标分支当前最新构建并交给原有安装流程。
 * 查询不改变更新目标；下载或安装没有成功时恢复跟随安装包分支，丢弃已下载的目标包。
 */
import { net } from "electron";
import { autoUpdater } from "electron-updater";
import { switchTestBranchFeed, configureAutoUpdater } from "./config";
import { isNativeUpdaterFetchInFlight } from "./native-fetch";
import { isPendingUpdateCheck } from "./pending-check";
import { getUpdateStatus, resetUpdateCache } from "./state";
import { getTestBuildInfo, normalizeTestBranch, isTestBranchUpdateBranch, testBranchKey, testBranchFeedUrl, readTestBuild } from "./test-branch";
let switching = false;
export function isSwitchingTestBranch() {
    return switching;
}
export function getTestBranchInfo() {
    const info = getTestBuildInfo();
    return {
        supported: info !== null,
        current: info
            ? {
                branch: info.branch,
                version: info.appVersion,
                commit: info.commit,
                startedAt: info.startedAt,
            }
            : null,
    };
}
/** 错误码只透出 TEST_BRANCH_*，其余统一为查询失败。 */
export function testBranchErrorCode(error) {
    const code = error instanceof Error ? error.message : '';
    return /^TEST_BRANCH_[A-Z_]+$/.test(code) ? code : 'TEST_BRANCH_QUERY_FAILED';
}
function sameBuild(a, b) {
    return a.startedAt === b.startedAt && a.buildUrl === b.buildUrl && a.commit === b.commit;
}
function normalizeTargetBranch(input) {
    const branch = normalizeTestBranch(input);
    if (!isTestBranchUpdateBranch(branch))
        throw new Error('TEST_BRANCH_FEAT_ONLY');
    return branch;
}
export async function queryTestBranch(input) {
    const installed = getTestBuildInfo();
    if (!installed)
        throw new Error('TEST_BRANCH_UNAVAILABLE');
    const branch = normalizeTargetBranch(input);
    const branchKey = testBranchKey(branch);
    const feed = process.platform === 'win32' ? 'test.yml' : 'test-mac.yml';
    const response = await net.fetch(`${testBranchFeedUrl(installed.locale, branchKey)}${feed}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404)
        throw new Error('TEST_BRANCH_NO_RELEASE');
    if (!response.ok)
        throw new Error('TEST_BRANCH_QUERY_FAILED');
    const pointer = JSON.parse(await response.text());
    const build = readTestBuild(pointer);
    if (!build ||
        build.branchKey !== branchKey ||
        build.locale !== installed.locale ||
        pointer.version !== build.appVersion)
        throw new Error('TEST_BRANCH_QUERY_FAILED');
    const current = sameBuild(build, installed);
    if (!current && build.appVersion === installed.appVersion)
        throw new Error('TEST_BRANCH_SAME_VERSION');
    return {
        branch,
        version: build.appVersion,
        commit: build.commit,
        startedAt: build.startedAt,
        current,
    };
}
export async function switchTestBranch(input, install) {
    if (!getTestBuildInfo())
        throw new Error('TEST_BRANCH_UNAVAILABLE');
    if (switching ||
        ['checking', 'available', 'downloading'].includes(getUpdateStatus()) ||
        // 已下载包的元数据复查期间状态仍是 downloaded，复查结果可能触发替换下载。
        isPendingUpdateCheck() ||
        isNativeUpdaterFetchInFlight())
        throw new Error('TEST_BRANCH_BUSY');
    const branchKey = testBranchKey(normalizeTargetBranch(input));
    switching = true;
    let dispatched = false;
    try {
        resetUpdateCache();
        switchTestBranchFeed(branchKey);
        const result = await autoUpdater.checkForUpdates();
        if (result?.updateInfo?.version === autoUpdater.currentVersion.version)
            throw new Error('TEST_BRANCH_SAME_VERSION');
        // 系统不满足要求等其他原因时不可安装。
        if (!result?.isUpdateAvailable || !result.downloadPromise)
            throw new Error('TEST_BRANCH_QUERY_FAILED');
        await result.downloadPromise;
        const outcome = await install();
        dispatched = outcome.success;
        return outcome;
    }
    finally {
        if (!dispatched) {
            resetUpdateCache();
            configureAutoUpdater();
            autoUpdater.emit('update-not-available', {
                version: autoUpdater.currentVersion.version,
                files: [],
                path: '',
                sha512: '',
                releaseDate: '',
            });
            switching = false;
        }
        // 安装已交给退出流程时保持 switching，直到进程退出。
    }
}
