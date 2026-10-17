import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { buildGlobArgs, isDefaultBroadFileExcluded, isDefaultScanNoisePath, isSensitiveSearchPath, runRg, } from '@mavis/agent-tools/desktop';
import { resolveWorkspaceCollectionPolicy, } from './collection-policy.js';
import { appendGitWorkspacePaths } from './git-inventory.js';
import { fingerprintWorkspaceFiles, scanWorkspaceFiles, } from './workspace-scan-files.js';
export const DEFAULT_WORKSPACE_MAX_FILES = 10_000;
export const DEFAULT_WORKSPACE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const DEFAULT_WORKSPACE_MAX_FILE_BYTES = 10 * 1024 * 1024;
const RG_INVENTORY_MAX_BYTES = 64 * 1024 * 1024;
const WORKSPACE_CAPTURE_SENSITIVE_FILENAMES = new Set([
    '.git-credentials',
    '.netrc',
    '.pypirc',
    'auth.json',
    'credentials.json',
    'secret.json',
    'secret.yaml',
    'secret.yml',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
]);
const WORKSPACE_CAPTURE_SENSITIVE_EXTENSIONS = [
    '.jks',
    '.kdbx',
    '.keystore',
    '.ovpn',
    '.ppk',
    '.tfstate',
    '.tfstate.backup',
];
export async function scanWorkspace(workspaceDir, options = {}) {
    const workspaceRealPath = await realpath(workspaceDir);
    const rootStat = await lstat(workspaceRealPath);
    if (!rootStat.isDirectory()) {
        throw new Error(`workspace_not_directory:${workspaceDir}`);
    }
    const maxFiles = normalizePositiveLimit(options.maxFiles, DEFAULT_WORKSPACE_MAX_FILES);
    const maxTotalBytes = normalizePositiveLimit(options.maxTotalBytes, DEFAULT_WORKSPACE_MAX_TOTAL_BYTES);
    const maxFileBytes = normalizePositiveLimit(options.maxFileBytes, DEFAULT_WORKSPACE_MAX_FILE_BYTES);
    const workspaceId = sha256(Buffer.from(workspaceRealPath, 'utf8'));
    const policyBinding = resolveWorkspaceCollectionPolicy(options.getCollectionPolicy);
    const inventory = await listWorkspacePaths(workspaceRealPath, maxFiles, policyBinding, options.signal, options.onWarning, options.includeBinaryArtifacts, options.excludedDirectoryNames);
    const policy = {
        workspaceVersion: policyBinding.workspaceVersion,
        rawCount: inventory.rawCount,
        excludedCount: inventory.excludedCount,
    };
    if (inventory.limitExceeded) {
        return {
            status: 'skipped_limit',
            workspaceId,
            workspaceRealPath,
            reason: 'file_count',
            limit: maxFiles,
            observed: maxFiles + 1,
            policy,
        };
    }
    const fileScan = await scanWorkspaceFiles({
        workspaceRealPath,
        paths: inventory.paths,
        maxFiles,
        maxTotalBytes,
        maxFileBytes,
        isExcludedPath: policyBinding.excludesWorkspacePath,
        // 候选集放行了二进制,内容阶段也必须放行:否则 PDF / 压缩包会在哈希后
        // 按样本内容被再次丢弃,Handoff 仍旧拿不到用户交给 Agent 的产物。
        includeBinaryArtifacts: options.includeBinaryArtifacts,
        ...(options.signal ? { signal: options.signal } : {}),
    });
    if (fileScan.status === 'skipped_limit') {
        return {
            ...fileScan,
            workspaceId,
            workspaceRealPath,
            policy,
        };
    }
    const files = fileScan.files;
    files.sort((left, right) => compareWorkspacePaths(left.path, right.path));
    const manifestEntries = files.map(toManifestEntry);
    return {
        status: 'ready',
        workspaceId,
        workspaceRealPath,
        rootHash: computeWorkspaceRootHash(manifestEntries),
        totalBytes: fileScan.totalBytes,
        inventoryFingerprint: fileScan.inventoryFingerprint,
        policy,
        files,
    };
}
/**
 * Checks whether a prepared scan still describes the filtered Workspace
 * without reopening and hashing every source file. Content-changing writes
 * update size, mtime, ctime, inode, or inventory membership on supported
 * desktop filesystems; the capture writer remains the final content-hash
 * guard when a rebuild is required.
 *
 * A collection-policy change invalidates the artifact outright: the prepared
 * file set was filtered under rules that no longer apply, so reusing it would
 * mix two policies inside one capture chain.
 */
