import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const NEW_DATA_DIR_BASENAME = '.minimax';
export const LEGACY_DATA_DIR_BASENAME = '.mavis';
const noopLogger = {
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
};
function resolveHomeDir(homeDir) {
    return homeDir ?? os.homedir();
}
function basenameForProfile(base, profile) {
    return profile ? `${base}-${profile}` : base;
}
export function getPrimaryDataDirPath(homeDir, profile) {
    return path.join(resolveHomeDir(homeDir), basenameForProfile(NEW_DATA_DIR_BASENAME, profile));
}
export function getLegacyDataDirPath(homeDir, profile) {
    return path.join(resolveHomeDir(homeDir), basenameForProfile(LEGACY_DATA_DIR_BASENAME, profile));
}
function pathState(targetPath) {
    try {
        const stat = fs.lstatSync(targetPath);
        if (stat.isSymbolicLink())
            return { kind: 'link' };
        if (stat.isDirectory())
            return { kind: 'directory' };
        return { kind: 'other' };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return { kind: 'missing' };
        return { kind: 'inaccessible', error };
    }
}
function normalizeResolvedPathForCompare(targetPath) {
    let normalized = path.resolve(targetPath);
    if (process.platform === 'win32') {
        normalized = normalized.replace(/^\\\\\?\\/, '');
        return normalized.toLowerCase();
    }
    return normalized;
}
function isLinkTo(linkPath, target) {
    try {
        const resolved = fs.readlinkSync(linkPath);
        const targetPath = normalizeResolvedPathForCompare(target);
        return (normalizeResolvedPathForCompare(path.resolve(path.dirname(linkPath), resolved)) ===
            targetPath || normalizeResolvedPathForCompare(resolved) === targetPath);
    }
    catch {
        return false;
    }
}
function createCompatLink(legacyDir, newDir, logger) {
    if (isLinkTo(legacyDir, newDir))
        return;
    try {
        fs.symlinkSync(newDir, legacyDir, process.platform === 'win32' ? 'junction' : 'dir');
    }
    catch (error) {
        logger.warn(`Failed to create compat link ${legacyDir} -> ${newDir}: ${String(error)}`);
    }
}
function removePathForLink(pathToRemove, state, logger) {
    if (state.kind === 'missing')
        return true;
    if (state.kind === 'link' || state.kind === 'other') {
        try {
            fs.unlinkSync(pathToRemove);
            return true;
        }
        catch (error) {
            logger.warn(`Failed to remove ${pathToRemove} before creating compat link: ${String(error)}`);
            return false;
        }
    }
    return false;
}
function contentState(dirPath) {
    try {
        const entries = fs.readdirSync(dirPath);
        if (entries.length === 0)
            return 'empty';
        if (entries.length === 1 && entries[0] === 'workspace') {
            try {
                return fs.readdirSync(path.join(dirPath, 'workspace')).length > 0 ? 'hasData' : 'empty';
            }
            catch {
                return 'unknown';
            }
        }
        return 'hasData';
    }
    catch {
        return 'unknown';
    }
}
function linkTargetDirectoryContentState(linkPath) {
    try {
        if (!fs.statSync(linkPath).isDirectory())
            return undefined;
        return contentState(linkPath);
    }
    catch {
        return 'unknown';
    }
}
function backupPathFor(legacyDir, nowMs) {
    return `${legacyDir}.backup-${nowMs()}`;
}
function backupRealLegacyDir(legacyDir, logger, nowMs) {
    const backupDir = backupPathFor(legacyDir, nowMs);
    try {
        fs.renameSync(legacyDir, backupDir);
        logger.warn(`Backed up legacy data dir ${legacyDir} -> ${backupDir}`);
        return true;
    }
    catch (error) {
        logger.warn(`Failed to back up legacy data dir ${legacyDir}: ${String(error)}`);
        return false;
    }
}
function prepareLegacyPathForLink(legacyDir, newDir, logger, nowMs) {
    if (isLinkTo(legacyDir, newDir))
        return true;
    const legacyState = pathState(legacyDir);
    if (legacyState.kind === 'missing')
        return true;
    if (legacyState.kind === 'link') {
        const legacyContent = linkTargetDirectoryContentState(legacyDir);
        if (legacyContent === 'hasData' || legacyContent === 'unknown') {
            logger.warn(`Cannot replace legacy data dir symlink ${legacyDir}; it may point to real data outside ${newDir}`);
            return false;
        }
        return removePathForLink(legacyDir, legacyState, logger);
    }
    if (legacyState.kind === 'other') {
        return removePathForLink(legacyDir, legacyState, logger);
    }
    if (legacyState.kind === 'directory') {
        return backupRealLegacyDir(legacyDir, logger, nowMs);
    }
    logger.warn(`Cannot replace inaccessible legacy data dir ${legacyDir}; leaving it untouched`);
    return false;
}
function ensureCompatLink(legacyDir, newDir, logger, nowMs) {
    if (!prepareLegacyPathForLink(legacyDir, newDir, logger, nowMs))
        return;
    createCompatLink(legacyDir, newDir, logger);
}
function removeEmptyPrimaryForMigration(newDir, logger) {
    try {
        fs.rmSync(newDir, { recursive: true, force: false });
        return true;
    }
    catch (error) {
        logger.warn(`Failed to remove empty primary data dir ${newDir}: ${String(error)}`);
        return false;
    }
}
function migrateLegacyIntoPrimary(legacyDir, newDir, logger) {
    try {
        fs.renameSync(legacyDir, newDir);
        logger.info(`Migrated legacy data dir ${legacyDir} -> ${newDir}`);
        return true;
    }
    catch (error) {
        logger.warn(`Failed to migrate legacy data dir ${legacyDir} -> ${newDir}: ${String(error)}`);
        return false;
    }
}
function copyLegacyLinkTargetIntoPrimary(targetDir, legacyDir, newDir, logger) {
    try {
        fs.cpSync(targetDir, newDir, { recursive: true, errorOnExist: true, force: false });
        fs.unlinkSync(legacyDir);
        try {
            fs.rmSync(targetDir, { recursive: true, force: false });
        }
        catch (cleanupError) {
            logger.warn(`Copied legacy symlink data dir ${targetDir} -> ${newDir}, but failed to remove old target: ${String(cleanupError)}`);
        }
        logger.info(`Copied legacy data dir symlink target ${targetDir} -> ${newDir}`);
        return true;
    }
    catch (error) {
        try {
            if (fs.existsSync(newDir))
                fs.rmSync(newDir, { recursive: true, force: true });
        }
        catch (cleanupError) {
            logger.warn(`Failed to clean up partial primary data dir ${newDir}: ${String(cleanupError)}`);
        }
        logger.warn(`Failed to copy legacy symlink data dir ${legacyDir} -> ${newDir}: ${String(error)}`);
        return false;
    }
}
function migrateLegacyLinkTargetIntoPrimary(legacyDir, newDir, logger) {
    try {
        const targetDir = fs.realpathSync(legacyDir);
        try {
            fs.renameSync(targetDir, newDir);
        }
        catch (error) {
            if (error.code === 'EXDEV') {
                return copyLegacyLinkTargetIntoPrimary(targetDir, legacyDir, newDir, logger);
            }
            throw error;
        }
        fs.unlinkSync(legacyDir);
        logger.info(`Migrated legacy data dir symlink target ${targetDir} -> ${newDir}`);
        return true;
    }
    catch (error) {
        logger.warn(`Failed to migrate legacy symlink data dir ${legacyDir} -> ${newDir}: ${String(error)}`);
        return false;
    }
}
function ensurePrimaryDir(newDir, logger) {
    try {
        fs.mkdirSync(newDir, { recursive: true });
        return true;
    }
    catch (error) {
        logger.warn(`Failed to create primary data dir ${newDir}: ${String(error)}`);
        return false;
    }
}
function resolveDataDirPair(newDir, legacyDir, logger, nowMs) {
    const newState = pathState(newDir);
    const legacyState = pathState(legacyDir);
    if (newState.kind === 'inaccessible') {
        logger.warn(`Primary data dir ${newDir} is inaccessible; not treating it as missing`);
        return newDir;
    }
    if (newState.kind === 'directory') {
        const newContent = contentState(newDir);
        const legacyContent = legacyState.kind === 'directory'
            ? contentState(legacyDir)
            : legacyState.kind === 'link'
                ? (linkTargetDirectoryContentState(legacyDir) ?? 'empty')
                : 'empty';
        if (newContent === 'empty') {
            if (legacyState.kind === 'inaccessible' || legacyContent === 'unknown') {
                logger.warn(`Legacy data dir ${legacyDir} may contain data but is inaccessible; not using empty primary ${newDir}`);
                return legacyDir;
            }
            if ((legacyState.kind === 'directory' || legacyState.kind === 'link') &&
                legacyContent === 'hasData') {
                if (!removeEmptyPrimaryForMigration(newDir, logger))
                    return legacyDir;
                if (legacyState.kind === 'link') {
                    if (!migrateLegacyLinkTargetIntoPrimary(legacyDir, newDir, logger))
                        return legacyDir;
                }
                else if (!migrateLegacyIntoPrimary(legacyDir, newDir, logger)) {
                    return legacyDir;
                }
                createCompatLink(legacyDir, newDir, logger);
                return newDir;
            }
        }
        ensureCompatLink(legacyDir, newDir, logger, nowMs);
        return newDir;
    }
    if (isLinkTo(legacyDir, newDir)) {
        ensurePrimaryDir(newDir, logger);
        return newDir;
    }
    if (legacyState.kind === 'directory') {
        if (migrateLegacyIntoPrimary(legacyDir, newDir, logger)) {
            createCompatLink(legacyDir, newDir, logger);
            return newDir;
        }
        return legacyDir;
    }
    if (legacyState.kind === 'link') {
        const legacyContent = linkTargetDirectoryContentState(legacyDir);
        if (legacyContent === 'hasData') {
            if (migrateLegacyLinkTargetIntoPrimary(legacyDir, newDir, logger)) {
                createCompatLink(legacyDir, newDir, logger);
                return newDir;
            }
            return legacyDir;
        }
        if (legacyContent === 'unknown') {
            logger.warn(`Legacy data dir symlink ${legacyDir} target is inaccessible; not treating it as missing`);
            return legacyDir;
        }
    }
    if (legacyState.kind === 'inaccessible') {
        logger.warn(`Legacy data dir ${legacyDir} is inaccessible; not treating it as missing`);
        return legacyDir;
    }
    if (newState.kind === 'link' || newState.kind === 'other') {
        logger.warn(`Primary data dir path ${newDir} exists but is not a directory; using it without migration`);
        return newDir;
    }
    ensurePrimaryDir(newDir, logger);
    ensureCompatLink(legacyDir, newDir, logger, nowMs);
    return newDir;
}
export function resolveDataDir(options = {}) {
    const homeDir = resolveHomeDir(options.homeDir);
    const profile = options.profile ?? null;
    return resolveDataDirPair(getPrimaryDataDirPath(homeDir, profile), getLegacyDataDirPath(homeDir, profile), options.logger ?? noopLogger, options.nowMs ?? Date.now);
}
export function migrateDefaultDataDir(homeDir, logger) {
    return resolveDataDir({ homeDir, logger });
}
export function migrateProfileDataDir(profile, homeDir, logger) {
    return resolveDataDir({ homeDir, profile, logger });
}
//# sourceMappingURL=data-dir.js.map