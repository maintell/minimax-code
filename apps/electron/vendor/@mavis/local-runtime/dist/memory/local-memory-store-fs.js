import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { LOCAL_MEMORY_TOPIC_NAME_RE, LocalMemoryError, } from './types.js';
import { appendWithSeparator, applyEdit, assertDate, assertSafeAgentName, byteLength, deleteIfExists, firstLine, formatTs, formatTopic, parseTopic, safeRead, safeReaddir, searchLines, today, } from './local-memory-store-utils.js';
import { FsLocalMemoryTracking } from './local-memory-tracking.js';
import { ensureEmptyMainFile, readMainFile } from './local-memory-main-file.js';
const MAIN_MEMORY_FILE = 'MEMORY.md';
const USER_MEMORY_FILE = 'user.md';
const LEGACY_USER_MEMORY_FILE = 'MEMORY.md';
const SUMMARY_FILE = '.summary.md';
export class FsLocalMemoryStore {
    config;
    nowMs;
    writeQueues = new Map();
    tracking;
    constructor(config, nowMs = () => Date.now()) {
        this.config = config;
        this.nowMs = nowMs;
        this.tracking = new FsLocalMemoryTracking(config, this.nowMs);
    }
    resolve(target) {
        const dataDir = this.config().dataDir;
        if (target.scope === 'user') {
            const memoryDir = join(dataDir, 'memory');
            return { scope: 'user', memoryDir, mainPath: join(memoryDir, USER_MEMORY_FILE) };
        }
        const agentName = assertSafeAgentName(target.agentName);
        const memoryDir = join(dataDir, 'agents', agentName, 'memory');
        return {
            scope: 'agent',
            agentName,
            memoryDir,
            mainPath: join(memoryDir, MAIN_MEMORY_FILE),
        };
    }
    async readMain(target) {
        const location = this.resolve(target);
        const readablePath = await this.migrateLegacyUserMemory(location);
        return readMainFile(this.config().dataDir, readablePath === location.mainPath ? location : { ...location, mainPath: readablePath });
    }
    async writeMain(target, content) {
        this.assertWritable();
        return this.writeMainContent(target, content);
    }
    async writeMainForManagement(target, content) {
        if (target.scope === 'agent' && this.config().agentMemoryRetired) {
            throw new LocalMemoryError('MEMORY_DISABLED', 'legacy agent memory has been retired');
        }
        return this.writeMainContent(target, content);
    }
    async writeMainContent(target, content) {
        const location = this.resolve(target);
        await this.migrateLegacyUserMemory(location);
        await this.atomicWrite(location.mainPath, content);
        return this.readFileResult(location.mainPath);
    }
    async appendMain(target, content) {
        const location = this.resolve(target);
        const filePath = await this.migrateLegacyUserMemory(location);
        const activeLocation = filePath === location.mainPath ? location : { ...location, mainPath: filePath };
        if (content === '') {
            return this.withFileQueue(filePath, async () => {
                this.assertWritable();
                return ensureEmptyMainFile(this.config().dataDir, activeLocation);
            });
        }
        return this.withFileQueue(filePath, async () => {
            const current = await safeRead(filePath);
            this.assertWritable();
            await this.writeFileAtomic(location.mainPath, appendWithSeparator(current, content));
            return this.readFileResult(location.mainPath);
        });
    }
    async editMain(target, oldString, newString, replaceAll = false) {
        const location = this.resolve(target);
        const filePath = await this.migrateLegacyUserMemory(location);
        return this.withFileQueue(filePath, async () => {
            const current = await safeRead(filePath);
            const { content, replacements } = applyEdit(current, oldString, newString, replaceAll);
            this.assertWritable();
            await this.writeFileAtomic(location.mainPath, content);
            return { replacements, result: await this.readFileResult(location.mainPath) };
        });
    }
    async searchMain(target, query) {
        const current = await this.readMain(target);
        return searchLines(current.content, query);
    }
    async listTopics(target) {
        const location = this.requireAgentLocation(target);
        const topicDir = join(location.memoryDir, 'topics');
        const entries = await safeReaddir(topicDir);
        const topics = [];
        for (const entry of entries) {
            if (!entry.endsWith('.md'))
                continue;
            const name = entry.slice(0, -3);
            if (!LOCAL_MEMORY_TOPIC_NAME_RE.test(name))
                continue;
            const filePath = join(topicDir, entry);
            const parsed = parseTopic(await safeRead(filePath));
            const fileStat = await stat(filePath).catch(() => undefined);
            topics.push({
                name,
                description: parsed.description,
                sizeBytes: byteLength(parsed.body),
                updatedAt: formatTs(fileStat?.mtimeMs ?? this.nowMs()),
            });
        }
        return topics.sort((a, b) => a.name.localeCompare(b.name));
    }
    async readTopic(target, topicName) {
        const filePath = this.topicPath(target, topicName);
        const parsed = parseTopic(await safeRead(filePath));
        return { name: topicName, ...parsed, sizeBytes: byteLength(parsed.body) };
    }
    async writeTopic(target, topicName, description, content) {
        const filePath = this.topicPath(target, topicName);
        this.assertWritable();
        await this.atomicWrite(filePath, formatTopic(description, content));
    }
    async appendTopic(target, topicName, content) {
        const filePath = this.topicPath(target, topicName);
        return this.withFileQueue(filePath, async () => {
            const current = parseTopic(await safeRead(filePath));
            const body = appendWithSeparator(current.body, content);
            this.assertWritable();
            await this.writeFileAtomic(filePath, formatTopic(current.description, body));
            return { newSizeBytes: byteLength(body) };
        });
    }
    async editTopic(target, topicName, oldString, newString, replaceAll = false) {
        const filePath = this.topicPath(target, topicName);
        return this.withFileQueue(filePath, async () => {
            const current = parseTopic(await safeRead(filePath));
            const { content, replacements } = applyEdit(current.body, oldString, newString, replaceAll);
            this.assertWritable();
            await this.writeFileAtomic(filePath, formatTopic(current.description, content));
            return { replacements, newSizeBytes: byteLength(content) };
        });
    }
    async deleteTopic(target, topicName) {
        const filePath = this.topicPath(target, topicName);
        this.assertWritable();
        return deleteIfExists(filePath);
    }
    async searchTopics(target, keyword, limit = 10) {
        const lower = keyword.toLowerCase();
        const topics = await this.listTopics(target);
        const out = [];
        for (const topic of topics) {
            const body = (await this.readTopic(target, topic.name)).body;
            if (topic.name.includes(lower) || body.toLowerCase().includes(lower))
                out.push(topic);
            if (out.length >= limit)
                break;
        }
        return out;
    }
    async listDaily(target, limit = 20, offset = 0, includeArchived = false) {
        const location = this.requireAgentLocation(target);
        const entries = await this.collectDailyEntries(location, includeArchived);
        return { files: entries.slice(offset, offset + limit), total: entries.length };
    }
    async readDaily(target, date) {
        return this.readFileResult(this.dailyPath(target, date));
    }
    async writeDaily(target, date, content) {
        this.assertWritable();
        await this.atomicWrite(this.dailyPath(target, date), content);
    }
    async appendDaily(target, date, content) {
        const filePath = this.dailyPath(target, date);
        await this.withFileQueue(filePath, async () => {
            const current = await safeRead(filePath);
            this.assertWritable();
            await this.writeFileAtomic(filePath, appendWithSeparator(current, content));
        });
    }
    async deleteDaily(target, date) {
        this.assertWritable();
        return deleteIfExists(this.dailyPath(target, date));
    }
    async writeSummary(target, content) {
        const location = this.requireAgentLocation(target);
        this.assertWritable();
        await this.atomicWrite(join(location.memoryDir, SUMMARY_FILE), content);
    }
    async readSummary(target) {
        const location = this.requireAgentLocation(target);
        return safeRead(join(location.memoryDir, SUMMARY_FILE));
    }
    async listArchive(target, limit = 20, offset = 0) {
        const location = this.requireAgentLocation(target);
        const archiveDir = join(location.memoryDir, 'archive');
        const dates = await safeReaddir(archiveDir);
        const entries = [];
        for (const snapshotDate of dates) {
            const dir = join(archiveDir, snapshotDate);
            const files = await safeReaddir(dir);
            for (const fileName of files) {
                const sizeBytes = (await stat(join(dir, fileName)).catch(() => undefined))?.size ?? 0;
                entries.push({ snapshotDate, fileName, sizeBytes });
            }
        }
        entries.sort((a, b) => b.snapshotDate.localeCompare(a.snapshotDate));
        return { entries: entries.slice(offset, offset + limit), total: entries.length };
    }
    async readArchive(target, snapshotDate, fileName) {
        if (basename(fileName) !== fileName)
            throw new LocalMemoryError('INVALID_FILE', 'invalid file');
        const location = this.requireAgentLocation(target);
        return this.readFileResult(join(location.memoryDir, 'archive', assertDate(snapshotDate), fileName));
    }
    async snapshotForCleanup(target, date = today()) {
        const location = this.requireAgentLocation(target);
        this.assertWritable();
        const content = await safeRead(location.mainPath);
        const snapshotDate = assertDate(date);
        await this.atomicWrite(join(location.memoryDir, 'archive', snapshotDate, MAIN_MEMORY_FILE), content);
        return { snapshotDate, fileCount: 1 };
    }
    async archiveOldDaily(target, ttlDays) {
        const location = this.requireAgentLocation(target);
        this.assertWritable();
        const cutoff = Date.now() - Math.max(0, ttlDays) * 24 * 60 * 60 * 1000;
        let count = 0;
        for (const entry of await this.collectDailyEntries(location, false)) {
            const ts = Date.parse(`${entry.date}T00:00:00.000Z`);
            if (Number.isNaN(ts) || ts >= cutoff)
                continue;
            const from = join(location.memoryDir, 'daily', `${entry.date}.md`);
            const content = await safeRead(from);
            await this.atomicWrite(join(location.memoryDir, 'archive', entry.date, `daily-${entry.date}.md`), content);
            if (await deleteIfExists(from))
                count += 1;
        }
        return count;
    }
    markSession(date, sessionId, agentName, wroteMemory) {
        return this.tracking.markSession(date, sessionId, agentName, wroteMemory);
    }
    getUnreminded(date, agentName) {
        return this.tracking.getUnreminded(date, agentName);
    }
    markReminded(date, sessionId) {
        return this.tracking.markReminded(date, sessionId);
    }
    markReflected(date, sessionId, agentName, reflectedAt) {
        return this.tracking.markReflected(date, sessionId, agentName, reflectedAt);
    }
    getReflectionTs(sessionId) {
        return this.tracking.getReflectionTs(sessionId);
    }
    requireAgentLocation(target) {
        const location = this.resolve(target);
        if (location.scope !== 'agent')
            throw new LocalMemoryError('AGENT_SCOPE_REQUIRED', 'agent scope required');
        return location;
    }
    topicPath(target, topicName) {
        if (!LOCAL_MEMORY_TOPIC_NAME_RE.test(topicName))
            throw new LocalMemoryError('INVALID_TOPIC', 'invalid topic name');
        const location = this.requireAgentLocation(target);
        return join(location.memoryDir, 'topics', `${topicName}.md`);
    }
    dailyPath(target, date) {
        const location = this.requireAgentLocation(target);
        return join(location.memoryDir, 'daily', `${assertDate(date)}.md`);
    }
    async collectDailyEntries(location, includeArchived) {
        const entries = [];
        for (const file of await safeReaddir(join(location.memoryDir, 'daily'))) {
            if (!file.endsWith('.md'))
                continue;
            const date = file.slice(0, -3);
            const content = await safeRead(join(location.memoryDir, 'daily', file));
            entries.push({
                date,
                sizeBytes: byteLength(content),
                brief: firstLine(content),
                archived: false,
            });
        }
        if (includeArchived) {
            const archiveTarget = { scope: 'agent', agentName: location.agentName };
            for (const entry of (await this.listArchive(archiveTarget, 1000, 0)).entries) {
                if (entry.fileName.startsWith('daily-')) {
                    entries.push({ date: entry.snapshotDate, sizeBytes: entry.sizeBytes, archived: true });
                }
            }
        }
        return entries.sort((a, b) => b.date.localeCompare(a.date));
    }
    async migrateLegacyUserMemory(location) {
        if (location.scope !== 'user')
            return location.mainPath;
        const legacy = join(location.memoryDir, LEGACY_USER_MEMORY_FILE);
        if (!existsSync(legacy) || existsSync(location.mainPath))
            return location.mainPath;
        if (this.config().enabled === false)
            return legacy;
        this.assertWritable();
        await mkdir(dirname(location.mainPath), { recursive: true });
        await rename(legacy, location.mainPath);
        return location.mainPath;
    }
    async readFileResult(filePath) {
        const content = await safeRead(filePath);
        const fileStat = await stat(filePath).catch(() => undefined);
        return {
            content,
            sizeBytes: byteLength(content),
            brief: firstLine(content),
            updatedAt: fileStat ? formatTs(fileStat.mtimeMs) : undefined,
        };
    }
    async atomicWrite(filePath, content) {
        await this.withFileQueue(filePath, () => this.writeFileAtomic(filePath, content));
    }
    async withFileQueue(filePath, work) {
        const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        this.writeQueues.set(filePath, next.catch(() => undefined));
        return next;
    }
    async writeFileAtomic(filePath, content) {
        await mkdir(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(tmp, content, 'utf8');
        await rename(tmp, filePath);
    }
    assertWritable() {
        if (this.config().enabled === false) {
            throw new LocalMemoryError('MEMORY_DISABLED', 'memory writes are disabled');
        }
    }
}
//# sourceMappingURL=local-memory-store-fs.js.map