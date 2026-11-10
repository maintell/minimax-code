import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
const SAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_FILE_NAME_RE = /^[A-Za-z0-9_-]+\.md$/;
export class MemoryFileStoreImpl {
    dataDir;
    memoriesRoot;
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.memoriesRoot = join(dataDir, 'memories');
    }
    async notePath(scopeKey, filename) {
        assertSafeScopeKey(scopeKey);
        assertSafeFileName(filename);
        const target = join(this.scopeDir(scopeKey), 'extensions', 'ad_hoc', 'notes', filename);
        await assertSafePath(this.dataDir, target);
        return target;
    }
    async writeAdHocNoteMirror(scopeKey, filename, markdown) {
        await atomicWrite(await this.notePath(scopeKey, filename), markdown);
    }
    async readAdHocNoteMirror(scopeKey, filename) {
        return safeReadFile(await this.notePath(scopeKey, filename));
    }
    async deleteAdHocNoteMirror(scopeKey, filename) {
        await unlinkSafe(await this.notePath(scopeKey, filename));
    }
    async listAdHocNoteFiles(scopeKey) {
        const dir = dirname(await this.notePath(scopeKey, 'probe.md'));
        try {
            return (await readdir(dir, { withFileTypes: true }))
                .filter((entry) => entry.isFile() && SAFE_FILE_NAME_RE.test(entry.name))
                .map((entry) => entry.name)
                .sort();
        }
        catch (error) {
            if (isENOENT(error))
                return [];
            throw error;
        }
    }
    async writeSessionMemory(scopeKey, sessionId, markdown) {
        assertSafeScopeKey(scopeKey);
        assertSafeSessionId(sessionId);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.md`));
        const dir = await this.ensureSessionsDir(scopeKey);
        await atomicWrite(join(dir, `${sessionId}.md`), markdown);
    }
    async readSessionMemory(scopeKey, sessionId) {
        assertSafeScopeKey(scopeKey);
        assertSafeSessionId(sessionId);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.md`));
        return safeReadFile(join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.md`));
    }
    async deleteSessionMemory(scopeKey, sessionId) {
        assertSafeScopeKey(scopeKey);
        assertSafeSessionId(sessionId);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.md`));
        await unlinkSafe(join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.md`));
    }
    async writeSessionRules(scopeKey, sessionId, markdown) {
        assertSafeScopeKey(scopeKey);
        assertSafeSessionId(sessionId);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.rules.md`));
        const dir = await this.ensureSessionsDir(scopeKey);
        await atomicWrite(join(dir, `${sessionId}.rules.md`), markdown);
    }
    async readSessionRules(scopeKey, sessionId) {
        assertSafeScopeKey(scopeKey);
        assertSafeSessionId(sessionId);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.rules.md`));
        return safeReadFile(join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.rules.md`));
    }
    async deleteSessionRules(scopeKey, sessionId) {
        assertSafeScopeKey(scopeKey);
        assertSafeSessionId(sessionId);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.rules.md`));
        await unlinkSafe(join(this.scopeDir(scopeKey), 'sessions', `${sessionId}.rules.md`));
    }
    async writeMemoryIndex(scopeKey, markdown) {
        assertSafeScopeKey(scopeKey);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'MEMORY.md'));
        await this.ensureScopeDir(scopeKey);
        await atomicWrite(join(this.scopeDir(scopeKey), 'MEMORY.md'), markdown);
    }
    async readMemoryIndex(scopeKey) {
        assertSafeScopeKey(scopeKey);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'MEMORY.md'));
        return safeReadFile(join(this.scopeDir(scopeKey), 'MEMORY.md'));
    }
    async writeMemorySummary(scopeKey, markdown) {
        assertSafeScopeKey(scopeKey);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'memory_summary.md'));
        await this.ensureScopeDir(scopeKey);
        await atomicWrite(join(this.scopeDir(scopeKey), 'memory_summary.md'), markdown);
    }
    async readMemorySummary(scopeKey) {
        assertSafeScopeKey(scopeKey);
        await assertSafePath(this.dataDir, join(this.scopeDir(scopeKey), 'memory_summary.md'));
        return safeReadFile(join(this.scopeDir(scopeKey), 'memory_summary.md'));
    }
    async listSessionMemoryFiles(scopeKey) {
        assertSafeScopeKey(scopeKey);
        const sessionsDir = join(this.scopeDir(scopeKey), 'sessions');
        await assertSafePath(this.dataDir, sessionsDir);
        let entries;
        try {
            entries = await readdir(sessionsDir);
        }
        catch {
            return [];
        }
        return entries
            .filter((e) => e.endsWith('.md') && !e.endsWith('.rules.md') && !e.startsWith('.'))
            .map((e) => e.slice(0, -3));
    }
    async deleteScopeFiles(scopeKey) {
        assertSafeScopeKey(scopeKey);
        await assertSafePath(this.dataDir, this.scopeDir(scopeKey));
        await rm(this.scopeDir(scopeKey), { recursive: true, force: true });
    }
    async cleanupTemps(scopeKey) {
        assertSafeScopeKey(scopeKey);
        const scopePath = this.scopeDir(scopeKey);
        await assertSafePath(this.dataDir, join(scopePath, 'sessions'));
        await cleanupTmpFiles(scopePath);
        await cleanupTmpFiles(join(scopePath, 'sessions'));
    }
    async listScopeDirs() {
        const scopesRoot = join(this.memoriesRoot, 'scopes');
        await assertSafePath(this.dataDir, scopesRoot);
        let entries;
        try {
            entries = await readdir(scopesRoot);
        }
        catch {
            return [];
        }
        const dirs = [];
        for (const entry of entries) {
            if (!SAFE_NAME_RE.test(entry)) {
                // 非法命名的目录同样是孤儿，按原名返回供删除；跳过隐藏项。
                if (entry.startsWith('.'))
                    continue;
                dirs.push(entry);
                continue;
            }
            try {
                const stats = await lstat(join(scopesRoot, entry));
                if (stats.isDirectory())
                    dirs.push(entry);
            }
            catch {
                // 列举期间消失的目录忽略。
            }
        }
        return dirs.sort();
    }
    async deleteScopeDir(dirName) {
        if (!dirName || dirName.includes('/') || dirName.includes('\\') || dirName.includes('..')) {
            throw new Error(`Unsafe scope dir name: ${dirName}`);
        }
        const target = join(this.memoriesRoot, 'scopes', dirName);
        await assertSafePath(this.dataDir, target);
        await rm(target, { recursive: true, force: true });
    }
    async createConsolidationWorkdir(scopeKey, files) {
        assertSafeScopeKey(scopeKey);
        const workDir = join(this.memoriesRoot, 'tmp', `${scopeKey}-${randomUUID()}`);
        await assertSafePath(this.dataDir, workDir);
        await mkdir(workDir, { recursive: true });
        for (const file of files) {
            assertSafeWorkdirFileName(file.fileName);
            const target = join(workDir, file.fileName);
            await assertSafePath(this.dataDir, target);
            await atomicWrite(target, file.markdown);
        }
        return workDir;
    }
    async readConsolidationWorkdir(workDir) {
        this.assertWorkdirPath(workDir);
        const files = [];
        for (const name of ['MEMORY.md', 'memory_summary.md']) {
            const target = join(workDir, name);
            await assertSafePath(this.dataDir, target);
            const content = await safeReadFile(target);
            if (content !== undefined)
                files.push({ fileName: name, markdown: content });
        }
        return files;
    }
    async deleteConsolidationWorkdir(workDir) {
        this.assertWorkdirPath(workDir);
        await rm(workDir, { recursive: true, force: true });
    }
    assertWorkdirPath(workDir) {
        const tmpRoot = join(this.memoriesRoot, 'tmp');
        const rel = relative(tmpRoot, workDir);
        if (!rel || rel.startsWith('..') || rel.includes(sep)) {
            throw new Error(`Unsafe consolidation workdir: ${workDir}`);
        }
    }
    async readLegacyAgentSources(agentName) {
        assertSafeName(agentName);
        const results = [];
        await this.collectLegacyFiles(join(this.dataDir, 'agents', agentName, 'memory'), '', results);
        return results;
    }
    async snapshotLegacyUserMemory() {
        const snapshotPath = this.legacyUserSnapshotPath();
        await assertSafePath(this.dataDir, snapshotPath);
        const existing = await safeReadFile(snapshotPath);
        if (existing !== undefined)
            return existing.trim() ? existing : undefined;
        const userPath = this.userMemoryPath();
        await assertSafePath(this.dataDir, userPath);
        const content = (await safeReadFile(userPath)) ?? '';
        await atomicWrite(snapshotPath, content);
        return content.trim() ? content : undefined;
    }
    /**
     * 比较与清空在同一段同步代码里完成，期间同进程的资料写入无法插入：资料编辑器先写临时文件
     * 再改名，它的改名落在这段之后则新资料生效，落在之前则这里读到新内容、不再清空。
     * 同一数据目录只有一个持有所有者租约的 runtime，跨进程写入不在此考虑。
     */
    async clearLegacyUserMemory(snapshot) {
        const userPath = this.userMemoryPath();
        await assertSafePath(this.dataDir, userPath);
        let current;
        try {
            current = readFileSync(userPath, 'utf8');
        }
        catch (error) {
            if (isENOENT(error))
                return;
            throw error;
        }
        if (current !== snapshot)
            return;
        const tmp = join(dirname(userPath), `.${basename(userPath)}.${process.pid}.${randomUUID()}.tmp`);
        writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' });
        renameSync(tmp, userPath);
    }
    async deleteLegacyUserSnapshot() {
        const snapshotPath = this.legacyUserSnapshotPath();
        await assertSafePath(this.dataDir, snapshotPath);
        await unlinkSafe(snapshotPath);
    }
    async collectLegacyFiles(root, subdir, result) {
        const dir = join(root, subdir);
        await assertSafePath(this.dataDir, dir);
        let entries;
        try {
            entries = await readdir(dir);
        }
        catch (error) {
            if (isENOENT(error))
                return;
            throw error;
        }
        for (const name of entries.sort()) {
            const file = join(dir, name);
            await assertSafePath(this.dataDir, file);
            const stats = await lstat(file);
            if (stats.isDirectory() && subdir === '' && ['daily', 'topics'].includes(name)) {
                await this.collectLegacyFiles(root, name, result);
            }
            else if (stats.isFile() && name.endsWith('.md')) {
                result.push({
                    sourceFile: relative(this.dataDir, file).split(sep).join('/'),
                    content: await readFile(file, 'utf8'),
                });
            }
        }
    }
    scopeDir(scopeKey) {
        return join(this.memoriesRoot, 'scopes', scopeKey);
    }
    userMemoryPath() {
        return join(this.dataDir, 'memory', 'user.md');
    }
    /** 用户资料的迁移副本：在 memories/ 下、任何记忆作用域之外，记忆工具读不到，也不注入对话。 */
    legacyUserSnapshotPath() {
        return join(this.memoriesRoot, 'legacy', 'user.md');
    }
    async ensureScopeDir(scopeKey) {
        const dir = this.scopeDir(scopeKey);
        await ensureDirNoSymlink(dir);
        return dir;
    }
    async ensureSessionsDir(scopeKey) {
        const scopePath = this.scopeDir(scopeKey);
        await assertSafePath(this.dataDir, join(scopePath, 'sessions'));
        const sessionsDir = join(scopePath, 'sessions');
        await ensureDirNoSymlink(scopePath);
        await ensureDirNoSymlink(sessionsDir);
        return sessionsDir;
    }
}
function assertSafeScopeKey(value) {
    if (!value || !SAFE_NAME_RE.test(value)) {
        throw new Error(`Unsafe scope key: ${value}`);
    }
}
function assertSafeSessionId(value) {
    if (!value || !SAFE_NAME_RE.test(value)) {
        throw new Error(`Unsafe session id: ${value}`);
    }
}
function assertSafeName(value) {
    if (!value || !SAFE_NAME_RE.test(value)) {
        throw new Error(`Unsafe name component: ${value}`);
    }
}
/**
 * 带单个 `.md` 后缀的文件名（如 note 文件）。纯目录分量走 assertSafeName，不含点号；
 * 这里仍然拒绝路径分隔符、`..` 与前导点，因此路径安全边界不变(§6.3)。
 */
function assertSafeFileName(value) {
    if (!value || !SAFE_FILE_NAME_RE.test(value)) {
        throw new Error(`Unsafe file name: ${value}`);
    }
}
/** 工作目录内允许的文件名：`MEMORY.md`、`memory_summary.md`、`changes.md` 与会话文档名。 */
function assertSafeWorkdirFileName(value) {
    const flat = /^[A-Za-z0-9_-]+(?:\.rules)?\.md$/u.test(value);
    const note = /^extensions\/ad_hoc\/notes\/[A-Za-z0-9_-]+\.md$/u.test(value);
    if (!flat && !note)
        throw new Error('Unsafe workdir file name');
}
async function ensureDirNoSymlink(dir) {
    try {
        const stats = await lstat(dir);
        if (stats.isSymbolicLink())
            throw new Error(`Symlink rejected: ${dir}`);
        if (!stats.isDirectory())
            throw new Error(`Not a directory: ${dir}`);
    }
    catch (error) {
        if (isENOENT(error)) {
            await mkdir(dir, { recursive: true });
            return;
        }
        throw error;
    }
}
async function atomicWrite(target, content) {
    const payload = Buffer.from(content, 'utf8');
    const parentDir = dirname(target);
    await mkdir(parentDir, { recursive: true });
    const tmp = join(parentDir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    let tmpCreated = false;
    let renamed = false;
    try {
        handle = await open(tmp, 'wx', 0o600);
        tmpCreated = true;
        await handle.writeFile(payload);
        await handle.close();
        handle = undefined;
        await rename(tmp, target);
        renamed = true;
    }
    catch (error) {
        if (handle)
            try {
                await handle.close();
            }
            catch { }
        if (tmpCreated && !renamed)
            try {
                await unlink(tmp);
            }
            catch { }
        throw error;
    }
}
async function safeReadFile(filePath) {
    try {
        const stats = await lstat(filePath);
        if (!stats.isFile())
            return undefined;
        return await readFile(filePath, 'utf8');
    }
    catch (error) {
        if (isENOENT(error))
            return undefined;
        throw error;
    }
}
async function unlinkSafe(filePath) {
    try {
        await unlink(filePath);
    }
    catch (error) {
        if (isENOENT(error))
            return;
        throw error;
    }
}
async function cleanupTmpFiles(dir) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (entry.startsWith('.') && entry.endsWith('.tmp')) {
            try {
                await unlink(join(dir, entry));
            }
            catch { }
        }
    }
}
function isENOENT(error) {
    return error.code === 'ENOENT';
}
/** dataDir 是受信根；其下每一层都拒绝链接，包含 Windows junction。 */
async function assertSafePath(root, target) {
    const parts = relative(root, target).split(sep);
    if (parts.some((part) => part === '..'))
        throw new Error('Unsafe memory path');
    let current = root;
    for (const part of parts) {
        current = join(current, part);
        try {
            const stats = await lstat(current);
            if (stats.isSymbolicLink())
                throw new Error(`Symlink rejected: ${current}`);
            if (!stats.isDirectory() && !stats.isFile())
                throw new Error(`Unsafe file: ${current}`);
        }
        catch (error) {
            if (isENOENT(error))
                return;
            throw error;
        }
    }
}
//# sourceMappingURL=file-store.js.map