/**
 * 热更新模块配置常量
 */

import { isDev, isInternalBuild, isInsideBuild, isProd, isStaging, isTest, isEn } from "../../config";
export let HOT_UPDATE_CHANNELS = Object.freeze([
    'prod',
    'internal',
    'inside',
    'staging',
    'test',
]);
/**
 * 根据构建身份解析热更新通道。
 * internal 包使用 staging env，inside 包使用 prod env，因此变体判断必须先于环境判断。
 */
export function resolveHotUpdateChannel(identity) {
    if (identity.isDev)
        return null;
    if (identity.isInternalBuild)
        return 'internal';
    if (identity.isInsideBuild)
        return 'inside';
    if (identity.isProd)
        return 'prod';
    if (identity.isStaging)
        return 'staging';
    if (identity.isTest)
        return 'test';
    return null;
}
/** 当前进程的热更新通道（null 表示该构建不支持热更新） */
export let HOT_UPDATE_CHANNEL = resolveHotUpdateChannel({
    isDev: isDev,
    isInternalBuild: isInternalBuild,
    isInsideBuild: isInsideBuild,
    isProd: isProd,
    isStaging: isStaging,
    isTest: isTest,
});
export let HOT_UPDATE_LOCALE = isEn ? 'en' : 'zh';
/** 热更新 CDN 根地址；manifest 位于 `{root}/{channel}/{appVersion}/manifest.json` */
export let HOT_UPDATE_CDN_ROOT = isEn
    ? 'https://file.cdn.minimax.io/public/minimax-agent/hot-update/v2/en'
    : 'https://filecdn.minimax.chat/public/minimax-agent/hot-update/v2/zh';
/**
 * manifest 签名公钥（Ed25519，SPKI DER base64），每组支持多把公钥以便轮换。
 * 每组私钥只绑定到一个 Jenkins job，job 自身限定构建来源，客户端只信任本通道对应的一组：
 * - prod / inside：release key，credential desktop-hot-update-signing-key，
 *   job mavis-hot-update-prod（只接受 main 上的 hot-v* / inside-hot-v* tag）
 * - internal / staging：preview key，credential desktop-hot-update-preview-signing-key，
 *   job mavis-hot-update-preview（固定从 preview_train 构建）
 * - test：test key，credential desktop-hot-update-test-signing-key，job mavis-hot-update-test（分支不限）
 */
export let HOT_UPDATE_RELEASE_SIGNING_PUBLIC_KEYS = Object.freeze([
    'MCowBQYDK2VwAyEAb/Rr23Ce628ZJG+Fg0E+gR8dFrPp2eRLlE4o66HlNS4=',
]);
export let HOT_UPDATE_PREVIEW_SIGNING_PUBLIC_KEYS = Object.freeze([
    'MCowBQYDK2VwAyEARMxvBCNx2phXXw48zOUn3qEJxXz57S50SlTwrbKwdac=',
]);
export let HOT_UPDATE_TEST_SIGNING_PUBLIC_KEYS = Object.freeze([
    'MCowBQYDK2VwAyEA/rJnC8am6Wispk9wEYmZP/B6jyoL7InjVjMjSDjytg0=',
]);
export function resolveHotUpdateSigningPublicKeys(channel) {
    switch (channel) {
        case 'prod':
        case 'inside':
            return HOT_UPDATE_RELEASE_SIGNING_PUBLIC_KEYS;
        case 'internal':
        case 'staging':
            return HOT_UPDATE_PREVIEW_SIGNING_PUBLIC_KEYS;
        case 'test':
            return HOT_UPDATE_TEST_SIGNING_PUBLIC_KEYS;
        default:
            return [];
    }
}
/** 当前构建信任的 manifest 签名公钥 */
export let HOT_UPDATE_SIGNING_PUBLIC_KEYS = resolveHotUpdateSigningPublicKeys(HOT_UPDATE_CHANNEL);
/** 清单文件名 */
export let MANIFEST_FILENAME = 'manifest.json';
/** 热更新缓存目录名（位于 userData 下） */
export let HOT_UPDATE_DIR = 'hot-update';
/** 状态文件名 */
export let STATE_FILENAME = 'state.json';
/** 打包时写入 dist/ 的壳指纹文件名 */
export let SHELL_FINGERPRINT_FILENAME = 'hot-update-shell.json';
/** 已完整安装的版本目录标记文件 */
export let VERSION_COMPLETE_MARKER = '.hot-update-complete.json';
/** 定时检查间隔（毫秒）- 6 小时 */
export let CHECK_INTERVAL = 6 * 60 * 60 * 1000;
/** 首屏可见后延迟多久开始第一次检查 */
export let FIRST_CHECK_DELAY_AFTER_VISIBLE_MS = 30 * 1000;
/** 首屏一直未可见时的兜底检查延迟 */
export let FIRST_CHECK_FALLBACK_DELAY_MS = 5 * 60 * 1000;
/** 热更新版本连续多少次启动未确认健康后回滚 */
export let MAX_UNCONFIRMED_BOOTS = 3;