export async function isWorkspaceScanCurrent(workspaceDir, prepared, options = {}) {
    const workspaceRealPath = await realpath(workspaceDir);
    if (path.resolve(workspaceRealPath) !== path.resolve(prepared.workspaceRealPath))
        return false;
    const policyBinding = resolveWorkspaceCollectionPolicy(options.getCollectionPolicy);
    if (policyBinding.workspaceVersion !== prepared.policy.workspaceVersion)
        return false;
    const maxFiles = normalizePositiveLimit(options.maxFiles, DEFAULT_WORKSPACE_MAX_FILES);
    const maxTotalBytes = normalizePositiveLimit(options.maxTotalBytes, DEFAULT_WORKSPACE_MAX_TOTAL_BYTES);
    const maxFileBytes = normalizePositiveLimit(options.maxFileBytes, DEFAULT_WORKSPACE_MAX_FILE_BYTES);
    // 必须与生成 prepared 的那次扫描用同一集合,否则文件集不同会被误判为过期。
    const inventory = await listWorkspacePaths(workspaceRealPath, maxFiles, policyBinding, options.signal, options.onWarning, options.includeBinaryArtifacts, options.excludedDirectoryNames);
    if (inventory.limitExceeded)
        return false;
    const current = await fingerprintWorkspaceFiles({
        workspaceRealPath,
        paths: inventory.paths,
        maxFiles,
        maxTotalBytes,
        maxFileBytes,
        isExcludedPath: policyBinding.excludesWorkspacePath,
        ...(options.signal ? { signal: options.signal } : {}),
    });
    return (current.status === 'ready' && current.inventoryFingerprint === prepared.inventoryFingerprint);
}
export function computeWorkspaceRootHash(entries) {
    const canonical = [...entries]
        .sort((left, right) => compareWorkspacePaths(left.path, right.path))
        .map((entry) => entry.kind === 'file'
        ? ['file', entry.path, entry.mode, entry.size, entry.sha256]
        : ['symlink', entry.path, entry.mode, entry.linkTarget, entry.sha256]);
    return sha256(Buffer.from(JSON.stringify(canonical), 'utf8'));
}
export function toManifestEntry(entry) {
    if (entry.kind === 'file') {
        return {
            path: entry.path,
            kind: 'file',
            size: entry.size,
            mode: entry.mode,
            sha256: entry.sha256,
        };
    }
    return {
        path: entry.path,
        kind: 'symlink',
        size: 0,
        mode: entry.mode,
        linkTarget: entry.linkTarget,
        sha256: entry.sha256,
    };
}
/**
 * Enumerates the capturable inventory.
 *
 * Policy exclusions are handed to ripgrep as negative `--iglob` arguments so
 * excluded trees are never walked and never consume the `maxStdoutRecords`
 * budget — otherwise a large excluded directory could push the Workspace over
 * the file-count limit and skip indexing for content the user never intended
 * to send. The same predicate then re-filters the git inventory, which
 * deliberately reports ignored-but-tracked files and would otherwise smuggle
 * excluded paths back in.
 */
