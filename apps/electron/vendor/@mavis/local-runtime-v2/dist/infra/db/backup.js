import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, realpath, rm, stat, statfs, writeFile, } from 'node:fs/promises';
import { join } from 'node:path';
const BACKUP_DIRECTORY = join('v2', 'sqlite', 'backups');
const BACKUP_FILE_PREFIX = 'runtime-state-before-v2-migration';
const BACKUP_FILE_PATTERN = new RegExp(`^${BACKUP_FILE_PREFIX}-(\\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.sqlite$`, 'iu');
const BACKUP_META_SUFFIX = '.meta.json';
/** Headroom over the current database size so WAL growth during the copy cannot ENOSPC mid-write. */
const BACKUP_DISK_SPACE_HEADROOM = 1.2;
const DATABASE_BACKUP_INITIALIZATION_ERROR_CODE = 'LOCAL_RUNTIME_V2_DATABASE_BACKUP_FAILED';
const DATABASE_BACKUP_DISK_SPACE_ERROR_CODE = 'LOCAL_RUNTIME_V2_DATABASE_BACKUP_DISK_SPACE';
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
 * Fail-stop error raised before any backup bytes are written when the backup
 * volume cannot hold a full copy of the database. Migrating without a backup
 * or leaving a truncated copy behind are both unacceptable, so this aborts
 * initialization with its own stable code instead of the generic backup error.
 */
class DatabaseBackupDiskSpaceError extends Error {
    code = DATABASE_BACKUP_DISK_SPACE_ERROR_CODE;
    requiredBytes;
    availableBytes;
    constructor(requiredBytes, availableBytes) {
        super('Local runtime database backup needs more free disk space');
        this.name = 'DatabaseBackupDiskSpaceError';
        this.requiredBytes = requiredBytes;
        this.availableBytes = availableBytes;
    }
}
/**
 * 在待迁移时创建一个经过校验的 SQLite 在线备份。
 *
 * 同一 campaign(源库 identity + applied/pending 版本状态)只保留第一份备份:
 * 命中既有 sidecar 且备份文件 identity 未变时直接复用,不再创建新文件。失败
 * 重试之间数据库已被 recovery 步骤改写,后拷的是半迁移态,作为还原点更差。
 * 返回值包含备份标识与校验时的文件元数据,不暴露用户目录或数据库内容。
 */
