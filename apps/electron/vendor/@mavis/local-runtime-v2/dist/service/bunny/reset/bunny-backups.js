import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BunnyBackupNotFoundError, } from '../contracts.js';
/**
 * Backup directory layout, one directory per Bunny initialization or restore under
 * `<dataDir>/bunny-backups/<id>/`:
 *
 * - `manifest.json`: time, reason, main conversation, data summary and settings;
 * - `data.json`: the reset snapshot's data plus the Session records;
 * - `sessions/<id>.json`: each Session with its complete history export;
 * - `bunny-data.sqlite`: online copy of the Bunny store;
 * - `bunny/`: every home entry except the live database directory;
 * - `README.md`: the same facts for a person.
 */
const BUNNY_BACKUPS_DIR = 'bunny-backups';
export const BUNNY_DATABASE_BACKUP_NAME = 'bunny-data.sqlite';
/** The home copy inside a backup directory. */
export const BUNNY_HOME_BACKUP_NAME = 'bunny';
const MANIFEST_FILE = 'manifest.json';
const DATA_FILE = 'data.json';
/** `YYYYMMDD-HHMMSS`, with `-N` when several backups share a second. */
const BACKUP_ID = /^\d{8}-\d{6}(?:-\d+)?$/u;
/** Creates an empty backup directory named after `date`; never reuses one. */
export async function createBackupDir(dataDir, date) {
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    let backupDir = join(dataDir, BUNNY_BACKUPS_DIR, stamp);
    for (let suffix = 1; await exists(backupDir); suffix++)
        backupDir = join(dataDir, BUNNY_BACKUPS_DIR, `${stamp}-${suffix}`);
    await mkdir(join(backupDir, 'sessions'), { recursive: true });
    return backupDir;
}
/** Writes everything but the store copy and the home entries. */
export async function writeBackupFiles(backupDir, input) {
    const { snapshot, manifest } = input;
    for (const session of snapshot.sessions) {
        await writeFile(join(backupDir, 'sessions', `${session.sessionId}.json`), JSON.stringify({ session, history: await input.history(session.sessionId) }, null, 2));
    }
    await writeFile(join(backupDir, DATA_FILE), JSON.stringify({ ...snapshot.data, sessions: snapshot.sessions }, null, 2));
    await writeFile(join(backupDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    const counts = Object.entries(snapshot.data).map(([key, value]) => `- ${key}：${Array.isArray(value) ? value.length : 1}`);
    await writeFile(join(backupDir, 'README.md'), [
        manifest.reason === 'restore' ? '# Bunny 恢复前备份' : '# Bunny 初始化备份',
        '',
        `${manifest.reason === 'restore' ? '恢复' : '初始化'}时间：${new Date(manifest.createdAtMs).toISOString()}`,
        `主对话：${manifest.mainSessionId}`,
        `会话：${snapshot.sessions.length}`,
        ...counts,
        '',
        '## 会话',
        ...snapshot.sessions.map((session) => `- ${session.sessionId}：${session.workspaceDir}`),
        '',
        '## 任务工作树',
        ...snapshot.sessions
            .filter((session) => snapshot.assignedSessionIds.has(session.sessionId) &&
            session.runLocation?.mode.includes('worktree'))
            .map((session) => `- ${session.sessionId}：${session.runLocation.resolvedDir}（${session.runLocation.resolvedBranch ?? ''}）`),
        '',
    ].join('\n'));
}
/** Complete backups, newest first; a directory without a readable manifest is not one. */
export async function listBackups(dataDir) {
    const root = join(dataDir, BUNNY_BACKUPS_DIR);
    let names;
    try {
        names = await readdir(root);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    const backups = [];
    for (const id of names.filter((name) => BACKUP_ID.test(name))) {
        const backupDir = join(root, id);
        const manifest = await readManifest(backupDir);
        if (manifest)
            backups.push({ id, createdAtMs: manifest.createdAtMs, backupDir, counts: manifest.counts });
    }
    return backups.sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
}
/** Reads what restore needs; throws `BunnyBackupNotFoundError` for an unknown or incomplete ID. */
export async function readBackup(dataDir, backupId) {
    const missing = () => new BunnyBackupNotFoundError(`没有找到备份 ${backupId}，或它不完整。`);
    if (!BACKUP_ID.test(backupId))
        throw missing();
    const dir = join(dataDir, BUNNY_BACKUPS_DIR, backupId);
    const manifest = await readManifest(dir);
    const storePath = join(dir, BUNNY_DATABASE_BACKUP_NAME);
    if (!manifest || !(await exists(storePath)) || !(await exists(join(dir, BUNNY_HOME_BACKUP_NAME))))
        throw missing();
    let parsed;
    try {
        parsed = JSON.parse(await readFile(join(dir, DATA_FILE), 'utf8'));
    }
    catch {
        throw missing();
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions))
        throw missing();
    const { sessions, ...data } = parsed;
    return { dir, manifest, data, sessions: sessions, storePath };
}
async function readManifest(backupDir) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(join(backupDir, MANIFEST_FILE), 'utf8'));
    }
    catch {
        return undefined;
    }
    if (!isRecord(parsed) ||
        typeof parsed.createdAtMs !== 'number' ||
        typeof parsed.mainSessionId !== 'string' ||
        !parsed.mainSessionId ||
        (parsed.reason !== 'initialize' && parsed.reason !== 'restore') ||
        !isRecord(parsed.counts))
        return undefined;
    const counts = Object.fromEntries(Object.entries(parsed.counts).filter((entry) => typeof entry[1] === 'number'));
    return {
        createdAtMs: parsed.createdAtMs,
        reason: parsed.reason,
        mainSessionId: parsed.mainSessionId,
        counts,
        settings: isRecord(parsed.settings) ? parsed.settings : {},
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
//# sourceMappingURL=bunny-backups.js.map