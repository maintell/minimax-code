/**
 * 更新模块配置
 */
import { autoUpdater } from "electron-updater";
import { getTestBuildInfo, testBranchFeedUrl, readTestBuild, isNewerTestBuild } from "./test-branch";
import { resolveDesktopRelease, RELEASE_FEED_TTL_MS } from "./release-feed";
import { isInsideBuild, isInternalBuild, isProd, isZh, isStaging, isTest, isDev } from "../../config/env";
import { getCategoryLogger } from "../../utils/logger";
const logger = getCategoryLogger('update');
/** 公开 prod 包：安装包由本仓库发布成 `desktop-v*` 的 GitHub Release。 */
export function isPublicReleaseChannel() {
    return isProd && !isInternalBuild && !isInsideBuild;
}
function cdnFeedUrl(releasePath: string) {
    return isZh
        ? `https://filecdn.minimax.chat/public/${releasePath}/release`
        : `https://file.cdn.minimax.io/public/${releasePath}/release`;
}
/**
 * 更新通道由包身份决定，不由后端环境决定。
 *
 * internal / inside 包由 Jenkins 的发布车道（BUILD_ENV=prod + VARIANT）生成
 * `-preview.N` / `-inside.N` 版本号并上传到 `minimax-agent-prod-{internal,inside}`，
 * 因此即使 internal 包的后端环境是预发（buildEnv=staging），它仍必须读取
 * prod-internal 目录下的 preview manifest，否则会跨车道更新成预发包。
 *
 * 公开 prod 包返回 null：本发行版的安装包由 `.github/workflows/desktop-release.yml`
 * 发布成 `desktop-v*` 的 GitHub Release，检查前由 ensurePublicReleaseFeed()
 * 解析出具体 release 再交给 electron-updater（见 release-feed.ts）。
 */
export function getUpdateServerUrl() {
    const variantPath = isInsideBuild
        ? 'minimax-agent-prod-inside'
        : isInternalBuild
            ? 'minimax-agent-prod-internal'
            : null;
    if (variantPath)
        return cdnFeedUrl(variantPath);
    if (isStaging) {
        // 预发布环境更新服务器
        return cdnFeedUrl('minimax-agent-staging');
    }
    // 普通 test 的 feat 包读取安装包所在分支的指针，其余 test 包保留共享 feed。
    const testBuild = getTestBuildInfo();
    if (testBuild)
        return testBranchFeedUrl(testBuild.locale, testBuild.branchKey);
    if (isTest) {
        // 测试环境更新服务器
        return cdnFeedUrl('minimax-agent-test');
    }
    // 公开 prod 包没有固定 CDN 地址，由 ensurePublicReleaseFeed() 解析。
    return null;
}
/**
 * 配置 autoUpdater
 */
