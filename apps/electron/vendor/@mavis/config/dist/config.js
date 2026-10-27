import { MINIMAX_FIRST_RUN_DEFAULT_MODEL_ID, MINIMAX_MODELS } from './minimax-model-catalog.js';
import fs from 'node:fs';
import { restrictConfigFileSync, writePrivateConfigFileSync } from './private-config-file.js';
import { parseConfigText, serializeConfigPreservingComments, } from './comment-preserving-config-write.js';
import { resolveRunawayGuardConfig } from './runaway-guard-config.js';
import { MEMORY_V2_DEFAULTS, parseMemoryConfig, resolveMemoryDefaults, } from './memory-config.js';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { parseTuiConfig } from './tui-config.js';
import { applyManagedMinimaxContextLimits, applyRequiredProviderOverrides, migrateLegacyByokProvidersOnDisk, restrictLegacyByokBackups, normalizeLegacyThinkingEfforts, parseCustomProvidersConfig, parseMinimaxApiConfig, parseModelContextLimits, } from './byok-config.js';
import { parseReviewConfig } from './review-config.js';
import { parseOpenCodeAdapterConfig } from './opencode-config.js';
import { ASR_DEFAULTS, parseAsrConfig } from './asr.js';
import { parsePermissionConfig } from './permission-config.js';
import { DEFAULT_SKILLS_CONFIG, parseSkillsConfig } from './skills-config.js';
import { DEFAULT_AGENT_RUNTIME_FRAMEWORK, parseAgentRuntimeConfig, } from './agent-runtime-config.js';
import { resolveDataDir } from './data-dir.js';
import { parseAgentsConfig } from './agent-capabilities.js';
import { ASK_USER_CONFIG_DEFAULTS, parseAskUserConfig, } from './ask-user-config.js';
import { DATA_CONTRIBUTION_CONFIG_DEFAULTS, parseDataContributionConfig, } from './data-contribution-config.js';
import { GOAL_CONFIG_DEFAULTS, parseGoalConfig } from './goal-config.js';
import { TOOL_RESULT_COMPACTION_DEFAULTS, parseToolResultCompactionConfig, } from './tool-result-compaction-config.js';
import { REQUEST_MEDIA_DEFAULTS, parseRequestMediaConfig, } from './request-media-config.js';
import { BROWSER_CONFIG_DEFAULTS, parseBrowserConfig, } from './browser-config.js';
import { parseSandboxConfig, SANDBOX_CONFIG_DEFAULTS, } from './sandbox-config.js';
import { parseSubagentConfig, SUBAGENT_CONFIG_DEFAULTS, } from './subagent-config.js';
export { MEMORY_V2_DEFAULTS } from './memory-config.js';
function isLegacyRuntimeEnvAllowed() {
    return process.env.__MAVIS_ALLOW_LEGACY_RUNTIME_ENV === '1';
}
// Electron loads the config package before local-runtime's managed-env
// bootstrap has copied the build-time NEXT_PUBLIC_* values into MAVIS_*.
// Keep this mapping local to config so the first (sticky) beta-flag read sees
// the packaged build environment. Electron's dev build uses the test runtime.
const ELECTRON_BUILD_ENV_TO_RUNTIME = {
    dev: 'test',
    test: 'test',
    staging: 'staging',
    prod: 'prod',
};
function isValidRuntimeRegion(value) {
    return value === 'cn' || value === 'en';
}
function isValidRuntimeBuildEnv(value) {
    return value === 'test' || value === 'prod' || value === 'dev' || value === 'staging';
}
export function getRuntimeRegion() {
    const val = process.env.MAVIS_REGION;
    if (isValidRuntimeRegion(val))
        return val;
    if (isElectronProcess()) {
        const locale = process.env.NEXT_PUBLIC_LOCALE;
        if (locale === 'zh')
            return 'cn';
        if (locale === 'en')
            return 'en';
    }
    return 'en';
}
export function getRuntimeBuildEnv() {
    const val = process.env.MAVIS_BUILD_ENV;
    if (isValidRuntimeBuildEnv(val))
        return val;
    if (isElectronProcess()) {
        const nextBuildEnv = process.env.NEXT_PUBLIC_BUILD_ENV;
        const mapped = nextBuildEnv &&
            Object.prototype.hasOwnProperty.call(ELECTRON_BUILD_ENV_TO_RUNTIME, nextBuildEnv)
            ? ELECTRON_BUILD_ENV_TO_RUNTIME[nextBuildEnv]
            : undefined;
        if (mapped)
            return mapped;
    }
    return 'dev';
}
/**
 * Whether this process is running inside the managed runtime (Electron app or
 * packaged desktop runtime).
 *
 * Detection priority:
 *   1. Explicit __MAVIS_RUNTIME_MANAGED env var ('1'/'0') — for overrides
 *      - '1': force-enable (e.g. `__MAVIS_RUNTIME_MANAGED=1 pnpm dev` to test C-end locally)
 *      - '0': force-disable (used by internal/no-safety Electron builds to opt out)
 *   2. Auto-detect Electron (main process or ELECTRON_RUN_AS_NODE=1 helpers)
 *   3. Auto-detect production build (MAVIS_BUILD_ENV=prod)
 *   4. Default: false (pnpm dev / npm package)
 *
 * C-end features (safety hooks, remote models, managed token injection,
 * remote skill hub) should ONLY activate when this returns true.
 */
export function isManagedRuntime() {
    if (hasCliFlag('managed'))
        return true;
    const explicit = process.env.__MAVIS_RUNTIME_MANAGED;
    if (explicit === '1')
        return true;
    if (explicit === '0')
        return false;
    if (isElectronProcess())
        return true;
    // Production builds always enable managed runtime
    if (getRuntimeBuildEnv() === 'prod' || getRuntimeBuildEnv() === 'staging')
        return true;
    return false;
}
function isElectronProcess() {
    const versions = process.versions;
    // ELECTRON_RUN_AS_NODE is kept for older helper subprocesses. The unified
    // local runtime runs inside Electron main and intentionally clears it.
    return process.env.ELECTRON_RUN_AS_NODE === '1' || typeof versions.electron === 'string';
}
export function getRuntimePresetKey() {
    return `${getRuntimeRegion()}-${getRuntimeBuildEnv()}`;
}
export { isProposalEligibleAgent, } from './skill-evolve-config.js';
export const VISIBILITY_RANK = {
    none: 0,
    test: 1,
    internal: 2,
    online: 3,
};
const BUILD_VARIANT_VISIBILITY = {
    internal: 'internal',
    inside: 'online',
};
/**
 * Fail fast when a feature's default rollout is wider than its opt-in ceiling.
 * Silently correcting this would hide a release-policy error and could expose a
 * feature to a broader channel than intended.
 */
