import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, } from 'node:fs';
import path from 'node:path';
import { validateEmbeddedResourceFiles, validateEmbeddedResourceManifest, } from './resource-manifest.mjs';
import { AUTH_LEASE_PROTOCOL_PACKAGE_NAME, AUTH_LEASE_PROTOCOL_PACKAGE_VERSION, AUTH_LEASE_PROTOCOL_VERSION, } from '@mavis/oauth-lease-protocol';
export function validateMcodeToolsResource(options) {
    const manifestPath = path.join(options.resourceDir, 'manifest.json');
    if (!existsSync(manifestPath))
        throw new Error('mcode-tools manifest is missing');
    let value;
    try {
        value = JSON.parse(readFileSync(manifestPath, 'utf8'));
    }
    catch {
        throw new Error('mcode-tools manifest is not valid JSON');
    }
    const manifest = parseManifest(value);
    if (manifest.buildEnv !== options.expectedBuildEnv) {
        throw new Error(`mcode-tools build environment mismatch: expected ${options.expectedBuildEnv}, received ${manifest.buildEnv}`);
    }
    const expectedPackageName = packageNameForBuildEnv(options.expectedBuildEnv);
    if (manifest.packageName !== expectedPackageName) {
        throw new Error(`mcode-tools package mismatch: expected ${expectedPackageName}, received ${manifest.packageName}`);
    }
    const cliPath = path.join(options.resourceDir, manifest.entry);
    if (!existsSync(cliPath))
        throw new Error('mcode-tools embedded cli is missing');
    validateEmbeddedResourceFiles(options.resourceDir, manifest);
    return { rootDir: options.resourceDir, cliPath, manifest };
}
/**
 * Launcher directory owned by exactly one installed host App.
 *
 * Desktop packages (Test, Staging, Internal, Inside and the release build) all default to the
 * same dataDir, and several of them share a buildEnv. A launcher in the shared `<dataDir>/bin`
 * is last-writer-wins, so one App's Agent ran another App's embedded CLI against that App's
 * broker and account. The host executable is what identifies the installed App: two packages
 * never share it, and the launcher already `exec`s it. buildEnv only keeps the name readable.
 */
export function resolveMcodeToolsHostBinDir(options) {
    const digest = createHash('sha256').update(options.executable, 'utf8').digest('hex');
    return path.join(options.dataDir, 'bin', 'hosts', `${options.buildEnv}-${digest.slice(0, 16)}`);
}
export async function installMcodeToolsLauncher(options) {
    const resource = validateMcodeToolsResource(options);
    const sharedBinDir = path.join(options.dataDir, 'bin');
    const configDir = path.join(options.dataDir, 'integrations', 'mcode-tools', options.region);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
    const isWindows = options.platform === 'win32';
    const bedrockLane = resolveManagedBedrockLane(options.bedrockLane);
    const contents = isWindows
        ? renderWindowsLauncher({
            executable: options.executable,
            cliPath: resource.cliPath,
            configDir,
            region: options.region,
            ...(bedrockLane ? { bedrockLane } : {}),
            brokerEndpoint: options.brokerEndpoint,
            brokerCapabilityFile: options.brokerCapabilityFile,
        })
        : renderPosixLauncher({
            executable: options.executable,
            cliPath: resource.cliPath,
            configDir,
            region: options.region,
            ...(bedrockLane ? { bedrockLane } : {}),
            brokerEndpoint: options.brokerEndpoint,
            brokerCapabilityFile: options.brokerCapabilityFile,
        });
    const sharedDispatcher = isWindows ? renderWindowsDispatcher() : renderPosixDispatcher();
    const write = (binDir, dispatcher) => writeLauncherSet({ binDir, region: options.region, isWindows, contents, dispatcher });
    if (!options.hostBinDir || samePath(options.hostBinDir, sharedBinDir)) {
        return { ...write(sharedBinDir, sharedDispatcher), resource };
    }
    // The App-owned directory serves one App and one region. Its dispatcher defaults to that region
    // instead of probing siblings, because the other region is an executable placeholder there.
    const ownRegion = regionLabel(options.region);
    const owned = write(options.hostBinDir, isWindows ? renderWindowsDispatcher(ownRegion) : renderPosixDispatcher(ownRegion));
    const otherRegion = ownRegion === 'cn' ? 'global' : 'cn';
    const placeholder = placeholderFiles(options.platform).find((file) => file.name === launcherFileName(`mcode-tools-${otherRegion}`, isWindows));
    if (placeholder) {
        writeFileIfChanged(path.join(options.hostBinDir, placeholder.name), placeholder.contents, placeholder.mode);
    }
    write(sharedBinDir, sharedDispatcher);
    return { ...owned, resource };
}
/**
 * Fills the App-owned launcher directory with fail-closed placeholders for every launcher name
 * that is still missing, without touching launchers that are already there.
 *
 * Agent bash resolves `mcode-tools` through `[hostBinDir, <dataDir>/bin, ...]`. If this App's
 * directory were empty — integration disabled, startup failed, or not finished yet — the shell
 * would fall through to the shared copy, which belongs to whichever App wrote it last, and run
 * that App's CLI against that App's broker and account. A placeholder answers first instead,
 * prints that mcode-tools is unavailable in this App and exits 127. The host calls this before
 * handing the directory to its Runtime; {@link installMcodeToolsLauncher} later replaces the
 * placeholders with real launchers.
 */