export function configureAutoUpdater() {
    // 使用 electron-log 记录日志
    autoUpdater.logger = logger;
    // 打印当前环境信息，便于调试
    logger.info(`[Updater] 当前环境: isProd=${isProd}, isStaging=${isStaging}, isTest=${isTest}, isDev=${isDev}`);
    logger.info(`[Updater] NEXT_PUBLIC_BUILD_ENV=${process.env.NEXT_PUBLIC_BUILD_ENV}`);
    // 动态设置更新服务器 URL（覆盖 package.json 中的 publish 配置）。
    // 公开 prod 包没有固定地址：ensurePublicReleaseFeed() 在每次检查前把 feed
    // 指向本仓库最新的 `desktop-v*` release。
    const updateUrl = getUpdateServerUrl();
    if (updateUrl) {
        autoUpdater.setFeedURL({
            provider: 'generic',
            url: updateUrl,
            // 禁用多范围请求，避免某些 CDN 的 HTTP/2 兼容性问题
            useMultipleRangeRequest: false,
        });
    }
    // Windows 上禁用差量更新，避免 blockmap 校验失败后重新下载的问题
    // macOS 差量更新正常，保持启用以节省流量
    if (process.platform === 'win32') {
        autoUpdater.disableDifferentialDownload = true;
        logger.info(`[Updater] 更新服务器: ${updateUrl ?? '本仓库的 GitHub Release（检查前解析）'}, 差量更新已禁用 (Windows)`);
    }
    else {
        logger.info(`[Updater] 更新服务器: ${updateUrl ?? '本仓库的 GitHub Release（检查前解析）'}`);
    }
    // Disable web installer mode — we use a full NSIS installer, not a web stub.
    // Suppresses the electron-updater warning about disableWebInstaller defaulting.
    autoUpdater.disableWebInstaller = true;
    // 更新通道：包身份优先于后端环境
    // 版本号带预发布标识（如 2.0.0-test.123 / 3.0.0-preview.1012），electron-builder 会生成
    // 对应的 yml（test-mac.yml / preview-mac.yml），需要设置 channel 才能正确读取。
    if (isInsideBuild) {
        autoUpdater.channel = 'inside';
    }
    else if (isInternalBuild) {
        autoUpdater.channel = 'preview';
    }
    else if (isTest) {
        autoUpdater.channel = 'test';
    }
    else if (isStaging) {
        autoUpdater.channel = 'staging';
    }
    // prod 环境不需要设置，默认就是 latest
    logger.info(`[Updater] 更新通道: ${autoUpdater.channel || 'latest'}`);
    // 检查到新版本后自动下载，无需用户手动触发
    autoUpdater.autoDownload = true;
    // Both macOS and Windows: disable electron-updater's built-in auto-install.
    // Installation is controlled by the will-quit handler in main/index.ts,
    // gated by the Apollo agentConfig.autoUpdateDesktopVersion flag.
    autoUpdater.autoInstallOnAppQuit = false;
    // 允许降级（可选，根据需求配置）
    autoUpdater.allowDowngrade = false;
    // 允许预发布版本：test/staging 环境以及 internal/inside 车道的版本号都带预发布标识
    autoUpdater.allowPrerelease = isTest || isStaging || isInternalBuild || isInsideBuild;
    if (defaultUpdateSupported)
        autoUpdater.isUpdateSupported = defaultUpdateSupported;
    if (getTestBuildInfo())
        followTestBranch();
    logger.info('[Updater] autoUpdater 配置完成');
}
let defaultUpdateSupported;
// 公开通道的版本发现状态：解析成功的 tag、解析时间，以及正在进行的解析。
let publicFeedTag: string | null = null;
let publicFeedResolvedAt = 0;
let publicFeedResolution: Promise<void> | null = null;
/**
 * 让 electron-updater 指向本仓库最新的 `desktop-v*` release。
 *
 * 版本发现要走网络，所以每个检查入口都必须先 await 本函数，再调用
 * autoUpdater.checkForUpdates()。结果在进程内缓存 RELEASE_FEED_TTL_MS，手动检查
 * 和定时轮询不会重复请求 release feed。解析失败时保持上一次成功的 feed 不变，
 * 把错误交给调用方返回渲染层；绝不回退到上游 CDN，否则会提示安装官方构建。
 */
export function ensurePublicReleaseFeed() {
    if (!isPublicReleaseChannel())
        return Promise.resolve();
    if (publicFeedTag && Date.now() - publicFeedResolvedAt < RELEASE_FEED_TTL_MS)
        return Promise.resolve();
    if (!publicFeedResolution) {
        publicFeedResolution = resolveDesktopRelease()
            .then((release) => {
                if (publicFeedTag !== release.tag) {
                    autoUpdater.setFeedURL({
                        provider: 'generic',
                        url: release.feedUrl,
                        useMultipleRangeRequest: false,
                    });
                    logger.info(`[Updater] 更新源: ${release.repository} ${release.tag} (${release.feedUrl})`);
                }
                publicFeedTag = release.tag;
                publicFeedResolvedAt = Date.now();
            })
            .finally(() => {
                publicFeedResolution = null;
            });
    }
    return publicFeedResolution;
}
/**
 * 普通 test 包只接受目标分支（默认是安装包分支）里开始得更晚的构建。两台 Jenkins 和个人任务的
 * 构建号互不可比，最新构建的版本号可能更小，因此允许“降级”。切换分支时接受目标分支的最新构建。
 * 非 feat 分支或没有有效分支身份的 test 包继续使用原有共享 feed 和版本比较规则。
 */
export function followTestBranch(switchToBranchKey) {
    const installed = getTestBuildInfo();
    if (!installed)
        return;
    defaultUpdateSupported ?? (defaultUpdateSupported = autoUpdater.isUpdateSupported);
    const supported = defaultUpdateSupported;
    autoUpdater.allowDowngrade = true;
    autoUpdater.isUpdateSupported = (info) => {
        const candidate = readTestBuild(info);
        if (!installed || !candidate || candidate.locale !== installed.locale)
            return false;
        const accepted = switchToBranchKey
            ? candidate.branchKey === switchToBranchKey
            : candidate.branchKey === installed.branchKey && isNewerTestBuild(candidate, installed);
        return accepted && supported(info);
    };
}
/** Developer Tools 切换分支：临时读取目标分支的指针；取消或失败后由 configureAutoUpdater 恢复。 */
export function switchTestBranchFeed(branchKey) {
    const installed = getTestBuildInfo();
    if (!installed)
        throw new Error('TEST_BRANCH_UNAVAILABLE');
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: testBranchFeedUrl(installed.locale, branchKey),
        useMultipleRangeRequest: false,
    });
    followTestBranch(branchKey);
}
