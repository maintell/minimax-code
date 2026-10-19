/**
 * 更新模块配置
 */
import { autoUpdater } from "electron-updater";
import { isInsideBuild, isInternalBuild, isProd, isZh, isStaging, isTest, isDev } from "../../config/env";
import { getCategoryLogger } from "../../utils/logger";
const logger = getCategoryLogger('update');
/**
 * 更新通道由包身份决定，不由后端环境决定。
 *
 * internal / inside 包由 Jenkins 的发布车道（BUILD_ENV=prod + VARIANT）生成
 * `-preview.N` / `-inside.N` 版本号并上传到 `minimax-agent-prod-{internal,inside}`，
 * 因此即使 internal 包的后端环境是预发（buildEnv=staging），它仍必须读取
 * prod-internal 目录下的 preview manifest，否则会跨车道更新成预发包。
 */
export function getUpdateServerUrl() {
    const variantPath = isInsideBuild
        ? 'minimax-agent-prod-inside'
        : isInternalBuild
            ? 'minimax-agent-prod-internal'
            : null;
    const releasePath = variantPath ?? (isProd ? 'minimax-agent-prod' : null);
    if (releasePath) {
        return isZh
            ? `https://filecdn.minimax.chat/public/${releasePath}/release`
            : `https://file.cdn.minimax.io/public/${releasePath}/release`;
    }
    if (isStaging) {
        // 预发布环境更新服务器
        return isZh
            ? 'https://filecdn.minimax.chat/public/minimax-agent-staging/release'
            : 'https://file.cdn.minimax.io/public/minimax-agent-staging/release';
    }
    // 测试环境更新服务器
    return isZh
        ? `https://filecdn.minimax.chat/public/minimax-agent-test/release`
        : `https://file.cdn.minimax.io/public/minimax-agent-test/release`;
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
    // 动态设置更新服务器 URL（覆盖 package.json 中的 publish 配置）
    const updateUrl = getUpdateServerUrl();
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: updateUrl,
        // 禁用多范围请求，避免某些 CDN 的 HTTP/2 兼容性问题
        useMultipleRangeRequest: false,
    });
    // Windows 上禁用差量更新，避免 blockmap 校验失败后重新下载的问题
    // macOS 差量更新正常，保持启用以节省流量
    if (process.platform === 'win32') {
        autoUpdater.disableDifferentialDownload = true;
        logger.info(`[Updater] 更新服务器: ${updateUrl}, 差量更新已禁用 (Windows)`);
    }
    else {
        logger.info(`[Updater] 更新服务器: ${updateUrl}`);
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
    logger.info('[Updater] autoUpdater 配置完成');
}