export function assertBetaFeatureDefinitions(defs) {
    for (const [feature, def] of Object.entries(defs)) {
        if (VISIBILITY_RANK[def.defaultVisibility] > VISIBILITY_RANK[def.configurableVisibility]) {
            throw new Error(`Invalid beta feature definition "${feature}": defaultVisibility ` +
                `(${def.defaultVisibility}) must not exceed configurableVisibility ` +
                `(${def.configurableVisibility})`);
        }
        for (const variant of def.defaultBuildVariants ?? []) {
            const variantVisibility = BUILD_VARIANT_VISIBILITY[variant];
            if (VISIBILITY_RANK[variantVisibility] > VISIBILITY_RANK[def.configurableVisibility]) {
                throw new Error(`Invalid beta feature definition "${feature}": defaultBuildVariant ` +
                    `(${variant}) must not exceed configurableVisibility ` +
                    `(${def.configurableVisibility})`);
            }
        }
        for (const buildEnv of def.defaultBuildEnvironments ?? []) {
            const buildEnvVisibility = buildEnv === 'prod' ? 'online' : 'test';
            if (VISIBILITY_RANK[buildEnvVisibility] > VISIBILITY_RANK[def.configurableVisibility]) {
                throw new Error(`Invalid beta feature definition "${feature}": defaultBuildEnvironment ` +
                    `(${buildEnv}) must not exceed configurableVisibility ` +
                    `(${def.configurableVisibility})`);
            }
        }
    }
}
export const BETA_FEATURE_DEFS = {
    autoMemory: { defaultVisibility: 'online', configurableVisibility: 'online' },
    skillEvolve: { defaultVisibility: 'test', configurableVisibility: 'online' },
    skillEvolveBuiltinMr: { defaultVisibility: 'none', configurableVisibility: 'test' },
    skillProposal: { defaultVisibility: 'test', configurableVisibility: 'online' },
    browserBridge: { defaultVisibility: 'test', configurableVisibility: 'online' },
    filePanelBrowser: { defaultVisibility: 'online', configurableVisibility: 'online' },
    filePanelBrowserMultiTab: { defaultVisibility: 'online', configurableVisibility: 'online' },
    browserUseTooling: { defaultVisibility: 'online', configurableVisibility: 'online' },
    browserUseAutoOpenPanel: { defaultVisibility: 'online', configurableVisibility: 'online' },
    browserAgentCursor: { defaultVisibility: 'online', configurableVisibility: 'online' },
    desktopPlanMode: { defaultVisibility: 'online', configurableVisibility: 'online' },
    desktopPlanModeAgentEntry: { defaultVisibility: 'none', configurableVisibility: 'online' },
    peek: { defaultVisibility: 'test', configurableVisibility: 'test' },
    keepAlive: { defaultVisibility: 'test', configurableVisibility: 'test' },
    promptOverride: { defaultVisibility: 'test', configurableVisibility: 'test' },
    asr: { defaultVisibility: 'online', configurableVisibility: 'online' },
    taskHistoryProjectGrouping: { defaultVisibility: 'online', configurableVisibility: 'online' },
    threadGoal: { defaultVisibility: 'online', configurableVisibility: 'online' },
    mcodeTools: {
        defaultVisibility: 'none',
        defaultBuildEnvironments: ['dev', 'test', 'staging', 'prod'],
        defaultPlatforms: ['darwin', 'linux', 'win32'],
        configurableVisibility: 'online',
    },
    codexOAuth: {
        defaultVisibility: 'online',
        configurableVisibility: 'online',
    },
};
assertBetaFeatureDefinitions(BETA_FEATURE_DEFS);
function getBetaFeatureChannel(context) {
    const buildEnv = context.buildEnv ?? getRuntimeBuildEnv();
    if (buildEnv !== 'prod')
        return 'test';
    return context.internalBuild === true ? 'internal' : 'online';
}
// 变体默认值只看变体标志：internal 包的 buildEnv 是 staging（预发后端），但它仍是内部发布车道，
// 必须保留 internal 默认特性。inside 包的 buildEnv 仍是 prod。
function isDefaultEnabledForBuildVariant(def, context) {
    const variants = def.defaultBuildVariants;
    if (!variants)
        return false;
    return ((context.internalBuild === true && variants.includes('internal')) ||
        (context.insideBuild === true && variants.includes('inside')));
}
function isDefaultEnabledForBuildEnvironment(def, context) {
    const buildEnv = context.defaultBuildEnvironment ?? context.buildEnv ?? getBetaDefaultBuildEnvironment();
    return def.defaultBuildEnvironments?.includes(buildEnv) === true;
}
function getBetaDefaultBuildEnvironment() {
    const electronBuildEnv = isElectronProcess() ? process.env.NEXT_PUBLIC_BUILD_ENV : undefined;
    return isValidRuntimeBuildEnv(electronBuildEnv) ? electronBuildEnv : getRuntimeBuildEnv();
}
function isDefaultEnabledForPlatform(def, context) {
    return def.defaultPlatforms?.includes(context.platform ?? process.platform) !== false;
}
/**
 * Resolve every beta flag with one channel model. `defaultVisibility` controls
 * the channel rollout, exact build-environment/platform defaults narrow special
 * releases, `defaultBuildVariants` adds build-variant defaults independent of the
 * build environment, and `configurableVisibility` controls explicit opt-in.
 * Published-resource dev commands are explicit opt-ins; other environments
 * remain fail-closed. Inside builds map to online unless declared otherwise.
 */
export function resolveBetaFeature(feature, configured, context = {}) {
    const def = BETA_FEATURE_DEFS[feature];
    const channelRank = VISIBILITY_RANK[getBetaFeatureChannel(context)];
    const defaultBuildEnvironment = context.defaultBuildEnvironment ?? context.buildEnv ?? getBetaDefaultBuildEnvironment();
    if (feature === 'mcodeTools' &&
        defaultBuildEnvironment === 'dev' &&
        context.mcodeToolsDevMode === 'published' &&
        isDefaultEnabledForPlatform(def, context))
        return true;
    if (configured === false)
        return false;
    if (configured === true)
        return channelRank <= VISIBILITY_RANK[def.configurableVisibility];
    if (!isDefaultEnabledForPlatform(def, context))
        return false;
    if (isDefaultEnabledForBuildEnvironment(def, context))
        return true;
    if (isDefaultEnabledForBuildVariant(def, context))
        return true;
    return channelRank <= VISIBILITY_RANK[def.defaultVisibility];
}
/** @deprecated Prefer `resolveBetaFeature`; retained for CLI compatibility. */
export function isBetaFeatureProdReady(feature) {
    return BETA_FEATURE_DEFS[feature].configurableVisibility === 'online';
}
export function isInternalBuild(env = process.env) {
    return env.__MAVIS_BUILD_INTERNAL === 'true';
}
function isInsideBuild(env = process.env) {
    return env.__MAVIS_BUILD_INSIDE === 'true';
}
export { DATA_CONTRIBUTION_CONFIG_DEFAULTS, readDataContributionEnabled, } from './data-contribution-config.js';
// ---------------------------------------------------------------------------
// Brand constants — single source of truth for all brand-related strings.
// ---------------------------------------------------------------------------
export const BRAND = {
    /** Data directory basename (e.g. '.minimax'). */
    APP_DIR: '.minimax',
    /** Environment variable prefix (e.g. 'minimax'). */
    ENV_PREFIX: 'minimax',
    /** CLI binary name. */
    CLI_NAME: 'minimax',
};
/** Legacy runtime env prefix. New runtime identity travels via args/files. */
export const RUNTIME_ENV_PREFIX = '__MAVIS_RUNTIME';
/**
 * Read an internal runtime environment variable.
 * This lazy approach works correctly even when env vars are set after module load
 * (e.g., in test beforeEach hooks or dynamically by service managers).
 */
function runtimeEnv(suffix) {
    return isLegacyRuntimeEnvAllowed() ? process.env[`${RUNTIME_ENV_PREFIX}_${suffix}`] : undefined;
}
function cliArgValue(name) {
    const flag = `--${name}`;
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === flag)
            return process.argv[i + 1];
        if (arg?.startsWith(`${flag}=`))
            return arg.slice(flag.length + 1);
    }
    return undefined;
}
function hasCliFlag(name) {
    const flag = `--${name}`;
    return process.argv.slice(2).some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}
export const DEFAULT_PORT = 5321;
const DEFAULT_UI_PORT = 5001;
const MAX_TCP_PORT = 65535;
const GIT_AUTO_PORT_SLOT_COUNT = 500;
const GIT_AUTO_PORT_STRIDE = 2;
const MAX_GIT_AUTO_PORT_OFFSET = GIT_AUTO_PORT_SLOT_COUNT * GIT_AUTO_PORT_STRIDE;
export const OPENCODE_PORT_OFFSET = MAX_GIT_AUTO_PORT_OFFSET + GIT_AUTO_PORT_STRIDE;
const OPENCODE_FALLBACK_OFFSET = 1;
const REPO_NAMES = new Set(['agent-archon', 'mavis']);
// ---------------------------------------------------------------------------
// Git port / profile detection (inlined here to avoid tsx dual-module-instance
// issues that arise when importing across workspace package boundaries)
// ---------------------------------------------------------------------------
/** POSIX cksum CRC-32 table (polynomial 0x04C11DB7, big-endian) */
const CRC_TABLE = (() => {
    const POLY = 0x04c11db7;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i << 24;
        for (let j = 0; j < 8; j++) {
            c = (c & 0x80000000) !== 0 ? POLY ^ (c << 1) : c << 1;
            c >>>= 0;
        }
        table[i] = c >>> 0;
    }
    return table;
})();
/**
 * POSIX cksum on UTF-8(str + '\n'), matching `echo "$str" | cksum | awk '{print $1}'`
 */