export function ensureMcodeToolsPlaceholderLaunchers(options) {
    ensurePrivateDirectory(options.hostBinDir);
    for (const file of placeholderFiles(options.platform)) {
        try {
            writeFileSync(path.join(options.hostBinDir, file.name), file.contents, {
                mode: file.mode,
                flag: 'wx',
            });
        }
        catch (error) {
            // A launcher that already exists (real or placeholder) is kept as it is.
            if (error.code !== 'EEXIST')
                throw error;
        }
    }
}
/**
 * Withdraws this App's launchers.
 *
 * - App-owned `hostBinDir`: every launcher is replaced by a fail-closed placeholder (see
 *   {@link ensureMcodeToolsPlaceholderLaunchers}); the directory is never emptied.
 * - Shared `<dataDir>/bin`: the copy may have been rewritten by another App on the same dataDir
 *   after we installed ours, so a regional launcher is deleted only when it still `exec`s this
 *   App's executable; the dispatcher goes once no regional launcher remains in that directory.
 */
export function removeMcodeToolsLaunchers(options) {
    const sharedBinDir = path.join(options.dataDir, 'bin');
    if (options.hostBinDir && !samePath(options.hostBinDir, sharedBinDir)) {
        resetToPlaceholderLaunchers(options.hostBinDir, options.platform ?? process.platform);
    }
    removeOwnedLauncherSet(sharedBinDir, options.executable, options.region);
}
/**
 * Whether a launcher file `exec`s the given host executable. Reads the same quoted form the
 * renderers write, so launchers written by earlier releases are recognised too.
 */
