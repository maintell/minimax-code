import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
const BACKUP_DIRECTORY = join('v2', 'sqlite', 'backups');
const BACKUP_FILE_PREFIX = 'runtime-state-before-v2-migration';
const BACKUP_FILE_PATTERN = new RegExp(`^${BACKUP_FILE_PREFIX}-(\\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`, 'iu');
const DATABASE_BACKUP_INITIALIZATION_ERROR_CODE = 'LOCAL_RUNTIME_V2_DATABASE_BACKUP_FAILED';
class DatabaseBackupInitializationError extends Error {
    code = DATABASE_BACKUP_INITIALIZATION_ERROR_CODE;
    constructor(cause) {
        super('Local runtime database backup failed');
        this.name = 'DatabaseBackupInitializationError';
        if (cause !== undefined)
            this.cause = cause;
    }
}
/**
 * 在待迁移时创建一个经过校验的 SQLite 在线备份。
 * 返回值包含备份标识与校验时的文件元数据，不暴露用户目录或数据库内容。
 */
export async function createDatabaseBackupIfPending(options) {
    if (!options.pending)
        return { created: false };
    const createdAtMs = Date.now();
    const backupId = randomUUID();
    const fileName = `${BACKUP_FILE_PREFIX}-${createdAtMs}-${backupId}.sqlite`;
    let resolvedDataDir;
    let destinationPath;
    try {
        resolvedDataDir = await resolveBackupDataDir(options.dataDir);
        if (!resolvedDataDir || !(await ensurePlainBackupDirectoryChain(resolvedDataDir))) {
            throw new Error('unsafe backup directory');
        }
        destinationPath = join(resolvedDataDir, BACKUP_DIRECTORY, fileName);
        const backupStartedAtMs = Date.now();
        await options.database.backup(destinationPath);
        const backupMs = Math.max(0, Date.now() - backupStartedAtMs);
        if (!(await hasPlainBackupDirectoryChain(resolvedDataDir))) {
            throw new Error('unsafe backup directory after write');
        }
        const integrityStartedAtMs = Date.now();
        const verifiedFileIdentity = await verifyCreatedBackup(options.database, destinationPath);
        const integrityMs = Math.max(0, Date.now() - integrityStartedAtMs);
        const sizeBytes = readIdentitySizeBytes(verifiedFileIdentity);
        return {
            created: true,
            backupId,
            fileName,
            createdAtMs,
            verifiedFileIdentity,
            backupMs,
            integrityMs,
            ...(sizeBytes === undefined ? {} : { sizeBytes }),
        };
    }
    catch (error) {
        if (resolvedDataDir &&
            destinationPath &&
            (await hasPlainBackupDirectoryChain(resolvedDataDir))) {
            await removeBackupFamily(destinationPath);
        }
        throw new DatabaseBackupInitializationError(error);
    }
}
/**
 * 在完整 migration 与最终 schema 校验成功后，仅以本次创建的精确备份
 * 为删除授权。普通启动不得调用；未知、同时间或更新的文件一律保留。
 */