function posixCksum(str) {
    const buf = Buffer.from(`${str}\n`, 'utf-8');
    let crc = 0;
    for (const byte of buf) {
        crc = (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ^ (crc << 8)) >>> 0;
    }
    let len = buf.length;
    while (len !== 0) {
        crc = (CRC_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff] ^ (crc << 8)) >>> 0;
        len >>>= 8;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function calcOffset(branchName) {
    // 500 slots with stride 2 (offsets: 2,4,6,...,1000).
    // Keep even offsets to preserve historically stable branch ports and leave
    // room for per-profile sidecars without collapsing adjacent assignments.
    return (posixCksum(branchName) % GIT_AUTO_PORT_SLOT_COUNT) * GIT_AUTO_PORT_STRIDE + 2;
}
function runGit(args, cwd) {
    try {
        const result = spawnSync('git', args, {
            encoding: 'utf-8',
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(cwd ? { cwd } : {}),
        });
        if (result.status === 0 && result.stdout)
            return result.stdout.trim();
        return null;
    }
    catch {
        return null;
    }
}
function parseRepoName(remoteUrl) {
    const match = remoteUrl.match(/[/:]([^/:]+?)(?:\.git)?$/);
    return match?.[1] ?? null;
}
function getExplicitPublicDataDirEnv() {
    return process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim();
}
function shouldUseGitAutoConfig() {
    if (hasCliFlag('disable-git-auto-config') || runtimeEnv('DISABLE_GIT_AUTO_CONFIG'))
        return false;
    if (cliArgValue('data-dir'))
        return false;
    if (getExplicitPublicDataDirEnv())
        return false;
    return true;
}
function getExplicitProfileEnv() {
    const profile = cliArgValue('profile') ?? runtimeEnv('PROFILE');
    return profile && profile.length > 0 ? profile : null;
}
function getExplicitPortEnv() {
    const explicitPort = cliArgValue('port') ?? runtimeEnv('PORT');
    const parsedExplicitPort = explicitPort ? parseInt(explicitPort, 10) : NaN;
    return Number.isNaN(parsedExplicitPort) ? null : parsedExplicitPort;
}
function getExplicitDataDirArg() {
    const dataDir = cliArgValue('data-dir') ?? getExplicitPublicDataDirEnv() ?? runtimeEnv('DATA_DIR');
    return dataDir && dataDir.length > 0 ? dataDir : null;
}
function shouldPreferExplicitDataDir() {
    return Boolean(getExplicitProfileEnv() && getExplicitDataDirArg());
}
function shouldPreferExplicitPort() {
    return Boolean(getExplicitProfileEnv() && getExplicitPortEnv() !== null);
}
let _gitCached = null;
/** Reset cached git detection result (for testing) */
export function resetGitDetect() {
    _gitCached = null;
}
/**
 * Detect port and profile from git branch name.
 * Any branch in the mavis repo gets a hash-based offset.
 * Default port 5321 is reserved for non-git / non-mavis environments.
 */
export function detectGitPortInfo() {
    if (_gitCached !== null)
        return _gitCached;
    const defaults = {
        runtimePort: DEFAULT_PORT,
        uiPort: DEFAULT_UI_PORT,
        profile: null,
        autoDetected: false,
    };
    // npm build: skip git detection entirely — always use default port 5321.
    // esbuild constant-folds this to `true`, eliminating the git spawn code.
    if (typeof __IS_NPM_BUILD__ !== 'undefined') {
        _gitCached = defaults;
        return defaults;
    }
    // Try to detect from process.cwd() first, then fall back to the directory
    // containing this config file. The fallback ensures correct detection when
    // a runtime helper starts from a wrong cwd — the config file is always
    // co-located with the source inside the git worktree.
    const candidateDirs = [
        undefined, // process.cwd() (default spawnSync behavior)
        currentModuleDir(),
    ];
    for (const cwd of candidateDirs) {
        try {
            const remoteUrl = runGit(['remote', 'get-url', 'origin'], cwd);
            if (!remoteUrl)
                continue;
            const repoName = parseRepoName(remoteUrl);
            if (!repoName || !REPO_NAMES.has(repoName))
                continue;
            const branch = runGit(['branch', '--show-current'], cwd);
            if (!branch)
                continue;
            const offset = calcOffset(branch);
            _gitCached = {
                runtimePort: DEFAULT_PORT + offset,
                uiPort: DEFAULT_UI_PORT + offset,
                profile: branch.replace(/\//g, '-'),
                autoDetected: true,
            };
            return _gitCached;
        }
        catch {
            // try next candidate
        }
    }
    _gitCached = defaults;
    return defaults;
}
function currentModuleDir() {
    try {
        if (typeof __dirname === 'string')
            return __dirname;
    }
    catch {
        /* ESM has no __dirname */
    }
    const stack = new Error().stack ?? '';
    for (const line of stack.split('\n')) {
        const fileUrl = /file:\/\/[^)\s]+/u.exec(line)?.[0]?.replace(/:\d+:\d+$/u, '');
        if (fileUrl) {
            try {
                return path.dirname(fileURLToPath(fileUrl));
            }
            catch {
                /* keep scanning */
            }
        }
        const filePath = /\(?((?:\/|[A-Za-z]:\\)[^()]+?\.(?:cjs|mjs|js|ts)):\d+:\d+\)?/u.exec(line)?.[1];
        if (filePath)
            return path.dirname(filePath);
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export function getProfile() {
    const profile = getExplicitProfileEnv();
    if (profile)
        return profile;
    if (!shouldUseGitAutoConfig())
        return null;
    return detectGitPortInfo().profile;
}
// ---------------------------------------------------------------------------
// Data directory resolution
// ---------------------------------------------------------------------------
export function getDataDir() {
    // Data-dir resolution priority (mirrors port resolution in getConfig):
    // 0. ${RUNTIME_ENV_PREFIX}_DISABLE_GIT_AUTO_CONFIG=1 → skip repo auto-detection entirely
    //    and fall back to the explicit env/default "user mode" resolution below.
    // 1. Explicit profile-scoped data dir (service/supervisor) → fixed data dir
    // 2. Git auto-detection (any branch in mavis repo) → profile-scoped dir
    //    This takes highest priority because the parent daemon process injects
    //    ${RUNTIME_ENV_PREFIX}_DATA_DIR into child process environments, which would
    //    incorrectly override the per-branch isolation that git detection provides.
    // 3. ${RUNTIME_ENV_PREFIX}_DATA_DIR env var → used only when git detection is not active
    // 4. ${RUNTIME_ENV_PREFIX}_PROFILE env var → manual profile override
    // 5. resolveDataDir() → non-git / non-mavis default data directory
    const explicitProfile = getExplicitProfileEnv();
    if (shouldPreferExplicitDataDir()) {
        return getExplicitDataDirArg();
    }
    if (shouldUseGitAutoConfig()) {
        const gitInfo = detectGitPortInfo();
        if (gitInfo.autoDetected && gitInfo.profile) {
            return resolveDataDir({ profile: gitInfo.profile });
        }
    }
    const explicitDataDir = getExplicitDataDirArg();
    if (explicitDataDir) {
        return explicitDataDir;
    }
    if (explicitProfile) {
        return resolveDataDir({ profile: explicitProfile });
    }
    return resolveDataDir();
}
export function getConfigPath() {
    return path.join(getDataDir(), 'config.yaml');
}
// ---------------------------------------------------------------------------
// Default provider presets per environment combo (MAVIS_REGION x MAVIS_BUILD_ENV)
// ---------------------------------------------------------------------------
const PRESET_BASE_URLS = {
    'cn-test': 'https://matrix-test.xaminim.com/mavis/api/v1/llm/v1',
    'cn-dev': 'https://matrix-test.xaminim.com/mavis/api/v1/llm/v1',
    'cn-staging': 'https://matrix-pre.xaminim.com/mavis/api/v1/llm/v1',
    'en-test': 'https://matrix-overseas-test.xaminim.com/mavis/api/v1/llm/v1',
    'en-dev': 'https://matrix-overseas-test.xaminim.com/mavis/api/v1/llm/v1',
    'en-staging': 'https://matrix-overseas-pre.xaminim.com/mavis/api/v1/llm/v1',
    'cn-prod': 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
    'en-prod': 'https://agent.minimax.io/mavis/api/v1/llm/v1',
};
const LEGACY_MANAGED_PRESET_BASE_URLS = ['https://agent.minimaxi.com/mavis/api/v1/llm/v1'];
const MANAGED_PRESET_BASE_URLS = new Set([
    ...Object.values(PRESET_BASE_URLS),
    ...LEGACY_MANAGED_PRESET_BASE_URLS,
]);
const MANAGED_PRESET_ORIGINS = new Set([...Object.values(PRESET_BASE_URLS), ...LEGACY_MANAGED_PRESET_BASE_URLS].map((baseURL) => new URL(baseURL).origin));
function isManagedPresetBaseUrl(baseURL) {
    if (MANAGED_PRESET_BASE_URLS.has(baseURL))
        return true;
    try {
        const parsed = new URL(baseURL);
        return !parsed.username && !parsed.password && MANAGED_PRESET_ORIGINS.has(parsed.origin);
    }
    catch {
        return false;
    }
}
/** Test desktop builds may route the builtin managed MiniMax provider through a local fault proxy. */
export function allowsManagedMinimaxProviderOverride() {
    return getRuntimeBuildEnv() === 'test';
}
function shouldEnforceManagedProviderProtection() {
    return !allowsManagedMinimaxProviderOverride();
}
function syncManagedPresetBaseUrl(configPath) {
    if (!isManagedRuntime() || !fs.existsSync(configPath)) {
        return;
    }
    const raw = readConfigFile(configPath);
    const { provider } = raw;
    if (provider == null || typeof provider !== 'object' || Array.isArray(provider))
        return;
    const { minimax } = provider;
    if (minimax == null || typeof minimax !== 'object' || Array.isArray(minimax))
        return;
    const { options } = minimax;
    if (options == null || typeof options !== 'object' || Array.isArray(options))
        return;
    const currentBaseURL = options.baseURL;
    if (typeof currentBaseURL !== 'string')
        return;
    const presetBaseURL = PRESET_BASE_URLS[getRuntimePresetKey()];
    if (currentBaseURL === presetBaseURL || !isManagedPresetBaseUrl(currentBaseURL))
        return;
    const originalContent = fs.readFileSync(configPath);
    options.baseURL = presetBaseURL;
    try {
        // `originalContent` is the byte-level snapshot the integrity check below
        // compares against, so the document has to be serialized from those same
        // bytes: read the text once and diff against its parse.
        const originalText = originalContent.toString('utf-8');
        writePrivateConfigFileSync(configPath, serializeConfigPreservingComments(originalText, parseConfigText(originalText), raw));
    }
    catch (error) {
        // This on-disk sync is optional, but a failure after truncation is not safe
        // to hide. Only continue when the original document is still intact.
        let unchanged = false;
        try {
            unchanged = fs.readFileSync(configPath).equals(originalContent);
        }
        catch {
            // Preserve the original write error if integrity cannot be verified.
        }
        if (!unchanged)
            throw error;
        // Do not include the error message: config errors may contain credentials.
        console.warn('[config] managed preset baseURL sync skipped; config file unchanged, using runtime provider settings');
    }
}
function buildPresetEntry(key) {
    const provider = {
        name: 'MiniMax',
        npm: '@ai-sdk/anthropic',
        options: {
            authMode: 'managed-login',
            apiKey: 'sk-xxx',
            baseURL: PRESET_BASE_URLS[key],
        },
        models: MINIMAX_MODELS,
    };
    return {
        provider: { minimax: provider },
        defaultModel: `minimax/${MINIMAX_FIRST_RUN_DEFAULT_MODEL_ID}`,
    };
}
export const DEFAULT_MODEL_PRESETS = {
    'cn-test': buildPresetEntry('cn-test'),
    'cn-dev': buildPresetEntry('cn-dev'),
    'cn-staging': buildPresetEntry('cn-staging'),
    'cn-prod': buildPresetEntry('cn-prod'),
    'en-test': buildPresetEntry('en-test'),
    'en-dev': buildPresetEntry('en-dev'),
    'en-staging': buildPresetEntry('en-staging'),
    'en-prod': buildPresetEntry('en-prod'),
};
const DEFAULTS = {
    logLevel: 'info',
    devPort: DEFAULT_UI_PORT,
    permissionMode: 'auto',
    skipWindowsHardSafetyChecks: false,
    skipParentDeathGuard: false,
    sseErrorPush: {
        history: true,
        stream: true,
    },
    beta: Object.fromEntries(Object.keys(BETA_FEATURE_DEFS).map((key) => [
        key,
        resolveBetaFeature(key, undefined, { buildEnv: 'dev' }),
    ])),
    agents: { default: {} },
    memory: {
        // 已有配置缺少此字段时保留历史行为；新安装由 ensureConfigFile 显式关闭。
        enabled: true,
        proactive: false,
        dailyDigest: {
            enabled: false,
        },
        v2: { ...MEMORY_V2_DEFAULTS },
    },
    subagent: { ...SUBAGENT_CONFIG_DEFAULTS },
    skillEvolve: {
        enabled: true,
        inSession: {
            N: 20,
            minIntervalSeconds: 30,
            maxPendingPerSession: 1,
        },
        signalCooldownHours: 24,
        minConfidence: 0.7,
        excludeAgents: ['skill-editor'],
        disableModelPrefixes: ['MiniMax-M2'],
        builtinMrEnabled: false,
        sourceRepo: undefined,
        proposal: {
            enabled: false,
            eligibleAgents: ['mavis'],
            minMessageCount: 40,
            skipPassiveSessionEnd: true,
        },
        lifecycle: { staleThresholdDays: 15, archiveThresholdDays: 30 }, // tightened from legacy 30d/90d
    },
    sessionRotate: {
        enabled: true,
        activeSessionLookbackHours: 12,
    },
    agentStop: {
        debounceMs: 500,
        maxActiveSpanMs: 30 * 60 * 1000, // 30 min
    },
    asr: { ...ASR_DEFAULTS }, // Cloud ASR master switch only. Seed / Qwen client providers and their WS bridge were retired; Amadeus uses the authenticated HTTP+SSE proxy from Web/Electron. Legacy `asr.mode` / `asr.proxyBaseUrl` / `asr.primaryProvider` / `asr.fallbackProvider` / `asr.{seed,qwen}.*` are dropped on parse with a warn.
    skills: DEFAULT_SKILLS_CONFIG,
    askUser: { ...ASK_USER_CONFIG_DEFAULTS },
    dataContribution: { ...DATA_CONTRIBUTION_CONFIG_DEFAULTS },
    sessionTitle: {
        // Default ON. See `SessionTitleConfig`.
        enabled: true,
    },
    promptSuggestion: {
        // Explicit opt-in because this performs one additional model request.
        enabled: false,
    },
    cli: {
        spawn: {
            enabled: false,
        },
    },
    browser: { ...BROWSER_CONFIG_DEFAULTS },
    // No status line items by default: the TUI picks its build-specific default
    // when `tui.statusLine` is absent.
    tui: {},
    opencode: {
        xdg: {
            dataIsolation: false,
            startupImport: 'off',
        },
        keepAlive: {
            enabled: false,
            maxProcesses: 5,
            maxLifetimeMs: 28_800_000,
            agents: ['mavis', 'main', 'verifier', 'code-reviewer'],
        },
        spawnConcurrency: 3,
    },
    contextManagement: {
        disableSystemReminderModels: [],
        cuMaxScreenshotsInContext: 2,
    },
    runawayGuard: { enabled: true },
    toolResultCompaction: { ...TOOL_RESULT_COMPACTION_DEFAULTS },
    requestMedia: { ...REQUEST_MEDIA_DEFAULTS },
    agentRuntime: {
        // Single source of truth lives in `./agent-runtime-config.ts` so the
        // default and the union type cannot drift.
        defaultFramework: DEFAULT_AGENT_RUNTIME_FRAMEWORK,
    },
    logRetentionDays: 3,
    worktreeRefreshBeforeCreate: true,
    review: {
        mode: 'subagent',
        turnDiffCard: 'concise',
        modeSource: 'default',
    },
    goal: structuredClone(GOAL_CONFIG_DEFAULTS),
    sandbox: structuredClone(SANDBOX_CONFIG_DEFAULTS),
    goalWarnings: [],
};
function ensureConfigFile() {
    const configPath = getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(configPath)) {
        prepareConfigFileForRead(configPath);
        return;
    }
    // In non-managed runtime (pnpm dev / npm package), the UI onboarding flow
    // owns config.yaml generation — it walks the user through getting an API
    // key and writes the file. Daemon must NOT pre-seed a placeholder here,
    // otherwise the UI flow has no way to know whether the user has actually
    // configured anything.
    //
    // However, when a worktree daemon starts with a derived dataDir (e.g.
    // <dataDir>-feature-foo/), the developer's API keys live in the default
    // dataDir (<dataDir>/config.yaml). Copy it over so the worktree daemon
    // inherits the existing configuration.
    if (!isManagedRuntime()) {
        const defaultDataDir = resolveDataDir({ homeDir: os.homedir() });
        const defaultConfigPath = path.join(defaultDataDir, 'config.yaml');
        if (configPath !== defaultConfigPath && fs.existsSync(defaultConfigPath)) {
            restrictConfigFileSync(defaultConfigPath);
            writePrivateConfigFileSync(configPath, fs.readFileSync(defaultConfigPath), true);
        }
        return;
    }
    const preset = DEFAULT_MODEL_PRESETS[getRuntimePresetKey()];
    const content = yaml.dump({
        logLevel: DEFAULTS.logLevel,
        provider: managedPresetBaseUrlSyncEnabled ? preset.provider : undefined,
        defaultModel: preset.defaultModel,
        // 首装即写出 "数据用于优化体验" 开关，让 Desktop / TUI 全新安装都有一份可见、
        // 可编辑的显式默认值(开启),而不是隐式依赖 `DEFAULTS`。只写 `enabled`——
        // `enabledSource` 是解析时生成的,落进文件只会变成一个没人读的死字段。
        dataContribution: { enabled: DATA_CONTRIBUTION_CONFIG_DEFAULTS.enabled },
        // 仅新安装写入，避免改变已有用户缺省开启的选择。
        memory: { enabled: false },
        // 首装写出可编辑的安全默认值；已有文件不补写、不覆盖用户选择。
        skipWindowsHardSafetyChecks: DEFAULTS.skipWindowsHardSafetyChecks,
        skipParentDeathGuard: DEFAULTS.skipParentDeathGuard,
    });
    writePrivateConfigFileSync(configPath, content, true);
}
function readConfigFile(configPath = getConfigPath()) {
    return parseConfigText(readConfigFileText(configPath));
}
function readConfigFileText(configPath = getConfigPath()) {
    try {
        return fs.readFileSync(configPath, 'utf-8');
    }
    catch {
        return '';
    }
}
let _cached = null;
function parseStartupRecoveryFault(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const step = Reflect.get(raw, 'step');
    const mode = Reflect.get(raw, 'mode');
    if (typeof step !== 'string' || (mode !== 'hang' && mode !== 'fail'))
        return {};
    return { startupRecoveryFault: { step, mode } };
}
function parseNotificationsConfig(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const obj = raw;
    return {
        branchFinish: typeof obj.branchFinish === 'boolean' ? obj.branchFinish : false,
    };
}
// ── BYOK config parsing + required provider overrides: see ./byok-config.ts ──
const REQUIRED_PROVIDER_OVERRIDE_DEPS = {
    isManagedRuntime,
    shouldEnforceManagedProviderProtection,
    getManagedPreset: () => DEFAULT_MODEL_PRESETS[getRuntimePresetKey()],
    isManagedPresetBaseUrl,
};
let legacyByokProviderMigrationEnabled = true;
let managedPresetBaseUrlSyncEnabled = true;
export function setLegacyByokProviderMigrationEnabled(enabled) {
    legacyByokProviderMigrationEnabled = enabled;
}
/** Hosts sharing config with older clients can use the current preset without persisting it. */
export function setManagedPresetBaseUrlSyncEnabled(enabled) {
    managedPresetBaseUrlSyncEnabled = enabled;
}
export function prepareConfigFileForRead(configPath) {
    restrictConfigFileSync(configPath);
    restrictLegacyByokBackups(configPath);
    if (legacyByokProviderMigrationEnabled) {
        migrateLegacyByokProvidersOnDisk(configPath, REQUIRED_PROVIDER_OVERRIDE_DEPS);
    }
    if (managedPresetBaseUrlSyncEnabled)
        syncManagedPresetBaseUrl(configPath);
}
export function resetConfig() {
    _cached = null;
}
export function getConfig() {
    if (_cached)
        return _cached;
    ensureConfigFile();
    const raw = readConfigFile();
    _cached = resolveConfigFromRaw(raw, getDataDir());
    return _cached;
}
export function resolveConfigFromRaw(raw, dataDir) {
    const rawSSEErrorPush = raw.sseErrorPush;
    const sseErrorPush = rawSSEErrorPush != null &&
        typeof rawSSEErrorPush === 'object' &&
        !Array.isArray(rawSSEErrorPush)
        ? rawSSEErrorPush
        : undefined;
    // devPort resolution (kept in Config for UI dev server)
    let devPort = typeof raw.devPort === 'number' ? raw.devPort : DEFAULTS.devPort;
    if (shouldUseGitAutoConfig() && !shouldPreferExplicitPort()) {
        const gitInfo = detectGitPortInfo();
        if (gitInfo.autoDetected) {
            devPort = gitInfo.uiPort;
        }
    }
    const goalParsed = parseGoalConfig(raw.goal);
    const managedProvider = applyRequiredProviderOverrides({
        provider: raw.provider != null && typeof raw.provider === 'object' && !Array.isArray(raw.provider)
            ? normalizeLegacyThinkingEfforts(raw.provider)
            : {},
        defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
    }, REQUIRED_PROVIDER_OVERRIDE_DEPS);
    const minimaxModelContextLimits = parseModelContextLimits(raw.minimaxModelContextLimits);
    const beta = parseBetaConfig(raw);
    return {
        logLevel: typeof raw.logLevel === 'string' ? raw.logLevel : DEFAULTS.logLevel,
        devPort,
        ...managedProvider,
        provider: applyManagedMinimaxContextLimits(managedProvider.provider, minimaxModelContextLimits),
        defaultModelVariant: typeof raw.defaultModelVariant === 'string' ? raw.defaultModelVariant : undefined,
        defaultModelThinking: raw.defaultModelThinking &&
            typeof raw.defaultModelThinking === 'object' &&
            typeof raw.defaultModelThinking.effort === 'string'
            ? { effort: raw.defaultModelThinking.effort }
            : undefined,
        defaultModelContextWindow: Number.isSafeInteger(raw.defaultModelContextWindow) &&
            Number(raw.defaultModelContextWindow) > 0 &&
            Number(raw.defaultModelContextWindow) <= 2_147_483_647
            ? Number(raw.defaultModelContextWindow)
            : undefined,
        minimax_api: parseMinimaxApiConfig(raw.minimax_api),
        minimaxModelContextLimits,
        custom_provider: parseCustomProvidersConfig(raw.custom_provider),
        minimaxModelSource: typeof raw.minimaxModelSource === 'string' &&
            (raw.minimaxModelSource === 'token_plan' || raw.minimaxModelSource === 'minimax_api_key')
            ? raw.minimaxModelSource
            : undefined,
        nexus: raw.nexus != null && typeof raw.nexus === 'object' && !Array.isArray(raw.nexus)
            ? (() => {
                const parsed = {};
                if (typeof Reflect.get(raw.nexus, 'enabled') === 'boolean') {
                    parsed.enabled = Reflect.get(raw.nexus, 'enabled');
                }
                const rawModel = Reflect.get(raw.nexus, 'model');
                if (rawModel != null &&
                    typeof rawModel === 'object' &&
                    !Array.isArray(rawModel) &&
                    typeof Reflect.get(rawModel, 'providerID') === 'string' &&
                    typeof Reflect.get(rawModel, 'modelID') === 'string') {
                    parsed.model = {
                        providerID: Reflect.get(rawModel, 'providerID'),
                        modelID: Reflect.get(rawModel, 'modelID'),
                        ...(typeof Reflect.get(rawModel, 'variant') === 'string'
                            ? {
                                variant: Reflect.get(rawModel, 'variant'),
                            }
                            : {}),
                    };
                }
                return Object.keys(parsed).length > 0 ? parsed : undefined;
            })()
            : undefined,
        defaultLightModel: typeof raw.defaultLightModel === 'string' ? raw.defaultLightModel : undefined,
        skipWindowsHardSafetyChecks: raw.skipWindowsHardSafetyChecks === true,
        skipParentDeathGuard: raw.skipParentDeathGuard === true,
        ...parseStartupRecoveryFault(raw.startupRecoveryFault),
        permissionMode: typeof raw.permissionMode === 'string' &&
            ['default', 'bypassPermissions', 'auto', 'off'].includes(raw.permissionMode)
            ? raw.permissionMode
            : DEFAULTS.permissionMode,
        permission: parsePermissionConfig(raw),
        sseErrorPush: {
            history: typeof sseErrorPush?.history === 'boolean'
                ? sseErrorPush.history
                : DEFAULTS.sseErrorPush.history,
            stream: typeof sseErrorPush?.stream === 'boolean'
                ? sseErrorPush.stream
                : DEFAULTS.sseErrorPush.stream,
        },
        notifications: parseNotificationsConfig(raw.notifications),
        dataDir,
        agentsDir: path.join(dataDir, 'agents'),
        sessionsDir: path.join(dataDir, 'sessions'),
        memoryDir: path.join(dataDir, 'memory'),
        skillsDir: path.join(dataDir, 'skills'),
        builtinSkillsDir: path.join(dataDir, '.builtin-skills'),
        logsDir: path.join(dataDir, 'logs'),
        pluginsDir: path.join(dataDir, 'plugins'),
        plansDir: path.join(dataDir, 'plans'),
        harnessesDir: path.join(dataDir, 'harnesses'),
        subAgentsDir: path.join(dataDir, 'subagents'),
        beta,
        agents: parseAgentsConfig(raw.agents),
        // 构建变体在模块加载后注入，默认值随配置解析计算。
        memory: parseMemoryConfig(raw, resolveMemoryDefaults(DEFAULTS.memory, isInternalBuild() || isInsideBuild())),
        subagent: parseSubagentConfig(raw.subagent),
        skillEvolve: parseSkillEvolveConfig(raw, beta),
        sessionRotate: parseSessionRotateConfig(raw),
        agentStop: parseAgentStopDetectorConfig(raw),
        asr: parseAsrConfig(raw),
        skills: parseSkillsConfig(raw),
        askUser: parseAskUserConfig(raw, DEFAULTS.askUser),
        dataContribution: parseDataContributionConfig(raw, DEFAULTS.dataContribution),
        sessionTitle: parseSessionTitleConfig(raw),
        promptSuggestion: parsePromptSuggestionConfig(raw),
        cli: parseCliConfig(raw),
        browser: parseBrowserConfig(raw.browser),
        tui: parseTuiConfig(raw),
        opencode: parseOpenCodeAdapterConfig(raw, DEFAULTS.opencode),
        contextManagement: parseContextManagementConfig(raw),
        runawayGuard: resolveRunawayGuardConfig(raw.runawayGuard),
        toolResultCompaction: parseToolResultCompactionConfig(raw.toolResultCompaction),
        requestMedia: parseRequestMediaConfig(raw.requestMedia),
        agentRuntime: parseAgentRuntimeConfig(raw.agentRuntime),
        logRetentionDays: parseLogRetentionDays(raw),
        contentReview: parseContentReviewConfig(raw),
        mcpToolSearch: parseMcpToolSearchConfig(raw),
        review: parseReviewConfig(raw.review, DEFAULTS.review),
        worktreeRefreshBeforeCreate: raw.worktreeRefreshBeforeCreate !== false,
        promptConfig: resolvePromptConfig(raw.promptConfig),
        goal: goalParsed.config,
        goalWarnings: goalParsed.warnings,
        sandbox: parseSandboxConfig(raw.sandbox),
    };
}
// ── Beta features config parsing ────────────────────────────────
function parseBetaConfig(raw) {
    const obj = raw.beta != null && typeof raw.beta === 'object' && !Array.isArray(raw.beta)
        ? raw.beta
        : {};
    const context = {
        buildEnv: getRuntimeBuildEnv(),
        defaultBuildEnvironment: getBetaDefaultBuildEnvironment(),
        internalBuild: isInternalBuild(),
        insideBuild: isInsideBuild(),
        mcodeToolsDevMode: process.env.MAVIS_DEV_MCODE_TOOLS_MODE === 'published' ? 'published' : undefined,
    };
    const result = {};
    for (const key of Object.keys(BETA_FEATURE_DEFS)) {
        result[key] = resolveBetaFeature(key, obj[key], context);
    }
    return result;
}
// ── Skill Evolve config parsing ─────────────────────────────────
/**
 * Collect all model IDs from the provider config.
 * Returns an empty array when no models are configured.
 */
function collectModelIds(raw) {
    const providerRaw = raw.provider;
    if (providerRaw == null || typeof providerRaw !== 'object' || Array.isArray(providerRaw)) {
        return [];
    }
    const ids = [];
    for (const prov of Object.values(providerRaw)) {
        if (prov == null || typeof prov !== 'object' || Array.isArray(prov))
            continue;
        const { models } = prov;
        if (models == null || typeof models !== 'object' || Array.isArray(models))
            continue;
        ids.push(...Object.keys(models));
    }
    return ids;
}
/**
 * Auto-derive the `skillEvolve.enabled` flag from the configured model list.
 *
 * When **every** configured model ID starts with one of the
 * `disableModelPrefixes` (case-insensitive), skill-evolve has no capable
 * model to work with, so it is disabled automatically.
 * If at least one model does NOT match, the feature is enabled.
 *
 * Edge cases: no providers / no models configured → `false`
 * (no capable model means the feature cannot operate).
 */
function deriveSkillEvolveEnabled(raw, disableModelPrefixes) {
    if (disableModelPrefixes.length === 0)
        return true;
    const modelIds = collectModelIds(raw);
    if (modelIds.length === 0)
        return false;
    const lowerPrefixes = disableModelPrefixes.map((p) => p.toLowerCase());
    return !modelIds.every((id) => lowerPrefixes.some((p) => id.toLowerCase().startsWith(p)));
}
function parsePositiveDays(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function parseSkillEvolveConfig(raw, betaConfig) {
    const defaults = DEFAULTS.skillEvolve;
    const se = raw.skillEvolve;
    const hasSection = se != null && typeof se === 'object' && !Array.isArray(se);
    const obj = hasSection ? se : {};
    const inSessionRaw = obj.inSession;
    let { inSession } = defaults;
    if (inSessionRaw != null && typeof inSessionRaw === 'object' && !Array.isArray(inSessionRaw)) {
        const ins = inSessionRaw;
        inSession = {
            N: typeof ins.N === 'number' && ins.N > 0 ? ins.N : defaults.inSession.N,
            minIntervalSeconds: typeof ins.minIntervalSeconds === 'number' && ins.minIntervalSeconds >= 0
                ? ins.minIntervalSeconds
                : defaults.inSession.minIntervalSeconds,
            maxPendingPerSession: typeof ins.maxPendingPerSession === 'number' && ins.maxPendingPerSession >= 1
                ? ins.maxPendingPerSession
                : defaults.inSession.maxPendingPerSession,
        };
    }
    const excludeRaw = obj.excludeAgents;
    const excludeAgents = Array.isArray(excludeRaw) && excludeRaw.every((e) => typeof e === 'string')
        ? excludeRaw
        : defaults.excludeAgents;
    const disableModelPrefixes = Array.isArray(obj.disableModelPrefixes) &&
        obj.disableModelPrefixes.every((e) => typeof e === 'string')
        ? obj.disableModelPrefixes
        : defaults.disableModelPrefixes;
    // `enabled` — beta gate wins first; then explicit config; then auto-derive from model list.
    const enabled = !betaConfig.skillEvolve
        ? false
        : typeof obj.enabled === 'boolean'
            ? obj.enabled
            : deriveSkillEvolveEnabled(raw, disableModelPrefixes);
    // `builtinMrEnabled` — beta gate wins first; then explicit config; then default.
    // Implicitly false when the parent `enabled` is false (no point evolving built-ins
    // when the pipeline as a whole is off).
    const builtinMrEnabled = !enabled
        ? false
        : !betaConfig.skillEvolveBuiltinMr
            ? false
            : typeof obj.builtinMrEnabled === 'boolean'
                ? obj.builtinMrEnabled
                : defaults.builtinMrEnabled;
    const sourceRepoRaw = obj.sourceRepo;
    const sourceRepo = typeof sourceRepoRaw === 'string' && sourceRepoRaw.trim().length > 0
        ? sourceRepoRaw.trim()
        : defaults.sourceRepo;
    // v3: `proposal` — beta gate + parent gate must both be true; otherwise
    // resolved sub-config still parses but `enabled` is forced false. Other
    // fields (eligibleAgents, minMessageCount, skipPassiveSessionEnd) are
    // honored even when the gate is off so operators can pre-stage config.
    const proposalRaw = obj.proposal;
    const proposalDefaults = defaults.proposal;
    const proposalObj = proposalRaw != null && typeof proposalRaw === 'object' && !Array.isArray(proposalRaw)
        ? proposalRaw
        : {};
    const proposalEligibleAgents = Array.isArray(proposalObj.eligibleAgents) &&
        proposalObj.eligibleAgents.every((e) => typeof e === 'string')
        ? proposalObj.eligibleAgents
        : proposalDefaults.eligibleAgents;
    const proposalMinMessageCount = typeof proposalObj.minMessageCount === 'number' && proposalObj.minMessageCount >= 1
        ? Math.floor(proposalObj.minMessageCount)
        : proposalDefaults.minMessageCount;
    const proposalSkipPassiveSessionEnd = typeof proposalObj.skipPassiveSessionEnd === 'boolean'
        ? proposalObj.skipPassiveSessionEnd
        : proposalDefaults.skipPassiveSessionEnd;
    const proposalEnabledExplicit = typeof proposalObj.enabled === 'boolean' ? proposalObj.enabled : null;
    const proposalEnabled = !enabled
        ? false
        : !betaConfig.skillProposal
            ? false
            : (proposalEnabledExplicit ?? true);
    // `lifecycle` — strict invariant stale < archive (fail-fast at boot).
    const lcRaw = obj.lifecycle;
    const lc = lcRaw && typeof lcRaw === 'object' && !Array.isArray(lcRaw)
        ? lcRaw
        : {};
    const staleThresholdDays = parsePositiveDays(lc.staleThresholdDays, defaults.lifecycle.staleThresholdDays); // prettier-ignore
    const archiveThresholdDays = parsePositiveDays(lc.archiveThresholdDays, defaults.lifecycle.archiveThresholdDays); // prettier-ignore
    if (!(staleThresholdDays < archiveThresholdDays)) {
        throw new Error(`Invalid skillEvolve.lifecycle config: staleThresholdDays (${staleThresholdDays}) must be strictly less than archiveThresholdDays (${archiveThresholdDays}).`);
    }
    return {
        enabled,
        inSession,
        signalCooldownHours: typeof obj.signalCooldownHours === 'number' && obj.signalCooldownHours > 0
            ? obj.signalCooldownHours
            : defaults.signalCooldownHours,
        minConfidence: typeof obj.minConfidence === 'number' && obj.minConfidence >= 0 && obj.minConfidence <= 1
            ? obj.minConfidence
            : defaults.minConfidence,
        scannerModel: typeof obj.scannerModel === 'string' ? obj.scannerModel : undefined,
        excludeAgents,
        disableModelPrefixes,
        builtinMrEnabled,
        sourceRepo,
        proposal: {
            enabled: proposalEnabled,
            eligibleAgents: proposalEligibleAgents,
            minMessageCount: proposalMinMessageCount,
            skipPassiveSessionEnd: proposalSkipPassiveSessionEnd,
        },
        lifecycle: { staleThresholdDays, archiveThresholdDays },
    };
}
/**
 * v3 helper: `isProposalEligibleAgent` lives in `./skill-evolve-config.ts`
 * — re-exported above with the rest of the SkillEvolve types.
 */
// ── Session Rotate config parsing ───────────────────────────────
function parseSessionRotateConfig(raw) {
    const defaults = DEFAULTS.sessionRotate;
    const sr = raw.sessionRotate;
    if (sr == null || typeof sr !== 'object' || Array.isArray(sr))
        return { ...defaults };
    const obj = sr;
    const rawLookback = obj.activeSessionLookbackHours;
    return {
        enabled: typeof obj.enabled === 'boolean' ? obj.enabled : defaults.enabled,
        activeSessionLookbackHours: typeof rawLookback === 'number' && Number.isFinite(rawLookback) && rawLookback > 0
            ? rawLookback
            : defaults.activeSessionLookbackHours,
    };
}
// ── AgentStop detector config parsing ───────────────────────────
function parseAgentStopDetectorConfig(raw) {
    const defaults = DEFAULTS.agentStop;
    const obj = raw.agentStop;
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        return { ...defaults };
    }
    const o = obj;
    const rawDebounce = o.debounceMs;
    const rawSpan = o.maxActiveSpanMs;
    // `0` is a meaningful operator opt-out for both knobs (no debounce, no
    // active-span backstop). Reject negatives / non-finite values back to
    // defaults so a malformed config can't silently disable the detector.
    return {
        debounceMs: typeof rawDebounce === 'number' && Number.isFinite(rawDebounce) && rawDebounce >= 0
            ? rawDebounce
            : defaults.debounceMs,
        maxActiveSpanMs: typeof rawSpan === 'number' && Number.isFinite(rawSpan) && rawSpan >= 0
            ? rawSpan
            : defaults.maxActiveSpanMs,
    };
}
export function resolvePromptConfig(obj) {
    // 启动环境在模块加载后完成注入，默认值随配置解析计算。
    const defaultAutoUpdate = getRuntimeBuildEnv() === 'prod' && !isInternalBuild();
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
        return { autoUpdate: defaultAutoUpdate };
    }
    const rawAutoUpdate = obj.autoUpdate;
    return {
        autoUpdate: typeof rawAutoUpdate === 'boolean' ? rawAutoUpdate : defaultAutoUpdate,
    };
}
// ── session title config parsing ────────────────────────────────
function parseSessionTitleConfig(raw) {
    const defaults = DEFAULTS.sessionTitle;
    const rawSessionTitle = raw.sessionTitle;
    if (rawSessionTitle == null ||
        typeof rawSessionTitle !== 'object' ||
        Array.isArray(rawSessionTitle)) {
        return { ...defaults };
    }
    const obj = rawSessionTitle;
    return {
        enabled: typeof obj.enabled === 'boolean' ? obj.enabled : defaults.enabled,
    };
}
// ── prompt suggestion config parsing ────────────────────────────
function parsePromptSuggestionConfig(raw) {
    const value = raw.promptSuggestion;
    const enabled = value != null && typeof value === 'object' && !Array.isArray(value)
        ? value.enabled
        : undefined;
    // Internal builds dogfood the feature, so an unset value means on there; an
    // explicit `false` still wins. Resolved at parse time, like `promptConfig`.
    const defaultEnabled = DEFAULTS.promptSuggestion.enabled || isInternalBuild();
    return typeof enabled === 'boolean'
        ? { enabled, enabledSource: 'explicit' }
        : { enabled: defaultEnabled, enabledSource: 'default' };
}
// ── CLI config parsing ──────────────────────────────────────────
function parseCliConfig(raw) {
    const defaults = DEFAULTS.cli;
    const rawCli = raw.cli;
    if (rawCli == null || typeof rawCli !== 'object' || Array.isArray(rawCli)) {
        return { spawn: { ...defaults.spawn } };
    }
    const rawSpawn = rawCli.spawn;
    if (rawSpawn == null || typeof rawSpawn !== 'object' || Array.isArray(rawSpawn)) {
        return { spawn: { ...defaults.spawn } };
    }
    const spawnObj = rawSpawn;
    return {
        spawn: {
            enabled: typeof spawnObj.enabled === 'boolean' ? spawnObj.enabled : defaults.spawn.enabled,
        },
    };
}
// ── Context Management config parsing ───────────────────────────
function parseContextManagementConfig(raw) {
    const defaults = DEFAULTS.contextManagement;
    const rawCm = raw.contextManagement;
    if (rawCm == null || typeof rawCm !== 'object' || Array.isArray(rawCm)) {
        return {
            disableSystemReminderModels: [...defaults.disableSystemReminderModels],
            cuMaxScreenshotsInContext: defaults.cuMaxScreenshotsInContext,
        };
    }
    const obj = rawCm;
    const rawList = obj.disableSystemReminderModels;
    const disableSystemReminderModels = Array.isArray(rawList) && rawList.every((e) => typeof e === 'string' && e.length > 0)
        ? rawList
        : [...defaults.disableSystemReminderModels];
    const rawCuMax = obj.cuMaxScreenshotsInContext;
    const cuMaxScreenshotsInContext = typeof rawCuMax === 'number' && Number.isFinite(rawCuMax) && rawCuMax >= 0
        ? Math.floor(rawCuMax)
        : defaults.cuMaxScreenshotsInContext;
    // Semantic validation (ratio vs. token count) lives with the trigger in
    // @mavis/context-manager; keep numbers so the runtime can warn on bad ones.
    const compactionTriggerAt = typeof obj.compactionTriggerAt === 'number' ? obj.compactionTriggerAt : undefined;
    return {
        disableSystemReminderModels,
        cuMaxScreenshotsInContext,
        ...(compactionTriggerAt === undefined ? {} : { compactionTriggerAt }),
    };
}
// ── Agent Runtime config parsing — see ./agent-runtime-config.ts for the
// canonical implementation. Re-exposed here so the public `getConfig()`
// surface keeps a single import point for callers; the helper is the
// source of truth for the `AgentRuntimeFramework` string union and the
// Pi-only runtime selection parser.
// ── Log Retention config parsing ────────────────────────────────
function parseLogRetentionDays(raw) {
    const val = raw.logRetentionDays;
    if (typeof val === 'number' && val >= 1 && Number.isFinite(val)) {
        return Math.floor(val);
    }
    return DEFAULTS.logRetentionDays;
}
// ── Content Review config parsing ───────────────────────────────
function parseContentReviewConfig(raw) {
    const obj = raw.contentReview;
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj))
        return undefined;
    const result = {};
    const enabled = Reflect.get(obj, 'enabled');
    if (typeof enabled === 'boolean')
        result.enabled = enabled;
    const testBaseURL = Reflect.get(obj, 'testBaseURL');
    if (typeof testBaseURL === 'string' && testBaseURL.trim()) {
        result.testBaseURL = testBaseURL.trim();
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
// ── MCP tool-search config parsing ──────────────────────────────
function parseMcpToolSearchConfig(raw) {
    const obj = raw.mcpToolSearch;
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj))
        return undefined;
    const result = {};
    const enabled = Reflect.get(obj, 'enabled');
    if (typeof enabled === 'boolean')
        result.enabled = enabled;
    const systemHint = Reflect.get(obj, 'systemHint');
    if (typeof systemHint === 'boolean')
        result.systemHint = systemHint;
    const thresholdPct = Reflect.get(obj, 'thresholdPct');
    if (typeof thresholdPct === 'number')
        result.thresholdPct = thresholdPct;
    const minDeferCount = Reflect.get(obj, 'minDeferCount');
    if (typeof minDeferCount === 'number')
        result.minDeferCount = minDeferCount;
    const topKDefault = Reflect.get(obj, 'topKDefault');
    if (typeof topKDefault === 'number')
        result.topKDefault = topKDefault;
    const topKMax = Reflect.get(obj, 'topKMax');
    if (typeof topKMax === 'number')
        result.topKMax = topKMax;
    const maxSchemaTextLen = Reflect.get(obj, 'maxSchemaTextLen');
    if (typeof maxSchemaTextLen === 'number')
        result.maxSchemaTextLen = maxSchemaTextLen;
    const modelWhitelist = Reflect.get(obj, 'modelWhitelist');
    if (Array.isArray(modelWhitelist)) {
        result.modelWhitelist = modelWhitelist.filter((v) => typeof v === 'string');
    }
    return Object.keys(result).length > 0 ? result : undefined;
}
// ---------------------------------------------------------------------------
// Port resolution — compute the target local runtime port from env / git / defaults
// ---------------------------------------------------------------------------
/**
 * Resolve the target local runtime port.
 *
 * Priority:
 * 0. DISABLE_GIT_AUTO_CONFIG=1 → skip git auto-detection
 * 1. Explicit profile-scoped port (__MAVIS_RUNTIME_PROFILE + __MAVIS_RUNTIME_PORT both set)
 * 2. Git auto-detection (hash-based offset from branch name in mavis repo)
 * 3. __MAVIS_RUNTIME_PORT env var (only when git detection is not active)
 * 4. DEFAULT_PORT (5321)
 *
 * Not cached — env vars and git state can change between calls.
 */
export function resolvePort() {
    const explicitPort = getExplicitPortEnv();
    if (shouldUseGitAutoConfig() && !shouldPreferExplicitPort()) {
        const gitInfo = detectGitPortInfo();
        if (gitInfo.autoDetected) {
            return gitInfo.runtimePort;
        }
    }
    return explicitPort ?? DEFAULT_PORT;
}
/**
 * Legacy OpenCode listens on a dedicated offset above the runtime port range.
 * New sessions do not use this; existing daemon callers still compile against it.
 */
export function getOpenCodePort(runtimePort = resolvePort()) {
    const preferredPort = runtimePort + OPENCODE_PORT_OFFSET;
    if (preferredPort <= MAX_TCP_PORT) {
        return preferredPort;
    }
    const fallbackPort = runtimePort + OPENCODE_FALLBACK_OFFSET;
    if (fallbackPort <= MAX_TCP_PORT) {
        return fallbackPort;
    }
    throw new Error(`Cannot allocate an OpenCode sidecar port for runtime port ${String(runtimePort)}; choose a runtime port <= ${String(MAX_TCP_PORT - OPENCODE_FALLBACK_OFFSET)}.`);
}
//# sourceMappingURL=config.js.map