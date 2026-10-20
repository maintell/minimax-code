import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { dataDirFs, dataDirFsConstants } from "./data-dir-fs.js";
import { resolveLocalRuntimeDataDir, getDefaultLocalRuntimeDataParentDir, resolveLocalRuntimeDataDirFromParent, getConfiguredLocalRuntimeDataParentDir, setConfiguredLocalRuntimeDataParentDir } from "./data-dir";
import { blockUtilityRuntimeStart } from "./runtime-start-guard";
import { assertInternalDataDirStorage, DataDirStorageError, probeDataDirWrites } from "./data-dir-storage";
export class LocalRuntimeDataDirRelocationError extends Error {
    constructor(code, message, cause) {
        super(message);
        this.code = code;
        this.cause = cause;
        this.name = 'LocalRuntimeDataDirRelocationError';
    }
}

function normalizeDir(dir) {
    return path.resolve(dir.trim());
}
function sameDir(a, b, platform) {
    const left = normalizeDir(a);
    const right = normalizeDir(b);
    return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function isSubPath(candidate, parent, platform) {
    const relative = path.relative(normalizeDir(parent), normalizeDir(candidate));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`))
        return false;
    return platform === 'win32' ? !path.isAbsolute(relative) : true;
}
function isSameOrInsideDir(candidate, parent, platform) {
    return sameDir(candidate, parent, platform) || isSubPath(candidate, parent, platform);
}
function uniqueDirs(dirs, platform) {
    const seen = new Set();
    const result = [];
    for (const dir of dirs) {
        const trimmed = dir?.trim();
        if (!trimmed)
            continue;
        const normalized = normalizeDir(trimmed);
        const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(normalized);
    }
    return result;
}
async function statDirectory(dir, code) {
    let stat;
    try {
        stat = await dataDirFs.stat(dir);
    }
    catch (error) {
        throw new LocalRuntimeDataDirRelocationError(code, `${dir} is not accessible: ${String(error)}`);
    }
    if (!stat.isDirectory()) {
        throw new LocalRuntimeDataDirRelocationError(code === 'INVALID_PARENT' ? 'PARENT_NOT_DIRECTORY' : 'TARGET_NOT_DIRECTORY', `${dir} is not a directory`);
    }
    return stat;
}
async function assertReadableWritableDirectory(dir, code) {
    await statDirectory(dir, code);
    try {
        await dataDirFs.access(dir, dataDirFsConstants.R_OK | dataDirFsConstants.W_OK);
    }
    catch (error) {
        throw new LocalRuntimeDataDirRelocationError(code, `${dir} is not readable/writable: ${String(error)}`);
    }
}
async function directoryExists(dir) {
    try {
        await dataDirFs.access(dir, dataDirFsConstants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
async function assertCurrentDataDir(dataDir) {
    try {
        const stat = await dataDirFs.stat(dataDir);
        if (!stat.isDirectory()) {
            throw new LocalRuntimeDataDirRelocationError('CURRENT_DATA_DIR_MISSING', `${dataDir} is not a directory`);
        }
    }
    catch (error) {
        if (error instanceof LocalRuntimeDataDirRelocationError)
            throw error;
        throw new LocalRuntimeDataDirRelocationError('CURRENT_DATA_DIR_MISSING', `${dataDir} is not accessible: ${String(error)}`);
    }
}
async function inspectTargetDataDir(targetDataDir) {
    try {
        const stat = await dataDirFs.stat(targetDataDir);
        if (!stat.isDirectory()) {
            throw new LocalRuntimeDataDirRelocationError('TARGET_NOT_DIRECTORY', `${targetDataDir} exists but is not a directory`);
        }
        await dataDirFs.access(targetDataDir, dataDirFsConstants.R_OK | dataDirFsConstants.W_OK);
        const entries = await dataDirFs.readdir(targetDataDir);
        return entries.length === 0 ? 'empty' : 'non-empty';
    }
    catch (error) {
        if (error instanceof LocalRuntimeDataDirRelocationError)
            throw error;
        const nodeError = error;
        if (nodeError.code === 'ENOENT')
            return 'missing';
        throw new LocalRuntimeDataDirRelocationError('TARGET_UNAVAILABLE', `${targetDataDir} is not accessible: ${String(error)}`);
    }
}
function resolveSupportedCurrentDataDirName(currentDataDir) {
    const basename = path.basename(currentDataDir);
    if (basename !== '.minimax' && !basename.startsWith('.minimax-')) {
        throw new LocalRuntimeDataDirRelocationError('CURRENT_DATA_DIR_UNSUPPORTED', `Current data directory must use .minimax or .minimax-* basename: ${currentDataDir}`);
    }
    return basename;
}
function deriveCurrentParentDir(currentDataDir) {
    resolveSupportedCurrentDataDirName(currentDataDir);
    return path.dirname(currentDataDir);
}
function remapSymlinkTarget(linkSourcePath, linkTarget, sourceRoot, targetRoot, platform) {
    const absoluteSourceTarget = path.isAbsolute(linkTarget)
        ? normalizeDir(linkTarget)
        : normalizeDir(path.resolve(path.dirname(linkSourcePath), linkTarget));
    if (sameDir(absoluteSourceTarget, sourceRoot, platform) ||
        isSubPath(absoluteSourceTarget, sourceRoot, platform)) {
        return path.join(targetRoot, path.relative(sourceRoot, absoluteSourceTarget));
    }
    return linkTarget;
}
function isInternalSymlinkTarget(linkSourcePath, linkTarget, sourceRoot, platform) {
    const absoluteSourceTarget = path.isAbsolute(linkTarget)
        ? normalizeDir(linkTarget)
        : normalizeDir(path.resolve(path.dirname(linkSourcePath), linkTarget));
    return (sameDir(absoluteSourceTarget, sourceRoot, platform) ||
        isSubPath(absoluteSourceTarget, sourceRoot, platform));
}
async function copyFileWithMetadata(sourcePath, targetPath) {
    await dataDirFs.copyFile(sourcePath, targetPath);
    const stat = await dataDirFs.stat(sourcePath);
    await dataDirFs.chmod(targetPath, stat.mode).catch(() => { });
    await dataDirFs.utimes(targetPath, stat.atime, stat.mtime).catch(() => { });
}
// Hash paths instead of logging user names, workspace names or raw fs messages.
// The ASAR marker still makes virtual-filesystem regressions diagnosable.
function describeMigrationPath(filePath) {
    const id = createHash('sha256').update(filePath).digest('hex').slice(0, 12);
    const asar = filePath.split(/[\\/]/).some((part) => part.endsWith('.asar'));
    return `${id}(asar=${asar})`;
}
function describeMigrationError(error) {
    if (error instanceof DataDirCopyError)
        return error.message;
    const nodeError = error;
    const code = typeof nodeError?.code === 'string' && /^[A-Z_0-9]+$/.test(nodeError.code)
        ? nodeError.code
        : 'unknown';
    const syscall = typeof nodeError?.syscall === 'string' && /^[a-zA-Z0-9_]+$/.test(nodeError.syscall)
        ? nodeError.syscall
        : 'unknown';
    return `code=${code}; syscall=${syscall}`;
}
class DataDirCopyError extends Error {
    constructor(operation, sourcePath, targetPath, cause) {
        super(`operation=${operation}; source=${describeMigrationPath(sourcePath)}; target=${describeMigrationPath(targetPath)}; ${describeMigrationError(cause)}`);
        this.cause = cause;
    }
}
async function copyDataDirEntry(sourcePath, targetPath, pendingSymlinks) {
    let operation = 'lstat';
    try {
        const stat = await dataDirFs.lstat(sourcePath);
        if (stat.isSymbolicLink()) {
            operation = 'readlink';
            pendingSymlinks.push({
                sourcePath,
                targetPath,
                linkTarget: await dataDirFs.readlink(sourcePath),
            });
            return;
        }
        if (stat.isDirectory()) {
            operation = 'mkdir';
            await dataDirFs.mkdir(targetPath, { recursive: true, mode: stat.mode });
            operation = 'readdir';
            const entries = await dataDirFs.readdir(sourcePath);
            for (const entry of entries) {
                await copyDataDirEntry(path.join(sourcePath, entry), path.join(targetPath, entry), pendingSymlinks);
            }
            await dataDirFs.utimes(targetPath, stat.atime, stat.mtime).catch(() => { });
            return;
        }
        if (stat.isFile()) {
            operation = 'mkdir';
            await dataDirFs.mkdir(path.dirname(targetPath), { recursive: true });
            operation = 'copy-file';
            await copyFileWithMetadata(sourcePath, targetPath);
            return;
        }
        operation = 'unsupported-entry';
        throw new Error('Unsupported data directory entry');
    }
    catch (error) {
        if (error instanceof DataDirCopyError)
            throw error;
        throw new DataDirCopyError(operation, sourcePath, targetPath, error);
    }
}
async function copyPendingSymlink(pending, sourceRoot, targetRoot, platform, targetPath = pending.targetPath) {
    const isInternal = isInternalSymlinkTarget(pending.sourcePath, pending.linkTarget, sourceRoot, platform);
    await dataDirFs.mkdir(path.dirname(targetPath), { recursive: true });
    let targetStat;
    try {
        targetStat = await dataDirFs.stat(pending.sourcePath);
    }
    catch {
        targetStat = null;
    }
    const remappedTarget = isInternal
        ? remapSymlinkTarget(pending.sourcePath, pending.linkTarget, sourceRoot, targetRoot, platform)
        : pending.linkTarget;
    if (platform === 'win32') {
        if (!isInternal || !targetStat) {
            return;
        }
        if (targetStat?.isDirectory()) {
            await dataDirFs.symlink(remappedTarget, targetPath, 'junction');
            return;
        }
        if (targetStat?.isFile()) {
            await copyFileWithMetadata(pending.sourcePath, targetPath);
            return;
        }
    }
    await dataDirFs.symlink(remappedTarget, targetPath, targetStat?.isDirectory() ? 'dir' : 'file');
}
async function copyLocalRuntimeDataDirEntries(sourceRoot, targetRoot) {
    const pendingSymlinks = [];
    await copyDataDirEntry(sourceRoot, targetRoot, pendingSymlinks);
    return pendingSymlinks;
}
function captureDataDirEnv() {
    return {
        minimaxDataDir: process.env.MINIMAX_DATA_DIR,
        mavisDataDir: process.env.MAVIS_DATA_DIR,
        legacyDataDir: process.env.__MAVIS_RUNTIME_DATA_DIR,
        legacyProfile: process.env.__MAVIS_RUNTIME_PROFILE,
    };
}
function restoreDataDirEnv(snapshot) {
    if (snapshot.minimaxDataDir === undefined)
        delete process.env.MINIMAX_DATA_DIR;
    else
        process.env.MINIMAX_DATA_DIR = snapshot.minimaxDataDir;
    if (snapshot.mavisDataDir === undefined)
        delete process.env.MAVIS_DATA_DIR;
    else
        process.env.MAVIS_DATA_DIR = snapshot.mavisDataDir;
    if (snapshot.legacyDataDir === undefined)
        delete process.env.__MAVIS_RUNTIME_DATA_DIR;
    else
        process.env.__MAVIS_RUNTIME_DATA_DIR = snapshot.legacyDataDir;
    if (snapshot.legacyProfile === undefined)
        delete process.env.__MAVIS_RUNTIME_PROFILE;
    else
        process.env.__MAVIS_RUNTIME_PROFILE = snapshot.legacyProfile;
}
function clearDataDirEnv() {
    delete process.env.MINIMAX_DATA_DIR;
    delete process.env.MAVIS_DATA_DIR;
    delete process.env.__MAVIS_RUNTIME_DATA_DIR;
    delete process.env.__MAVIS_RUNTIME_PROFILE;
}
export function getLocalRuntimeDataDirInfo(config) {
    const configuredParent = typeof config.localRuntimeDataParentDir === 'string' && config.localRuntimeDataParentDir.trim()
        ? normalizeDir(config.localRuntimeDataParentDir)
        : null;
    const currentDataDir = resolveLocalRuntimeDataDir(undefined, os.homedir());
    const defaultParentDir = path.basename(currentDataDir) === '.minimax' ||
        path.basename(currentDataDir).startsWith('.minimax-')
        ? path.dirname(currentDataDir)
        : getDefaultLocalRuntimeDataParentDir(os.homedir());
    const parentDir = configuredParent ?? defaultParentDir;
    const dataDirName = path.basename(currentDataDir);
    const dataDir = configuredParent
        ? resolveLocalRuntimeDataDirFromParent(parentDir, dataDirName)
        : currentDataDir;
    const previousParentDirs = Array.isArray(config.localRuntimePreviousDataParentDirs)
        ? config.localRuntimePreviousDataParentDirs.filter((dir) => typeof dir === 'string')
        : [];
    return {
        parentDir,
        dataDir,
        isCustom: Boolean(configuredParent),
        previousParentDirs: uniqueDirs(previousParentDirs, process.platform),
    };
}
export async function relocateLocalRuntimeDataDir(options) {
    const platform = options.platform ?? process.platform;
    const previousConfiguredLocalRuntimeDataParentDir = getConfiguredLocalRuntimeDataParentDir();
    const previousDataDirEnv = captureDataDirEnv();
    if (platform !== 'win32') {
        throw new LocalRuntimeDataDirRelocationError('WINDOWS_ONLY', 'Local runtime data directory changes are only supported on Windows');
    }
    if (!options.targetParentDir.trim()) {
        throw new LocalRuntimeDataDirRelocationError('INVALID_PARENT', 'Target parent directory is empty');
    }
    const requestedTargetParentDir = normalizeDir(options.targetParentDir);
    await assertReadableWritableDirectory(requestedTargetParentDir, 'INVALID_PARENT');
    const targetParentDir = await dataDirFs.realpath(requestedTargetParentDir);
    try {
        await assertInternalDataDirStorage(targetParentDir);
    }
    catch (error) {
        if (error instanceof DataDirStorageError) {
            throw new LocalRuntimeDataDirRelocationError(error.code, error.message);
        }
        throw error;
    }
    const currentDataDir = normalizeDir(options.currentDataDir ?? resolveLocalRuntimeDataDir());
    const currentDataDirName = resolveSupportedCurrentDataDirName(currentDataDir);
    const currentParentDir = normalizeDir(options.currentParentDir ?? deriveCurrentParentDir(currentDataDir));
    const targetDataDir = resolveLocalRuntimeDataDirFromParent(targetParentDir, currentDataDirName);
    // Compare physical paths too: junctions can alias the source or the installation directory.
    // A missing source is allowed only when switching back to an existing historical directory.
    const realCurrentDataDir = await dataDirFs
        .realpath(currentDataDir)
        .catch((error) => {
        if (error.code === 'ENOENT')
            return currentDataDir;
        throw error;
    });
    const previousParentDirs = uniqueDirs(options.previousParentDirs ?? [], platform);
    const targetIsPrevious = previousParentDirs.some((dir) => sameDir(dir, targetParentDir, platform) || sameDir(dir, requestedTargetParentDir, platform));
    if (sameDir(targetDataDir, realCurrentDataDir, platform) ||
        sameDir(targetParentDir, currentParentDir, platform)) {
        throw new LocalRuntimeDataDirRelocationError('TARGET_SAME_AS_CURRENT', 'Target data directory is the current data directory');
    }
    if (isSubPath(targetDataDir, realCurrentDataDir, platform)) {
        throw new LocalRuntimeDataDirRelocationError('TARGET_INSIDE_CURRENT', 'Target data directory cannot be inside the current data directory');
    }
    if (typeof options.appInstallDir === 'string' &&
        options.appInstallDir.trim() &&
        isSameOrInsideDir(targetDataDir, await dataDirFs.realpath(options.appInstallDir), platform)) {
        throw new LocalRuntimeDataDirRelocationError('TARGET_INSIDE_INSTALL_DIR', 'Target data directory cannot be inside the app install directory');
    }
    const targetState = await inspectTargetDataDir(targetDataDir);
    if (targetState !== 'missing' && (await dataDirFs.lstat(targetDataDir)).isSymbolicLink()) {
        throw new LocalRuntimeDataDirRelocationError('TARGET_UNAVAILABLE', 'Target data directory cannot be a link');
    }
    const shouldSwitchToPrevious = targetIsPrevious && targetState === 'non-empty';
    let configCommitted = false;
    if (!shouldSwitchToPrevious && targetState === 'non-empty') {
        throw new LocalRuntimeDataDirRelocationError('TARGET_NOT_EMPTY', `${targetDataDir} must be empty or absent`);
    }
    if (!shouldSwitchToPrevious) {
        await assertCurrentDataDir(currentDataDir);
    }
    try {
        await probeDataDirWrites(targetParentDir);
    }
    catch (error) {
        throw new LocalRuntimeDataDirRelocationError('TARGET_UNAVAILABLE', `Target write probe failed: ${String(error)}`);
    }
    const nextPreviousParentDirs = uniqueDirs([currentParentDir, ...previousParentDirs], platform);
    const tmpDataDir = path.join(targetParentDir, `${currentDataDirName}.tmp-${process.pid}-${Date.now().toString(36)}`);
    let createdTargetByCopy = false;
    // Hold the start lock through the relaunch request so reconnecting
    // renderers cannot reopen the old runtime while this process is still alive.
    const releaseRuntimeStartBlock = blockUtilityRuntimeStart();
    let runtimeStartBlockReleased = false;
    const releaseRuntimeStartBlockOnce = () => {
        if (runtimeStartBlockReleased)
            return;
        runtimeStartBlockReleased = true;
        releaseRuntimeStartBlock();
    };
    let stage = 'stop-runtime';
    try {
        const stopResult = await options.stopLocalRuntime();
        if (stopResult.status === 'quarantined') {
            throw new LocalRuntimeDataDirRelocationError('RUNTIME_STOP_UNCONFIRMED', 'Local Runtime exit was not confirmed; data directory migration was cancelled');
        }
        if (!shouldSwitchToPrevious) {
            stage = 'clean-temp';
            await dataDirFs.rm(tmpDataDir, { recursive: true, force: true });
            stage = 'copy';
            const pendingSymlinks = await copyLocalRuntimeDataDirEntries(currentDataDir, tmpDataDir);
            stage = 'remove-empty-target';
            if (targetState === 'empty' && (await directoryExists(targetDataDir))) {
                await dataDirFs.rm(targetDataDir, { recursive: true, force: false });
            }
            stage = 'rename';
            await dataDirFs.rename(tmpDataDir, targetDataDir);
            createdTargetByCopy = true;
            stage = 'rebuild-links';
            for (const pending of pendingSymlinks) {
                const finalTargetPath = path.join(targetDataDir, path.relative(tmpDataDir, pending.targetPath));
                await copyPendingSymlink(pending, currentDataDir, targetDataDir, platform, finalTargetPath);
            }
        }
        stage = 'save-config';
        await options.saveConfig({
            localRuntimeDataParentDir: targetParentDir,
            localRuntimePreviousDataParentDirs: nextPreviousParentDirs,
        });
        configCommitted = true;
        setConfiguredLocalRuntimeDataParentDir(targetParentDir);
        // app.relaunch() inherits process.env. Clear the old app-injected data
        // directory so the next process resolves from the saved desktop config.
        clearDataDirEnv();
        stage = 'relaunch';
        await options.relaunch();
        return {
            success: true,
            mode: shouldSwitchToPrevious ? 'switched' : 'migrated',
            parentDir: targetParentDir,
            dataDir: targetDataDir,
            previousParentDirs: nextPreviousParentDirs,
        };
    }
    catch (error) {
        const cleanupFailures = [];
        await dataDirFs.rm(tmpDataDir, { recursive: true, force: true }).catch((cleanupError) => {
            cleanupFailures.push(`temp: ${describeMigrationError(cleanupError)}`);
        });
        if (createdTargetByCopy) {
            await dataDirFs
                .rm(targetDataDir, { recursive: true, force: true })
                .catch((cleanupError) => {
                cleanupFailures.push(`target: ${describeMigrationError(cleanupError)}`);
            });
        }
        releaseRuntimeStartBlockOnce();
        if (configCommitted) {
            await options.saveConfig(options.previousConfig);
            setConfiguredLocalRuntimeDataParentDir(previousConfiguredLocalRuntimeDataParentDir);
            restoreDataDirEnv(previousDataDirEnv);
        }
        const runtimeExitUnconfirmed = error instanceof LocalRuntimeDataDirRelocationError &&
            error.code === 'RUNTIME_STOP_UNCONFIRMED';
        if (options.prepareLocalRuntime && !runtimeExitUnconfirmed) {
            await options.prepareLocalRuntime().catch(() => { });
        }
        if (error instanceof LocalRuntimeDataDirRelocationError)
            throw error;
        throw new LocalRuntimeDataDirRelocationError('MIGRATION_FAILED', `Failed to relocate local runtime data directory: stage=${stage}; ${describeMigrationError(error)}; cleanup=${cleanupFailures.length ? cleanupFailures.join(', ') : 'ok'}`, error);
    }
}