async function listWorkspacePaths(workspaceRealPath, maxFiles, policy, signal, onWarning, includeBinaryArtifacts = false, excludedDirectoryNames = []) {
    if (excludedDirectoryNames.some((name) => !/^[a-zA-Z0-9_.-]+$/u.test(name) || name === '.' || name === '..')) {
        throw new Error('invalid_workspace_excluded_directory');
    }
    const excludedNames = new Set(excludedDirectoryNames.map((name) => name.toLowerCase()));
    // broadFileScan 让 rg 在进程层面用 --iglob 排除非文本产物;Handoff 需要这些
    // 产物进入候选集,故关闭该项后再由 isCapturableInventoryPath 施加其余边界。
    const args = [
        ...buildGlobArgs({ pattern: '**/*', broadFileScan: !includeBinaryArtifacts }),
        ...excludedDirectoryNames.map((name) => `--iglob=!**/${name}/**`),
        ...policy.excludeArgs,
        '--null',
    ];
    const result = await runRg(args, workspaceRealPath, {
        ...(signal ? { signal } : {}),
        maxStdoutBytes: RG_INVENTORY_MAX_BYTES,
        stdoutRecordSeparator: '\0',
        maxStdoutRecords: maxFiles + 1,
        timeoutMs: 60_000,
    });
    if (result.timedOut)
        throw new Error('workspace_scan_timed_out');
    let rawCount = 0;
    let excludedCount = 0;
    const acceptPath = (value) => {
        if (value.length === 0)
            return false;
        rawCount += 1;
        if (!isCapturableInventoryPath(value, includeBinaryArtifacts))
            return false;
        if (value
            .replaceAll('\\', '/')
            .split('/')
            .some((segment) => excludedNames.has(segment.toLowerCase()))) {
            return false;
        }
        if (policy.excludesWorkspacePath(value)) {
            excludedCount += 1;
            return false;
        }
        return true;
    };
    const rgPaths = result.stdout
        .split('\0')
        .map((value) => value.replaceAll('\\', '/'))
        .filter(acceptPath);
    if (result.stdoutLimitReached) {
        return {
            paths: rgPaths.slice(0, maxFiles + 1),
            limitExceeded: true,
            rawCount,
            excludedCount,
        };
    }
    if (result.stdoutTruncated)
        throw new Error('workspace_scan_output_truncated');
    if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(`workspace_scan_failed:${result.stderr.trim() || `ripgrep_exit_${result.exitCode}`}`);
    }
    const unique = new Set(rgPaths);
    const gitInventory = await appendGitWorkspacePaths({
        workspaceDir: workspaceRealPath,
        paths: unique,
        maxFiles,
        includePath: acceptPath,
        ...(signal ? { signal } : {}),
    });
    if (gitInventory.status === 'limit_exceeded') {
        return { paths: [...unique], limitExceeded: true, rawCount, excludedCount };
    }
    if (gitInventory.status === 'failed') {
        onWarning?.({
            code: 'workspace_git_inventory_failed',
            message: gitInventory.message,
        });
    }
    return {
        paths: [...unique].sort(compareWorkspacePaths),
        limitExceeded: false,
        rawCount,
        excludedCount,
    };
}
function isCapturableInventoryPath(value, includeBinaryArtifacts = false) {
    return (value.length > 0 &&
        isSafeRelativePath(value) &&
        !isDefaultScanNoisePath(value) &&
        !isSensitiveSearchPath(value) &&
        !isWorkspaceCaptureSensitivePath(value) &&
        (includeBinaryArtifacts || !isDefaultBroadFileExcluded(value)));
}
function isWorkspaceCaptureSensitivePath(value) {
    const normalized = value.replaceAll('\\', '/').toLowerCase();
    const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
    if (WORKSPACE_CAPTURE_SENSITIVE_FILENAMES.has(leaf))
        return true;
    if (normalized.endsWith('/.docker/config.json') || normalized === '.docker/config.json') {
        return true;
    }
    if (/^(?:client[-_]?secret|service[-_]?account|credentials)(?:[-_.].*)?\.json$/u.test(leaf)) {
        return true;
    }
    return WORKSPACE_CAPTURE_SENSITIVE_EXTENSIONS.some((extension) => leaf.endsWith(extension));
}
function isSafeRelativePath(value) {
    if (!value || path.posix.isAbsolute(value))
        return false;
    const normalized = path.posix.normalize(value);
    return normalized !== '..' && !normalized.startsWith('../') && normalized === value;
}
function normalizePositiveLimit(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isFinite(value) || value < 0)
        throw new Error(`invalid_workspace_limit:${value}`);
    return Math.floor(value);
}
export function compareWorkspacePaths(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
//# sourceMappingURL=scanner.js.map