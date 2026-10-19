/**
 * 加载环境变量
 * 必须在所有其他模块之前导入
 */
import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import { resolveProductBuildIdentity } from "@mavis/shared/product-build-identity";
import { BUILD_ENV_TO_MAVIS } from "./build-env";
export { BUILD_ENV_TO_MAVIS };
import { applyDevProtocolLaunchArgs } from "./dev-protocol-launch";
import { isElectronDevelopmentMode, clearInheritedPackagedBuildFlags, parseEnvFile, applyEnvVars } from "./env-loader";
// 仅 Windows Electron 开发启动（process.defaultApp）可能由 URI protocol 创建新进程；
// 在派生开发配置前恢复 protocol 注册时保存的固定参数。
if (process.platform === 'win32' && process.defaultApp) {
    applyDevProtocolLaunchArgs();
}
// 判断是否为开发环境（Node.js 层面）
const isNodeDevMode = isElectronDevelopmentMode(process.env.NODE_ENV, app.isPackaged);
/**
 * 获取 .env 文件路径
 * 开发环境：从项目根目录读取
 * 生产环境：从打包后的 app 目录读取 .env.local（构建时复制过来的）
 */
function getEnvFilePath() {
    const baseDir = isNodeDevMode ? path.join(__dirname, '..', '..', '..') : app.getAppPath();
    if (isNodeDevMode) {
        // 开发环境：根据环境变量选择对应的 .env 文件
        const locale = process.env.NEXT_PUBLIC_LOCALE || 'en';
        const buildEnv = process.env.NEXT_PUBLIC_BUILD_ENV || 'dev';
        const envTypeMap = {
            dev: 'development',
            development: 'development',
            test: 'test',
            staging: 'staging',
            prod: 'production',
            production: 'production',
        };
        const envType = envTypeMap[buildEnv] || 'development';
        const envFileName = `.env.${locale}.${envType}`;
        return path.join(baseDir, envFileName);
    }
    else {
        // 生产环境：使用构建时复制的 .env.local 文件
        // 构建脚本会将对应环境的 .env 文件复制为 .env.local
        return path.join(baseDir, '.env.local');
    }
}
/**
 * 设置默认的国内线上环境变量
 * 当生产环境没有读取到 env 文件时使用
 */
function setDefaultZhProdEnv() {
    const defaultEnvVars = {
        NEXT_PUBLIC_BUILD_ENV: 'prod',
        NEXT_PUBLIC_LOCALE: 'zh',
    };
    Object.entries(defaultEnvVars).forEach(([key, value]) => {
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    });
    // eslint-disable-next-line no-console
    console.log('[Electron] Using default zh production environment');
}
/**
 * 加载环境变量
 */
export function loadEnv() {
    // Packaged build flags are trusted only when restored from the bundled .env.local below.
    // Do this before every fallback so a missing or unreadable file fails closed to the formal package.
    if (!isNodeDevMode) {
        clearInheritedPackagedBuildFlags(process.env);
    }
    const envFilePath = getEnvFilePath();
    if (!envFilePath) {
        console.warn('[Electron] No env file path determined');
        // 非开发环境下，使用默认的国内线上环境
        if (!isNodeDevMode) {
            setDefaultZhProdEnv();
        }
        return;
    }
    if (!fs.existsSync(envFilePath)) {
        console.warn(`[Electron] Env file not found: ${envFilePath}`);
        // 非开发环境下，使用默认的国内线上环境
        if (!isNodeDevMode) {
            setDefaultZhProdEnv();
        }
        return;
    }
    try {
        const content = fs.readFileSync(envFilePath, 'utf-8');
        const envVars = parseEnvFile(content);
        // Packaged builds use bundled .env.local as the source of truth.
        // Override inherited shell/CI values so staging packages cannot boot as prod.
        applyEnvVars(envVars, process.env, { override: !isNodeDevMode });
        // eslint-disable-next-line no-console
        console.log(`[Electron] Loaded env: ${envFilePath}`);
        // eslint-disable-next-line no-console
        console.log(`[Electron] BUILD_ENV=${process.env.NEXT_PUBLIC_BUILD_ENV}, LOCALE=${process.env.NEXT_PUBLIC_LOCALE}`);
    }
    catch (error) {
        console.error(`[Electron] Failed to load env file: ${envFilePath}`, error);
        // 非开发环境下，加载失败时使用默认的国内线上环境
        if (!isNodeDevMode) {
            setDefaultZhProdEnv();
        }
    }
}
// 立即执行加载
loadEnv();
// ============================================
// 在 Electron 主进程中使用这些导出，而不是从 packages 导入
// ============================================
// 设备类型
export let isElectron = true;
export let isWeb = false;
export let isH5 = false;
export let isNative = false;
export let isMobile = false;
// 构建环境
export let buildEnv = process.env.NEXT_PUBLIC_BUILD_ENV;
const productBuildIdentity = resolveProductBuildIdentity({
    buildEnv: buildEnv,
    internalBuild: process.env.__MAVIS_BUILD_INTERNAL === 'true',
    insideBuild: process.env.__MAVIS_BUILD_INSIDE === 'true',
});
export let isProd = productBuildIdentity.isProd;
export let isStaging = productBuildIdentity.isStaging;
export let isTest = productBuildIdentity.isTest;
export let isDev = productBuildIdentity.isDev;
// 语言环境
export let LOCALE = (process.env.NEXT_PUBLIC_LOCALE || 'en');
export let isEn = LOCALE === 'en';
export let isZh = LOCALE === 'zh';
// 构建变体
// 是否为 internal 构建（独立更新通道），由共享构建身份解析
export let isInternalBuild = productBuildIdentity.isInternalBuild;
// 是否为 inside 构建（外部用户预热包，独立更新通道，行为同 prod）
export let isInsideBuild = productBuildIdentity.isInsideBuild;
// 录制器仅在本地、测试、预发和 internal 预览包中启用；公开生产包与 inside 包关闭。
export let isTrackingRecorderBuild = !isInsideBuild && (!isProd || isInternalBuild);
