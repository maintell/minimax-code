import { execFile } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_COLLECTION_POLICY, } from './collection-policy/index.js';
import { createCollectionPolicyMatcher } from './collection-policy/matcher.js';
import { createCollectionObserver } from './eval-meta-info-observation.js';
import { scanPathCommands } from './eval-meta-info-path-scan.js';
export const EVAL_META_INFO_SCHEMA = 'mavis.eval_meta_info.v1';
const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_DIRECTORIES = 5_000;
const FILE_STAT_CONCURRENCY = 64;
const MAX_DIRECTORY_TREE_ENTRIES = 2_000;
const GIT_TIMEOUT_MS = 1_500;
const GIT_MAX_OUTPUT_BYTES = 64 << 10;
const NO_EXTENSION = '[no_extension]';
/**
 * Hard safety baseline: these directories are never inventoried, whatever the policy says.
 */
const EXCLUDED_DIRECTORY_BY_NAME = {
    '.git': true,
    '.next': true,
    '.pnpm': true,
    build: true,
    coverage: true,
    dist: true,
    node_modules: true,
    out: true,
    target: true,
};
const PROJECT_CONFIG_FILE_NAMES = {
    '.nvmrc': true,
    '.python-version': true,
    '.tool-versions': true,
    'build.gradle': true,
    'build.gradle.kts': true,
    'cargo.lock': true,
    'cargo.toml': true,
    'cmakelists.txt': true,
    'composer.json': true,
    'docker-compose.yaml': true,
    'docker-compose.yml': true,
    dockerfile: true,
    gemfile: true,
    'go.mod': true,
    'go.sum': true,
    makefile: true,
    'package.json': true,
    'pnpm-workspace.yaml': true,
    'pom.xml': true,
    'poetry.lock': true,
    'pyproject.toml': true,
    'requirements.txt': true,
    'settings.gradle': true,
    'tsconfig.json': true,
    'uv.lock': true,
};
const OS_NAME_BY_PLATFORM = {
    darwin: 'macOS',
    linux: 'Linux',
    win32: 'Windows',
};
// Automatic collection may inventory PATH filenames but must never execute them.
// Git metadata uses only administrator-owned fixed paths under a minimal environment.
const TRUSTED_GIT_EXECUTABLES_BY_PLATFORM = {
    darwin: ['/usr/bin/git'],
    linux: ['/usr/bin/git'],
    win32: ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\git.exe'],
};
const TRUSTED_GIT_ENVIRONMENT = {
    GIT_CONFIG_GLOBAL: platform() === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
};
export async function collectEvalMetaInfo(options) {
    const collectedAtMs = (options.nowMs ?? Date.now)();
    const policy = options.policy ?? DEFAULT_COLLECTION_POLICY;
    const matcher = createCollectionPolicyMatcher(policy);
    const observer = createCollectionObserver(options.onObservation);
    const total = observer.start('total', { trackProcess: true });
    const maxFiles = boundedLimit(options.maxFiles, DEFAULT_MAX_FILES);
    const maxDirectories = boundedLimit(options.maxDirectories, DEFAULT_MAX_DIRECTORIES);
    const [workspace, git, environment] = await Promise.all([
        scanWorkspace({
            root: options.workspaceDir,
            maxFiles,
            maxDirectories,
            matcher,
            collectTree: !matcher.excludesMetadataField('workspace.directory_tree'),
            collectConfigFiles: !matcher.excludesMetadataField('config_files'),
        }, observer),
        collectGitInfo(options.workspaceDir, matcher, observer, options.runGit),
        resolveEnvironmentInfo(options, policy, matcher, observer),
    ]);
    const metaInfo = {
        schema: EVAL_META_INFO_SCHEMA,
        collected_at_ms: collectedAtMs,
        runtime: {
            kind: options.runtime,
            version: options.runtimeVersion || 'unknown',
            node_version: process.versions.node ?? 'unknown',
        },
        collection: {
            policy_version: matcher.version,
            workspace_policy_version: matcher.workspaceVersion,
        },
        ...buildSystemBlock(matcher, options.systemInfo, environment),
        environment: buildEnvironmentBlock(matcher, environment),
        workspace: buildWorkspaceBlock(matcher, options.workspaceDir, workspace, git),
        ...(matcher.excludesMetadataField('config_files')
            ? {}
            : { config_files: workspace.configFiles }),
    };
    total.finish({ outcome: 'success' });
    return metaInfo;
}
function boundedLimit(value, fallback) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
function buildSystemBlock(matcher, systemInfo, environment) {
    if (matcher.excludesMetadataField('system'))
        return {};
    const system = systemInfo ?? readSystemInfo();
    return {
        system: {
            ...(matcher.excludesMetadataField('system.os_name') ? {} : { os_name: system.osName }),
            ...(matcher.excludesMetadataField('system.os_version')
                ? {}
                : { os_version: system.osVersion }),
            ...(matcher.excludesMetadataField('system.arch') ? {} : { arch: system.arch }),
            ...(matcher.excludesMetadataField('system.timezone')
                ? {}
                : { timezone: environment.timeZone }),
            ...(matcher.excludesMetadataField('system.locale') ? {} : { locale: environment.locale }),
            ...(matcher.excludesMetadataField('system.terminal') || environment.terminal === undefined
                ? {}
                : { terminal: environment.terminal }),
        },
    };
}
function buildEnvironmentBlock(matcher, environment) {
    const includeShell = !matcher.excludesMetadataField('environment.shell') && environment.shell !== undefined;
    const includeCommands = !matcher.excludesMetadataField('environment.path_commands');
    return {
        ...(includeShell ? { shell: environment.shell } : {}),
        ...(includeCommands
            ? {
                path_commands: environment.pathCommands,
                ...optionalField('path_scan_truncated', environment.pathScanTruncated),
                ...optionalField('path_scan_complete', environment.pathScanComplete),
                ...optionalField('path_scan_limit', environment.pathScanLimit),
                ...optionalField('path_scan_raw_file_count', environment.pathScanRawFileCount),
                ...optionalField('path_scan_filtered_count', environment.pathScanFilteredCount),
                ...optionalField('path_scan_retained_count', environment.pathScanRetainedCount),
                ...optionalField('path_scan_reason', environment.pathScanReason),
                ...optionalField('path_command_sources', environment.pathCommandSources),
            }
            : {}),
        ...(matcher.excludesMetadataField('environment.runtimes')
            ? {}
            : { runtimes: environment.runtimes }),
    };
}
function buildWorkspaceBlock(matcher, workspaceDir, workspace, git) {
    const includeTree = !matcher.excludesMetadataField('workspace.directory_tree');
    return {
        name: basename(workspaceDir) || 'workspace',
        ...(matcher.excludesMetadataField('workspace.current_directory')
            ? {}
            : { current_directory: '.' }),
        ...(matcher.excludesMetadataField('workspace.total_files')
            ? {}
            : { total_files: workspace.totalFiles }),
        ...(matcher.excludesMetadataField('workspace.total_bytes')
            ? {}
            : { total_bytes: workspace.totalBytes }),
        ...(matcher.excludesMetadataField('workspace.file_types')
            ? {}
            : { file_types: workspace.fileTypes }),
        scan_truncated: workspace.truncated,
        ...optionalField('scan_reason', workspace.reason),
        ...(workspace.filteredFileCount > 0
            ? { filtered_file_count: workspace.filteredFileCount }
            : {}),
        ...(workspace.filteredDirectoryCount > 0
            ? { filtered_directory_count: workspace.filteredDirectoryCount }
            : {}),
        ...(includeTree
            ? { directory_tree: workspace.directoryTree, tree_truncated: workspace.treeTruncated }
            : {}),
        ...(git ? { git } : {}),
    };
}
function optionalField(name, value) {
    return value === undefined ? {} : { [name]: value };
}
async function resolveEnvironmentInfo(options, policy, matcher, observer) {
    if (options.environmentInfo) {
        observer.start('path').finish({ outcome: 'skipped', reason: 'unavailable' });
        return options.environmentInfo;
    }
    return collectEnvironmentInfo(policy, matcher, observer);
}
async function collectEnvironmentInfo(policy, matcher, observer) {
    const dateTimeOptions = readDateTimeOptions();
    const runtimes = [
        { name: 'node', version: process.versions.node ?? 'unknown' },
    ];
    const shell = matcher.excludesMetadataField('environment.shell')
        ? undefined
        : readShellName(matcher);
    const terminal = matcher.excludesMetadataField('system.terminal')
        ? undefined
        : readTerminalName(matcher);
    if (matcher.excludesMetadataField('environment.path_commands')) {
        observer.start('path').finish({ outcome: 'skipped', reason: 'policy' });
        return {
            timeZone: dateTimeOptions.timeZone,
            locale: dateTimeOptions.locale,
            ...(terminal === undefined ? {} : { terminal }),
            ...(shell === undefined ? {} : { shell }),
            pathCommands: [],
            runtimes,
        };
    }
    const phase = observer.start('path');
    const inventory = await scanPathCommands({
        matcher,
        maxCommands: policy.path_commands.max_commands,
        maxBytes: policy.path_commands.max_bytes,
    });
    phase.finish({
        outcome: inventory.reason === 'unavailable' || inventory.reason === 'policy' ? 'skipped' : 'success',
        rawCount: inventory.rawFileCount,
        filteredCount: inventory.filteredCount,
        retainedCount: inventory.retainedCount,
        outputBytes: inventory.outputBytes,
        truncated: inventory.truncated,
        scanComplete: inventory.scanComplete,
        ...(inventory.reason ? { reason: inventory.reason } : {}),
    });
    return {
        timeZone: dateTimeOptions.timeZone,
        locale: dateTimeOptions.locale,
        ...(terminal === undefined ? {} : { terminal }),
        ...(shell === undefined ? {} : { shell }),
        pathCommands: inventory.commands,
        pathScanTruncated: inventory.truncated,
        pathScanComplete: inventory.scanComplete,
        pathScanLimit: inventory.scanLimit,
        pathScanRawFileCount: inventory.rawFileCount,
        pathScanFilteredCount: inventory.filteredCount,
        pathScanRetainedCount: inventory.retainedCount,
        ...(inventory.reason ? { pathScanReason: inventory.reason } : {}),
        pathCommandSources: inventory.sources,
        runtimes,
    };
}
/** Returns the shell's file name, or `undefined` when the policy denies the source variables. */
function readShellName(matcher) {
    const allowShell = !matcher.excludesEnvironmentKey('SHELL');
    const allowComSpec = !matcher.excludesEnvironmentKey('COMSPEC');
    if (!allowShell && !allowComSpec)
        return undefined;
    const shellPath = (allowShell ? process.env.SHELL : undefined) ||
        (allowComSpec ? process.env.ComSpec || process.env.COMSPEC : undefined);
    return normalizeEnvironmentLabel(shellPath ? basename(shellPath) : undefined);
}
/** Returns the terminal label, or `undefined` when the policy denies the source variables. */
function readTerminalName(matcher) {
    const allowTermProgram = !matcher.excludesEnvironmentKey('TERM_PROGRAM');
    const allowWindowsTerminal = !matcher.excludesEnvironmentKey('WT_SESSION');
    const allowTerm = !matcher.excludesEnvironmentKey('TERM');
    if (!allowTermProgram && !allowWindowsTerminal && !allowTerm)
        return undefined;
    const terminal = (allowTermProgram ? process.env.TERM_PROGRAM : undefined) ||
        (allowWindowsTerminal && process.env.WT_SESSION ? 'Windows Terminal' : undefined) ||
        (allowTerm ? process.env.TERM : undefined);
    return normalizeEnvironmentLabel(terminal);
}
function readDateTimeOptions() {
    try {
        const options = Intl.DateTimeFormat().resolvedOptions();
        return {
            timeZone: normalizeEnvironmentLabel(options.timeZone, 'UTC'),
            locale: normalizeEnvironmentLabel(options.locale),
        };
    }
    catch {
        return { timeZone: 'UTC', locale: 'unknown' };
    }
}
function normalizeEnvironmentLabel(value, fallback = 'unknown') {
    const normalized = value?.replace(/[\u0000-\u001F\u007F]/gu, ' ').trim();
    return normalized ? normalized.slice(0, 128) : fallback;
}
function readSystemInfo() {
    const currentPlatform = platform();
    return {
        osName: OS_NAME_BY_PLATFORM[currentPlatform] ?? currentPlatform,
        osVersion: release(),
        arch: arch(),
    };
}
async function scanWorkspace(input, observer) {
    const phase = observer.start('workspace');
    const scan = await walkWorkspace(input);
    const reason = scan.rootReadable ? scan.reason : 'unavailable';
    phase.finish({
        outcome: scan.rootReadable ? 'success' : 'error',
        rawCount: scan.rawEntryCount,
        filteredCount: scan.filteredFileCount + scan.filteredDirectoryCount,
        retainedCount: scan.totalFiles,
        truncated: scan.truncated,
        scanComplete: !scan.truncated,
        ...(reason ? { reason } : {}),
    });
    return scan;
}
async function walkWorkspace(input) {
    const { root, maxFiles, maxDirectories, matcher } = input;
    const pending = [
        { path: root, relativePath: '' },
    ];
    const byExtension = new Map();
    const configFiles = [];
    const directoryTree = [];
    let totalFiles = 0;
    let totalBytes = 0;
    let truncated = false;
    let treeTruncated = false;
    let reason;
    let directoriesScanned = 0;
    let rawEntryCount = 0;
    let filteredFileCount = 0;
    let filteredDirectoryCount = 0;
    let rootReadable = true;
    while (pending.length > 0) {
        if (totalFiles >= maxFiles || directoriesScanned >= maxDirectories) {
            truncated = true;
            treeTruncated = true;
            reason = totalFiles >= maxFiles ? 'count_limit' : 'directory_limit';
            break;
        }
        const directory = pending.pop();
        if (!directory)
            break;
        directoriesScanned += 1;
        let entries;
        try {
            entries = await readdir(directory.path, { withFileTypes: true });
        }
        catch {
            if (directory.path === root)
                rootReadable = false;
            continue;
        }
        entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        const childDirectories = [];
        const files = [];
        for (const entry of entries) {
            rawEntryCount += 1;
            if (entry.isSymbolicLink())
                continue;
            const entryPath = join(directory.path, entry.name);
            const relativePath = directory.relativePath.length === 0
                ? entry.name
                : `${directory.relativePath}/${entry.name}`;
            if (entry.isDirectory()) {
                if (Object.hasOwn(EXCLUDED_DIRECTORY_BY_NAME, entry.name.toLowerCase()))
                    continue;
                // Excluded directories are pruned before traversal: nothing under them is read.
                if (matcher.excludesWorkspacePath(relativePath)) {
                    filteredDirectoryCount += 1;
                    continue;
                }
                childDirectories.push({ path: entryPath, relativePath });
                if (!input.collectTree)
                    continue;
                if (directoryTree.length < MAX_DIRECTORY_TREE_ENTRIES) {
                    directoryTree.push({ kind: 'directory', path: relativePath });
                }
                else {
                    treeTruncated = true;
                }
                continue;
            }
            if (!entry.isFile())
                continue;
            if (matcher.excludesWorkspacePath(relativePath)) {
                filteredFileCount += 1;
                continue;
            }
            if (totalFiles + files.length >= maxFiles) {
                truncated = true;
                reason = 'count_limit';
                break;
            }
            files.push({ name: entry.name, path: entryPath, relativePath });
        }
        while (childDirectories.length > 0) {
            const childDirectory = childDirectories.pop();
            if (childDirectory !== undefined)
                pending.push(childDirectory);
        }
        for (let offset = 0; offset < files.length; offset += FILE_STAT_CONCURRENCY) {
            const fileStats = await Promise.all(files.slice(offset, offset + FILE_STAT_CONCURRENCY).map(async (file) => {
                try {
                    return { file, stats: await lstat(file.path) };
                }
                catch {
                    return undefined;
                }
            }));
            for (const item of fileStats) {
                if (!item?.stats.isFile())
                    continue;
                totalFiles += 1;
                totalBytes += item.stats.size;
                const extension = extname(item.file.name).toLowerCase() || NO_EXTENSION;
                const aggregate = byExtension.get(extension) ?? { fileCount: 0, totalBytes: 0 };
                aggregate.fileCount += 1;
                aggregate.totalBytes += item.stats.size;
                byExtension.set(extension, aggregate);
                if (input.collectTree) {
                    if (directoryTree.length < MAX_DIRECTORY_TREE_ENTRIES) {
                        directoryTree.push({
                            kind: 'file',
                            path: item.file.relativePath,
                            size_bytes: item.stats.size,
                        });
                    }
                    else {
                        treeTruncated = true;
                    }
                }
                if (input.collectConfigFiles &&
                    Object.hasOwn(PROJECT_CONFIG_FILE_NAMES, item.file.name.toLowerCase())) {
                    configFiles.push({
                        kind: 'project',
                        path: item.file.relativePath,
                        size_bytes: item.stats.size,
                        updated_at_ms: Math.floor(item.stats.mtimeMs),
                    });
                }
            }
        }
    }
    const fileTypes = [...byExtension.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([extension, value]) => ({
        extension,
        file_count: value.fileCount,
        total_bytes: value.totalBytes,
    }));
    configFiles.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return {
        totalFiles,
        totalBytes,
        fileTypes,
        configFiles,
        directoryTree,
        treeTruncated,
        truncated,
        ...(reason ? { reason } : {}),
        rawEntryCount,
        filteredFileCount,
        filteredDirectoryCount,
        rootReadable,
    };
}
async function collectGitInfo(workspaceDir, matcher, observer, injectedRunGit) {
    if (matcher.excludesMetadataField('workspace.git')) {
        observer.start('git').finish({ outcome: 'skipped', reason: 'policy' });
        return undefined;
    }
    const phase = observer.start('git');
    const runGit = injectedRunGit ?? ((args) => runGitCommand(workspaceDir, args));
    const root = await safelyRunGit(runGit, ['rev-parse', '--show-toplevel']);
    if (!root) {
        phase.finish({ outcome: 'skipped', reason: 'unavailable' });
        return undefined;
    }
    const [branch, remoteBranch, commit] = await Promise.all([
        safelyRunGit(runGit, ['branch', '--show-current']),
        safelyRunGit(runGit, ['rev-parse', '--abbrev-ref', '@{upstream}']),
        safelyRunGit(runGit, ['rev-parse', 'HEAD']),
    ]);
    if (!branch && !remoteBranch && !commit) {
        phase.finish({ outcome: 'skipped', reason: 'unavailable' });
        return undefined;
    }
    const git = {
        ...(branch && !matcher.excludesMetadataField('workspace.git.branch') ? { branch } : {}),
        ...(remoteBranch && !matcher.excludesMetadataField('workspace.git.remote_branch')
            ? { remote_branch: remoteBranch }
            : {}),
        ...(commit && !matcher.excludesMetadataField('workspace.git.commit') ? { commit } : {}),
    };
    if (git.branch === undefined && git.remote_branch === undefined && git.commit === undefined) {
        phase.finish({ outcome: 'skipped', reason: 'policy' });
        return undefined;
    }
    phase.finish({ outcome: 'success' });
    return git;
}
async function safelyRunGit(runGit, args) {
    try {
        const value = await runGit(args);
        const trimmed = value?.trim();
        return trimmed || undefined;
    }
    catch {
        return undefined;
    }
}
async function runGitCommand(workspaceDir, args) {
    const executables = TRUSTED_GIT_EXECUTABLES_BY_PLATFORM[platform()] ?? [];
    for (const executable of executables) {
        try {
            const { stdout } = await execFileAsync(executable, ['-C', workspaceDir, ...args], {
                encoding: 'utf8',
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: GIT_MAX_OUTPUT_BYTES,
                windowsHide: true,
                env: TRUSTED_GIT_ENVIRONMENT,
            });
            const value = stdout.trim();
            return value || undefined;
        }
        catch {
            // Try the next trusted installation path, then fail open.
        }
    }
    return undefined;
}
//# sourceMappingURL=eval-meta-info.js.map