export function isMcodeToolsLauncherOwnedBy(file, executable) {
    let contents;
    try {
        contents = readFileSync(file, 'utf8');
    }
    catch {
        return false;
    }
    let prefix;
    try {
        prefix = file.toLowerCase().endsWith('.cmd')
            ? `"${escapeWindowsBatchValue(executable)}" `
            : `exec ${quotePosix(executable)} `;
    }
    catch {
        return false;
    }
    return contents.split(/\r?\n/u).some((line) => line.startsWith(prefix));
}
const REGION_LABELS = ['cn', 'global'];
function writeLauncherSet(options) {
    const { binDir, isWindows } = options;
    ensurePrivateDirectory(binDir);
    const launcherPath = path.join(binDir, launcherFileName('mcode-tools', isWindows));
    const regionalLauncherPath = path.join(binDir, launcherFileName(`mcode-tools-${regionLabel(options.region)}`, isWindows));
    writeFileIfChanged(regionalLauncherPath, options.contents, isWindows ? 0o600 : 0o755);
    writeFileIfChanged(launcherPath, options.dispatcher, isWindows ? 0o600 : 0o755);
    removeOtherPlatformLaunchers(binDir, isWindows);
    return { launcherPath, regionalLauncherPath };
}
const LAUNCHER_BASE_NAMES = ['mcode-tools', 'mcode-tools-cn', 'mcode-tools-global'];
function regionLabel(region) {
    return region === 'cn' ? 'cn' : 'global';
}
function launcherFileName(baseName, isWindows) {
    return isWindows ? `${baseName}.cmd` : baseName;
}
function ensurePrivateDirectory(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
}
function removeOtherPlatformLaunchers(binDir, isWindows) {
    for (const baseName of LAUNCHER_BASE_NAMES) {
        rmSync(path.join(binDir, launcherFileName(baseName, !isWindows)), { force: true });
    }
}
function resetToPlaceholderLaunchers(hostBinDir, platform) {
    ensurePrivateDirectory(hostBinDir);
    for (const file of placeholderFiles(platform)) {
        writeFileIfChanged(path.join(hostBinDir, file.name), file.contents, file.mode);
    }
    removeOtherPlatformLaunchers(hostBinDir, platform === 'win32');
}
const PLACEHOLDER_MESSAGE = 'mcode-tools is not available in this app: its mcode-tools integration is disabled, failed to start, or is not ready yet.';
function placeholderFiles(platform) {
    const isWindows = platform === 'win32';
    const contents = isWindows
        ? ['@echo off', `echo ${PLACEHOLDER_MESSAGE} 1>&2`, 'exit /b 127', ''].join('\r\n')
        : ['#!/bin/sh', `echo '${PLACEHOLDER_MESSAGE}' >&2`, 'exit 127', ''].join('\n');
    return LAUNCHER_BASE_NAMES.map((baseName) => ({
        name: launcherFileName(baseName, isWindows),
        contents,
        mode: isWindows ? 0o600 : 0o755,
    }));
}
function removeOwnedLauncherSet(binDir, executable, region) {
    const labels = region ? [regionLabel(region)] : REGION_LABELS;
    for (const name of labels.flatMap((label) => [
        `mcode-tools-${label}`,
        `mcode-tools-${label}.cmd`,
    ])) {
        const file = path.join(binDir, name);
        if (isMcodeToolsLauncherOwnedBy(file, executable))
            rmSync(file, { force: true });
    }
    const hasRegionalLauncher = REGION_LABELS.some((label) => existsSync(path.join(binDir, `mcode-tools-${label}`)) ||
        existsSync(path.join(binDir, `mcode-tools-${label}.cmd`)));
    if (!hasRegionalLauncher) {
        rmSync(path.join(binDir, 'mcode-tools'), { force: true });
        rmSync(path.join(binDir, 'mcode-tools.cmd'), { force: true });
    }
}
function samePath(left, right) {
    return path.resolve(left) === path.resolve(right);
}
/**
 * Region dispatcher. With `ownRegion` (App-owned directory) an unset region selects that region;
 * without it (shared directory, possibly serving both regions) the installed sibling decides.
 */
