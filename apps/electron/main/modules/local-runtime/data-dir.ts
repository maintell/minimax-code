import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { migrateProfileDataDir, migrateDefaultDataDir } from "@mavis/config/data-dir";
const APP_DIR = '.minimax';
const LEGACY_RUNTIME_ENV_PREFIX = '__MAVIS_RUNTIME';
export let LOCAL_RUNTIME_DATA_DIR_SOURCE_ENV = '__MAVIS_RUNTIME_DATA_DIR_SOURCE';
const REPO_NAMES = new Set(['agent-archon', 'mavis']);
let configuredLocalRuntimeDataParentDir = null;
let synchronizedLocalRuntimeDataDir = null;
const defaultGitRunner = (args, cwd) => {
    try {
        const result = spawnSync('git', args, {
            encoding: 'utf-8',
            timeout: 3000,
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.status === 0 && result.stdout)
            return result.stdout.trim();
        return null;
    }
    catch {
        return null;
    }
};
function parseRepoName(remoteUrl) {
    const match = remoteUrl.match(/[/:]([^/:]+?)(?:\.git)?$/);
    return match?.[1] ?? null;
}
export function detectWorktreeBranchProfile(repoRoot, runner = defaultGitRunner) {
    const remoteUrl = runner(['remote', 'get-url', 'origin'], repoRoot);
    if (!remoteUrl)
        return null;
    const repoName = parseRepoName(remoteUrl);
    if (!repoName || !REPO_NAMES.has(repoName))
        return null;
    const branch = runner(['branch', '--show-current'], repoRoot);
    if (!branch)
        return null;
    return branch.replace(/\//g, '-');
}
function legacyRuntimeEnv(suffix) {
    if (process.env.__MAVIS_ALLOW_LEGACY_RUNTIME_ENV !== '1')
        return undefined;
    return process.env[`${LEGACY_RUNTIME_ENV_PREFIX}_${suffix}`];
}
function shouldUseGitProfile(envFlag) {
    if (envFlag === '0')
        return false;
    return legacyRuntimeEnv('DISABLE_GIT_AUTO_CONFIG') !== '1';
}
function resolveProfileDataDirName(profile) {
    return profile ? `${APP_DIR}-${profile}` : APP_DIR;
}
export function resolveLocalRuntimeDataDirName(envFlag = process.env.MAVIS_DEV_USE_GIT_PROFILE, repoRoot = process.cwd(), detectBranch = (root) => detectWorktreeBranchProfile(root)) {
    if (shouldUseGitProfile(envFlag)) {
        const branch = detectBranch(repoRoot);
        if (branch)
            return resolveProfileDataDirName(branch);
    }
    const legacyProfile = legacyRuntimeEnv('PROFILE')?.trim();
    return resolveProfileDataDirName(legacyProfile || null);
}
export function resolveLocalRuntimeDataDirFromParent(parentDir, dataDirName = APP_DIR) {
    return path.join(parentDir, dataDirName);
}
export function getDefaultLocalRuntimeDataParentDir(homeDir = os.homedir()) {
    return homeDir;
}
export function setConfiguredLocalRuntimeDataParentDir(parentDir) {
    const normalized = parentDir?.trim();
    configuredLocalRuntimeDataParentDir = normalized ? path.resolve(normalized) : null;
}
export function getConfiguredLocalRuntimeDataParentDir() {
    return configuredLocalRuntimeDataParentDir;
}
/**
 * Pins @mavis/config to Electron's resolved runtime data directory before
 * either process reads config.yaml. The utility process receives the same
 * values again at its fork boundary, which also protects against login-shell
 * environment hydration.
 */
export function synchronizeLocalRuntimeDataDirEnv(envFlag = process.env.MAVIS_DEV_USE_GIT_PROFILE, homeDir = os.homedir(), repoRoot = process.cwd(), detectBranch = (root) => detectWorktreeBranchProfile(root)) {
    const selection = synchronizedLocalRuntimeDataDirForCurrentEnv() ??
        resolveLocalRuntimeDataDirSelection(envFlag, homeDir, repoRoot, detectBranch);
    const { dataDir, source } = selection;
    process.env.MINIMAX_DATA_DIR = dataDir;
    process.env.MAVIS_DATA_DIR = dataDir;
    process.env[LOCAL_RUNTIME_DATA_DIR_SOURCE_ENV] = source;
    synchronizedLocalRuntimeDataDir = selection;
    return dataDir;
}
function synchronizedLocalRuntimeDataDirForCurrentEnv() {
    const selection = synchronizedLocalRuntimeDataDir;
    if (!selection)
        return null;
    return process.env.MINIMAX_DATA_DIR === selection.dataDir &&
        process.env.MAVIS_DATA_DIR === selection.dataDir
        ? selection
        : null;
}
export function resolveLocalRuntimeDataDir(envFlag = process.env.MAVIS_DEV_USE_GIT_PROFILE, homeDir = os.homedir(), repoRoot = process.cwd(), detectBranch = (root) => detectWorktreeBranchProfile(root)) {
    return resolveLocalRuntimeDataDirSelection(envFlag, homeDir, repoRoot, detectBranch).dataDir;
}
function resolveLocalRuntimeDataDirSelection(envFlag, homeDir, repoRoot, detectBranch) {
    const minimaxDataDir = process.env.MINIMAX_DATA_DIR?.trim();
    if (minimaxDataDir)
        return { dataDir: minimaxDataDir, source: 'minimax_env' };
    const mavisDataDir = process.env.MAVIS_DATA_DIR?.trim();
    if (mavisDataDir)
        return { dataDir: mavisDataDir, source: 'mavis_env' };
    if (configuredLocalRuntimeDataParentDir) {
        return {
            dataDir: resolveLocalRuntimeDataDirFromParent(configuredLocalRuntimeDataParentDir, resolveLocalRuntimeDataDirName(envFlag, repoRoot, detectBranch)),
            source: 'desktop_custom',
        };
    }
    const legacyDataDir = legacyRuntimeEnv('DATA_DIR')?.trim();
    const legacyProfile = legacyRuntimeEnv('PROFILE')?.trim();
    if (legacyDataDir && legacyProfile) {
        return { dataDir: legacyDataDir, source: 'legacy_runtime_env' };
    }
    if (shouldUseGitProfile(envFlag)) {
        const branch = detectBranch(repoRoot);
        if (branch) {
            return { dataDir: migrateProfileDataDir(branch, homeDir), source: 'profile' };
        }
    }
    if (legacyDataDir)
        return { dataDir: legacyDataDir, source: 'legacy_runtime_env' };
    if (legacyProfile) {
        return { dataDir: migrateProfileDataDir(legacyProfile, homeDir), source: 'profile' };
    }
    return { dataDir: migrateDefaultDataDir(homeDir), source: 'default' };
}