export async function createDatabaseBackupIfPending(options) {
    const campaign = options.campaign;
    if (!campaign)
        return { created: false };
    const createdAtMs = Date.now();
    const backupId = randomUUID();
    const fileName = `${BACKUP_FILE_PREFIX}-${createdAtMs}-${backupId}.sqlite`;
    let resolvedDataDir;
    let destinationPath;
    try {
        resolvedDataDir = await resolveVerifiedBackupRoot(options.dataDir);
        const directoryPath = join(resolvedDataDir, BACKUP_DIRECTORY);
        const sourceDbIdentity = await readSourceDbIdentity(options.database.databasePath);
        const campaignKey = computeCampaignKey(campaign, sourceDbIdentity);
        const reusable = await findReusableCampaignBackup(directoryPath, campaignKey);
        if (reusable)
            return reusable;
        await assertBackupDiskSpace(options.database.databasePath, directoryPath);
        destinationPath = join(directoryPath, fileName);
        return await writeVerifiedCampaignBackup({
            database: options.database,
            resolvedDataDir,
            destinationPath,
            campaign,
            campaignKey,
            sourceDbIdentity,
            backupId,
            fileName,
            createdAtMs,
        });
    }
    catch (error) {
        await removeFailedBackupFamily(resolvedDataDir, destinationPath);
        if (error instanceof DatabaseBackupDiskSpaceError)
            throw error;
        throw new DatabaseBackupInitializationError(error);
    }
}
/** Resolves the dataDir and validates/creates the backup directory chain. */
async function resolveVerifiedBackupRoot(dataDir) {
    const resolved = await resolveBackupDataDir(dataDir);
    if (!resolved || !(await ensurePlainBackupDirectoryChain(resolved))) {
        throw new Error('unsafe backup directory');
    }
    return resolved;
}
/** Copies the database, verifies integrity, and records the campaign sidecar. */
async function writeVerifiedCampaignBackup(input) {
    const backupStartedAtMs = Date.now();
    await input.database.backup(input.destinationPath);
    const backupMs = Math.max(0, Date.now() - backupStartedAtMs);
    if (!(await hasPlainBackupDirectoryChain(input.resolvedDataDir))) {
        throw new Error('unsafe backup directory after write');
    }
    const integrityStartedAtMs = Date.now();
    const verifiedFileIdentity = await verifyCreatedBackup(input.database, input.destinationPath);
    const integrityMs = Math.max(0, Date.now() - integrityStartedAtMs);
    const sizeBytes = readIdentitySizeBytes(verifiedFileIdentity);
    await writeCampaignSidecar(input.destinationPath, {
        schemaVersion: 1,
        campaignKey: input.campaignKey,
        sourceDbIdentity: input.sourceDbIdentity,
        verifiedFileIdentity,
        appliedMaxVersion: input.campaign.appliedMaxVersion,
        pendingVersions: sortedVersions(input.campaign.pendingVersions),
        createdAtMs: input.createdAtMs,
    });
    return {
        created: true,
        backupId: input.backupId,
        fileName: input.fileName,
        campaignKey: input.campaignKey,
        createdAtMs: input.createdAtMs,
        verifiedFileIdentity,
        backupMs,
        integrityMs,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
}
/** Best-effort removal of a half-written backup family after a failure. */
async function removeFailedBackupFamily(resolvedDataDir, destinationPath) {
    if (!resolvedDataDir || !destinationPath)
        return;
    if (!(await hasPlainBackupDirectoryChain(resolvedDataDir)))
        return;
    await removeBackupFamily(destinationPath);
}
function computeCampaignKey(campaign, sourceDbIdentity) {
    // Stable JSON: fixed property order, sorted pending versions, floored
    // birthtime. Every field is deterministic for an unchanged campaign.
    const material = JSON.stringify({
        appliedMaxVersion: campaign.appliedMaxVersion,
        pendingVersions: sortedVersions(campaign.pendingVersions),
        source: sourceDbIdentity === 'missing'
            ? 'missing'
            : {
                dev: sourceDbIdentity.dev,
                ino: sourceDbIdentity.ino,
                birthtimeMs: sourceDbIdentity.birthtimeMs,
            },
    });
    return createHash('sha256').update(material, 'utf8').digest('hex');
}
function sortedVersions(versions) {
    return [...versions].sort((left, right) => left - right);
}
async function readSourceDbIdentity(databasePath) {
    try {
        const info = await stat(databasePath);
        if (!info.isFile())
            return 'missing';
        return { dev: info.dev, ino: info.ino, birthtimeMs: Math.floor(info.birthtimeMs) };
    }
    catch {
        return 'missing';
    }
}
/**
 * 磁盘余量预检:备份目标卷必须能容纳主库 + 现存 -wal 的 1.2 倍,否则以专用
 * error code fail-stop,不产生半成品文件。statfs 不可用(旧内核/特殊文件系统)
 * 时跳过预检,由实际写入的 ENOSPC 兜底。
 */
async function assertBackupDiskSpace(databasePath, directoryPath) {
    let availableBytes;
    try {
        const stats = await statfs(directoryPath);
        availableBytes = Number(stats.bavail) * Number(stats.bsize);
    }
    catch {
        return;
    }
    if (!Number.isFinite(availableBytes) || availableBytes < 0)
        return;
    const requiredBytes = Math.ceil(((await readFileSizeBytes(databasePath)) + (await readFileSizeBytes(`${databasePath}-wal`))) *
        BACKUP_DISK_SPACE_HEADROOM);
    if (availableBytes < requiredBytes) {
        throw new DatabaseBackupDiskSpaceError(requiredBytes, availableBytes);
    }
}
async function readFileSizeBytes(path) {
    try {
        const info = await stat(path);
        return info.isFile() ? info.size : 0;
    }
    catch {
        return 0;
    }
}
/**
 * 扫描备份目录内的 `.meta.json` sidecar,寻找同 campaign 且文件 identity 与
 * sidecar 记录一致的既有备份。命中多个时取 createdAtMs 最早的一份 —— 同一
 * campaign 永远保留第一份,拒绝后拷。
 */
async function findReusableCampaignBackup(directoryPath, campaignKey) {
    let entries;
    try {
        entries = await readdir(directoryPath, { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    let earliest;
    for (const entry of entries) {
        const candidate = await readReusableCampaignBackup(directoryPath, entry, campaignKey);
        if (!candidate)
            continue;
        if (!earliest || candidate.createdAtMs < earliest.createdAtMs)
            earliest = candidate;
    }
    return earliest;
}
/** Evaluates one directory entry as a reusable same-campaign backup sidecar. */
async function readReusableCampaignBackup(directoryPath, entry, campaignKey) {
    if (!entry.isFile() || entry.isSymbolicLink())
        return undefined;
    if (!entry.name.endsWith(BACKUP_META_SUFFIX))
        return undefined;
    const backupFileName = entry.name.slice(0, -BACKUP_META_SUFFIX.length);
    if (!BACKUP_FILE_PATTERN.test(backupFileName))
        return undefined;
    const sidecar = await readCampaignSidecar(join(directoryPath, entry.name));
    if (!sidecar || sidecar.campaignKey !== campaignKey)
        return undefined;
    const backupIdentity = await readBackupFileIdentity(join(directoryPath, backupFileName));
    if (!backupIdentity || backupIdentity !== sidecar.verifiedFileIdentity)
        return undefined;
    return {
        created: false,
        reused: true,
        fileName: backupFileName,
        campaignKey,
        createdAtMs: sidecar.createdAtMs,
    };
}
async function readCampaignSidecar(path) {
    try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink())
            return undefined;
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        return isDatabaseBackupSidecar(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function isDatabaseBackupSidecar(value) {
    if (!value || typeof value !== 'object')
        return false;
    const sidecar = value;
    return (sidecar.schemaVersion === 1 &&
        typeof sidecar.campaignKey === 'string' &&
        sidecar.campaignKey.length > 0 &&
        typeof sidecar.verifiedFileIdentity === 'string' &&
        sidecar.verifiedFileIdentity.length > 0 &&
        typeof sidecar.createdAtMs === 'number' &&
        Number.isSafeInteger(sidecar.createdAtMs));
}
/**
 * Sidecar 在 integrity 校验成功后写入。写失败不致命:该次备份仍然有效,只是
 * 下一次失败重试无法复用而已,绝不能因此让启动失败。
 */
async function writeCampaignSidecar(destinationPath, sidecar) {
    try {
        await writeFile(`${destinationPath}${BACKUP_META_SUFFIX}`, `${JSON.stringify(sidecar)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
        });
    }
    catch {
        // Reuse metadata is best-effort; the verified backup itself stays valid.
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
    // A copy killed mid-write leaves its rollback journal next to it; drop it
    // with the copy so no orphan outlives the backup it belonged to.
    await Promise.all(['-wal', '-shm', '-journal', BACKUP_META_SUFFIX].map((suffix) => removePlainFile(`${databasePath}${suffix}`)));
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