function renderPosixDispatcher(ownRegion) {
    const unsetRegion = ownRegion
        ? [`    mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-${ownRegion}"`]
        : [
            '    if [ -x "$mcode_tools_bin_dir/mcode-tools-cn" ] && [ ! -x "$mcode_tools_bin_dir/mcode-tools-global" ]; then',
            '      mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-cn"',
            '    elif [ -x "$mcode_tools_bin_dir/mcode-tools-global" ] && [ ! -x "$mcode_tools_bin_dir/mcode-tools-cn" ]; then',
            '      mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-global"',
            '    else',
            '      echo "MCODE_REGION must be cn or global when both regional mcode-tools launchers are installed." >&2',
            '      exit 2',
            '    fi',
        ];
    return [
        '#!/bin/sh',
        'mcode_tools_bin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        ['mcode_tools_region=$', '{MCODE_REGION:-$', '{MAVIS_REGION:-}}'].join(''),
        'case "$mcode_tools_region" in',
        '  cn) mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-cn" ;;',
        '  en|global) mcode_tools_target="$mcode_tools_bin_dir/mcode-tools-global" ;;',
        '  "")',
        ...unsetRegion,
        '    ;;',
        '  *) echo "Invalid MCODE_REGION; expected cn or global." >&2; exit 2 ;;',
        'esac',
        'exec "$mcode_tools_target" "$@"',
        '',
    ].join('\n');
}
function renderWindowsDispatcher(ownRegion) {
    const unsetRegion = ownRegion
        ? [`goto mcode_tools_${ownRegion}`]
        : [
            'if exist "%~dp0mcode-tools-cn.cmd" if not exist "%~dp0mcode-tools-global.cmd" goto mcode_tools_cn',
            'if exist "%~dp0mcode-tools-global.cmd" if not exist "%~dp0mcode-tools-cn.cmd" goto mcode_tools_global',
            'echo MCODE_REGION must be cn or global when both regional mcode-tools launchers are installed. 1>&2',
            'exit /b 2',
        ];
    return [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'set "mcode_tools_region=%MCODE_REGION%"',
        'if not defined mcode_tools_region set "mcode_tools_region=%MAVIS_REGION%"',
        'if /i "%mcode_tools_region%"=="cn" goto mcode_tools_cn',
        'if /i "%mcode_tools_region%"=="en" goto mcode_tools_global',
        'if /i "%mcode_tools_region%"=="global" goto mcode_tools_global',
        'if defined mcode_tools_region goto mcode_tools_invalid',
        ...unsetRegion,
        ':mcode_tools_cn',
        'call "%~dp0mcode-tools-cn.cmd" %*',
        'exit /b %ERRORLEVEL%',
        ':mcode_tools_global',
        'call "%~dp0mcode-tools-global.cmd" %*',
        'exit /b %ERRORLEVEL%',
        ':mcode_tools_invalid',
        'echo Invalid MCODE_REGION; expected cn or global. 1>&2',
        'exit /b 2',
        '',
    ].join('\r\n');
}
export function renderPosixLauncher(options) {
    const lines = [
        '#!/bin/sh',
        'unset MAVIS_ACCESS_TOKEN MAVIS_DATA_DIR MINIMAX_DATA_DIR MAVIS_PORT MAVIS_PROFILE IS_SANDBOX MCODE_API_BASE_URL MCODE_AUTH_BASE_URL MCODE_CLIENT_ID MCODE_SCOPE MCODE_AUTH_PROVIDER MCODE_AUTH_BROKER_ENDPOINT MCODE_AUTH_BROKER_CAPABILITY_FILE MCODE_EXTRA_HEADERS',
        "for mcode_tools_name in $(env | sed -n 's/^\\([^=]*\\)=.*$/\\1/p'); do",
        '  case "$mcode_tools_name" in',
        '    __MAVIS_PARENT_*|__MAVIS_RUNTIME_*|AGENTARCHON_*|AGENT_ARCHON_*) unset "$mcode_tools_name" ;;',
        '  esac',
        'done',
        'unset mcode_tools_name',
        'export ELECTRON_RUN_AS_NODE=1',
        `export MCODE_REGION=${quotePosix(options.region)}`,
        `export MCODE_CONFIG_DIR=${quotePosix(options.configDir)}`,
    ];
    lines.push('export MCODE_AUTH_PROVIDER=shared-broker', `export MCODE_AUTH_BROKER_ENDPOINT=${quotePosix(options.brokerEndpoint)}`, `export MCODE_AUTH_BROKER_CAPABILITY_FILE=${quotePosix(options.brokerCapabilityFile)}`);
    if (options.bedrockLane) {
        lines.push(`export MCODE_EXTRA_HEADERS=${quotePosix(`bedrock_lane:${options.bedrockLane},bedrock-lane:${options.bedrockLane}`)}`);
    }
    lines.push(`exec ${quotePosix(options.executable)} ${quotePosix(options.cliPath)} "$@"`, '');
    return lines.join('\n');
}
export function renderWindowsLauncher(options) {
    const lines = [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'set "MAVIS_ACCESS_TOKEN="',
        'set "MAVIS_DATA_DIR="',
        'set "MINIMAX_DATA_DIR="',
        'set "MAVIS_PORT="',
        'set "MAVIS_PROFILE="',
        'set "IS_SANDBOX="',
        'set "MCODE_API_BASE_URL="',
        'set "MCODE_AUTH_BASE_URL="',
        'set "MCODE_CLIENT_ID="',
        'set "MCODE_SCOPE="',
        'set "MCODE_AUTH_PROVIDER="',
        'set "MCODE_AUTH_BROKER_ENDPOINT="',
        'set "MCODE_AUTH_BROKER_CAPABILITY_FILE="',
        'set "MCODE_EXTRA_HEADERS="',
        'for /f "tokens=1 delims==" %%V in (\'set __MAVIS_PARENT_ 2^>nul\') do set "%%V="',
        'for /f "tokens=1 delims==" %%V in (\'set __MAVIS_RUNTIME_ 2^>nul\') do set "%%V="',
        'for /f "tokens=1 delims==" %%V in (\'set AGENTARCHON_ 2^>nul\') do set "%%V="',
        'for /f "tokens=1 delims==" %%V in (\'set AGENT_ARCHON_ 2^>nul\') do set "%%V="',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `set "MCODE_REGION=${escapeWindowsBatchValue(options.region)}"`,
        `set "MCODE_CONFIG_DIR=${escapeWindowsBatchValue(options.configDir)}"`,
    ];
    lines.push('set "MCODE_AUTH_PROVIDER=shared-broker"', `set "MCODE_AUTH_BROKER_ENDPOINT=${escapeWindowsBatchValue(options.brokerEndpoint)}"`, `set "MCODE_AUTH_BROKER_CAPABILITY_FILE=${escapeWindowsBatchValue(options.brokerCapabilityFile)}"`);
    if (options.bedrockLane) {
        lines.push(`set "MCODE_EXTRA_HEADERS=${escapeWindowsBatchValue(`bedrock_lane:${options.bedrockLane},bedrock-lane:${options.bedrockLane}`)}"`);
    }
    lines.push(`"${escapeWindowsBatchValue(options.executable)}" "${escapeWindowsBatchValue(options.cliPath)}" %*`, 'exit /b %ERRORLEVEL%', '');
    return lines.join('\r\n');
}
function parseManifest(value) {
    if (!value || typeof value !== 'object')
        throw new Error('mcode-tools manifest is invalid');
    const input = value;
    const buildEnv = input.buildEnv;
    if (buildEnv !== 'test' && buildEnv !== 'staging' && buildEnv !== 'prod') {
        throw new Error('mcode-tools manifest buildEnv is invalid');
    }
    if (input.entry !== 'cli.mjs')
        throw new Error('mcode-tools manifest entry is invalid');
    for (const key of ['packageName', 'version', 'gitSha', 'nodeRange']) {
        if (typeof input[key] !== 'string' || input[key].trim().length === 0) {
            throw new Error(`mcode-tools manifest ${key} is invalid`);
        }
    }
    if (typeof input.bedrockLane !== 'string') {
        throw new Error('mcode-tools manifest bedrockLane is invalid');
    }
    if (buildEnv !== 'test' && input.bedrockLane.trim().length > 0) {
        throw new Error('mcode-tools non-test manifest must not select a Bedrock lane');
    }
    const auth = input.auth;
    const protocol = auth?.protocol;
    if ((input.schemaVersion !== 3 && input.schemaVersion !== 4) ||
        auth?.mode !== 'shared-broker' ||
        protocol?.name !== AUTH_LEASE_PROTOCOL_PACKAGE_NAME ||
        protocol?.version !== AUTH_LEASE_PROTOCOL_PACKAGE_VERSION ||
        protocol?.wireVersion !== AUTH_LEASE_PROTOCOL_VERSION) {
        throw new Error('mcode-tools shared-broker lease protocol manifest is incompatible');
    }
    if (hasOwn(input, 'sharedLocal') || hasOwn(input, 'platform') || hasOwn(input, 'arch')) {
        throw new Error('mcode-tools shared-broker manifest must not contain shared-local platform metadata');
    }
    validateEmbeddedResourceManifest(input);
    return input;
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function resolveManagedBedrockLane(value) {
    if (value === undefined)
        return undefined;
    const lane = value.trim();
    if (!/^[A-Za-z0-9._-]+$/u.test(lane)) {
        throw new Error('mcode-tools Bedrock lane is invalid');
    }
    return lane;
}
function packageNameForBuildEnv(buildEnv) {
    if (buildEnv === 'test')
        return '@minimax/mcode-tools-test';
    if (buildEnv === 'staging')
        return '@minimax/mcode-tools-staging';
    return '@minimax/mcode-tools';
}
function quotePosix(value) {
    if (/\r|\n|\0/u.test(value))
        throw new Error('mcode-tools launcher path contains control data');
    return `'${value.replace(/'/gu, "'\\''")}'`;
}
function escapeWindowsBatchValue(value) {
    if (/\r|\n|\0|"/u.test(value)) {
        throw new Error('mcode-tools launcher path contains unsupported characters');
    }
    return value.replace(/%/gu, '%%');
}
function writeFileIfChanged(file, contents, mode) {
    if (existsSync(file) && readFileSync(file, 'utf8') === contents) {
        chmodSync(file, mode);
        return;
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, contents, { mode });
    try {
        renameSync(temporary, file);
    }
    catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
    chmodSync(file, mode);
}
//# sourceMappingURL=resource.js.map