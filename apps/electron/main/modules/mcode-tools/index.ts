import path from "node:path";
import { app } from "electron";
import { getConfig } from "@mavis/config";
import { removeMcodeToolsLaunchers, startMcodeToolsHostIntegration } from "@mavis/mcode-tools-host";
import { buildEnv, LOCALE } from "../../config/env";
import { resolveLocalRuntimeDataDir } from "../local-runtime/data-dir";
import logger from "../../utils/logger";
import { prepareDevelopmentMcodeToolsResource } from "./dev-resource";
let initialization = null;
let activeIntegration = null;
let disposal = null;
export function initializeMcodeToolsIntegration(options) {
    if (initialization)
        return initialization;
    const attempt = initialize(options);
    const tracked = attempt.catch((error) => {
        if (initialization === tracked)
            initialization = null;
        logger.warn(`[mcode-tools] integration unavailable category=${errorCategory(error)}`);
        throw error;
    });
    initialization = tracked;
    return initialization;
}
export async function scheduleMcodeToolsAuthorization(input) {
    void input;
    if (initialization)
        await initialization;
}
export async function clearMcodeToolsAuthorization() {
    if (initialization)
        await initialization;
}
export function disposeMcodeToolsIntegration() {
    if (disposal)
        return disposal;
    const pendingInitialization = initialization;
    initialization = null;
    const current = dispose(pendingInitialization);
    const tracked = current.finally(() => {
        if (disposal === tracked)
            disposal = null;
    });
    disposal = tracked;
    return tracked;
}
async function initialize(options) {
    const paths = integrationPaths();
    const expectedBuildEnv = normalizeBuildEnv(buildEnv);
    if (getConfig().beta.mcodeTools !== true) {
        removeMcodeToolsLaunchers(paths.dataDir, paths.region);
        logger.info(`[mcode-tools] integration disabled buildEnv=${expectedBuildEnv} platform=${process.platform}`);
        return;
    }
    try {
        const useResolvedResource = app.isPackaged ||
            ((buildEnv === 'dev' || buildEnv === 'development') &&
                process.env.MAVIS_DEV_MCODE_TOOLS_MODE === 'published');
        const resourceDir = useResolvedResource
            ? paths.resourceDir
            : await prepareDevelopmentMcodeToolsResource({
                appPath: app.getAppPath(),
                dataDir: paths.dataDir,
                executable: process.execPath,
                parentEnv: process.env,
            });
        const integration = await startMcodeToolsHostIntegration({
            resourceDir,
            expectedBuildEnv,
            dataDir: paths.dataDir,
            executable: process.execPath,
            platform: process.platform,
            region: paths.region,
            session: options.sharedAuthSession,
            logger: logger,
        });
        activeIntegration = integration;
        logger.info(`[mcode-tools] shared-broker launcher ready buildEnv=${expectedBuildEnv} region=${paths.region} version=${integration.version}`);
    }
    catch (error) {
        removeMcodeToolsLaunchers(paths.dataDir, paths.region);
        throw error;
    }
}
async function dispose(pendingInitialization) {
    await pendingInitialization?.catch(() => undefined);
    const integration = activeIntegration;
    activeIntegration = null;
    await integration?.dispose();
}
function integrationPaths() {
    const dataDir = resolveLocalRuntimeDataDir();
    return {
        dataDir,
        resourceDir: resolveMcodeToolsResourceDir({
            appIsPackaged: app.isPackaged,
            appPath: app.getAppPath(),
            resourcesPath: process.resourcesPath,
            buildEnv: buildEnv,
            env: process.env,
        }),
        region: LOCALE === 'zh' ? 'cn' : 'en',
    };
}
export function resolveMcodeToolsResourceDir(options) {
    if (options.appIsPackaged) {
        return path.join(options.resourcesPath, 'resources', 'mcode-tools');
    }
    const isDevBuild = options.buildEnv === 'dev' || options.buildEnv === 'development';
    if (isDevBuild && options.env.MAVIS_DEV_MCODE_TOOLS_MODE === 'published') {
        const resourceDir = options.env.MAVIS_DEV_MCODE_TOOLS_RESOURCE_DIR?.trim();
        if (!resourceDir) {
            throw new Error('Published dev mcode-tools resource directory is required');
        }
        if (!path.isAbsolute(resourceDir)) {
            throw new Error('Published dev mcode-tools resource directory must be absolute');
        }
        return path.normalize(resourceDir);
    }
    return path.join(options.appPath, 'resources', 'mcode-tools');
}
function normalizeBuildEnv(value) {
    if (value === 'staging' || value === 'prod')
        return value;
    return 'test';
}
function errorCategory(error) {
    if (!(error instanceof Error))
        return 'unknown';
    const message = error.message.toLowerCase();
    if (message.includes('missing'))
        return 'resource_missing';
    if (message.includes('sha256'))
        return 'integrity_mismatch';
    if (message.includes('environment'))
        return 'environment_mismatch';
    return 'initialization_failed';
}