export async function pruneSupersededDatabaseBackups(options) {
    if (!validCreatedBackupIdentity(options.retainedBackup))
        return { deleted: 0 };
    const resolvedDataDir = await resolveBackupDataDir(options.dataDir);
    if (!resolvedDataDir || !(await hasPlainBackupDirectoryChain(resolvedDataDir))) {
        return { deleted: 0 };
    }
    const directoryPath = join(resolvedDataDir, BACKUP_DIRECTORY);
    const retainedPath = join(directoryPath, options.retainedBackup.fileName);
    const verifiedIdentity = options.retainedBackup.verifiedFileIdentity;
    if (!verifiedIdentity || (await readBackupFileIdentity(retainedPath)) !== verifiedIdentity) {
        return { deleted: 0 };
    }
    let entries;
    try {
        entries = await readdir(directoryPath, { withFileTypes: true });
    }
    catch {
        return { deleted: 0 };
    }
    const candidates = entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .flatMap((entry) => {
        const match = BACKUP_FILE_PATTERN.exec(entry.name);
        const createdAtMs = match?.[1] ? Number(match[1]) : Number.NaN;
        return Number.isSafeInteger(createdAtMs) && createdAtMs >= 0
            ? [{ fileName: entry.name, createdAtMs }]
            : [];
    })
        .filter((candidate) => candidate.fileName !== options.retainedBackup.fileName &&
        candidate.createdAtMs < options.retainedBackup.createdAtMs);
    const deleted = await candidates.reduce(async (countPromise, candidate) => {
        const count = await countPromise;
        if (!(await hasPlainBackupDirectoryChain(resolvedDataDir)))
            return count;
        if ((await readBackupFileIdentity(retainedPath)) !== verifiedIdentity)
            return count;
        const path = join(directoryPath, candidate.fileName);
        if (!(await removePlainFile(path)))
            return count;
        await removeBackupSidecars(path);
        return count + 1;
    }, Promise.resolve(0));
    return { deleted, retainedFileName: options.retainedBackup.fileName };
}
function validCreatedBackupIdentity(backup) {
    if (!Number.isSafeInteger(backup.createdAtMs) || backup.createdAtMs < 0)
        return false;
    const expectedFileName = `${BACKUP_FILE_PREFIX}-${String(backup.createdAtMs)}-${backup.backupId}.sqlite`;
    return backup.fileName === expectedFileName && BACKUP_FILE_PATTERN.test(backup.fileName);
}
async function resolveBackupDataDir(dataDir) {
    try {
        const resolved = await realpath(dataDir);
        return (await isPlainDirectory(resolved)) ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
async function ensurePlainBackupDirectoryChain(dataDir) {
    const paths = backupDirectoryChain(dataDir);
    for (const [index, path] of paths.entries()) {
        if (!(await ensurePlainDirectory(path, index > 0)))
            return false;
    }
    return true;
}
async function ensurePlainDirectory(path, createIfMissing) {
    try {
        const info = await lstat(path);
        return info.isDirectory() && !info.isSymbolicLink();
    }
    catch (error) {
        if (!createIfMissing || !hasCode(error, 'ENOENT'))
            return false;
    }
    try {
        await mkdir(path, { mode: 0o700 });
    }
    catch (error) {
        if (!hasCode(error, 'EEXIST'))
            return false;
    }
    return isPlainDirectory(path);
}
async function removeBackupFamily(databasePath) {
    await removePlainFile(databasePath);
    await removeBackupSidecars(databasePath);
}
async function removeBackupSidecars(databasePath) {
    await Promise.all(['-wal', '-shm'].map((suffix) => removePlainFile(`${databasePath}${suffix}`)));
}
async function removePlainFile(path) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            return false;
        await rm(path);
        return true;
    }
    catch {
        return false;
    }
}
async function hasPlainBackupDirectoryChain(dataDir) {
    for (const path of backupDirectoryChain(dataDir)) {
        try {
            const info = await lstat(path);
            if (!info.isDirectory() || info.isSymbolicLink())
                return false;
        }
        catch {
            return false;
        }
    }
    return true;
}
async function isPlainDirectory(path) {
    try {
        const info = await lstat(path);
        return info.isDirectory() && !info.isSymbolicLink();
    }
    catch {
        return false;
    }
}
async function verifyCreatedBackup(database, path) {
    const identity = await readBackupFileIdentity(path);
    if (!identity || !database.hasValidIntegrity(path))
        throw new Error('integrity check failed');
    return identity;
}
async function readBackupFileIdentity(path) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            return undefined;
        return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    }
    catch {
        return undefined;
    }
}
/**
 * Recovers the size component from an already-captured identity string so the
 * timing diagnostics never issue an extra stat against the backup file.
 */
function readIdentitySizeBytes(identity) {
    const size = Number(identity.split(':')[2]);
    return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}
function backupDirectoryChain(dataDir) {
    return [
        dataDir,
        join(dataDir, 'v2'),
        join(dataDir, 'v2', 'sqlite'),
        join(dataDir, BACKUP_DIRECTORY),
    ];
}
function hasCode(error, code) {
    return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === code);
}
//# sourceMappingURL=backup.js.map