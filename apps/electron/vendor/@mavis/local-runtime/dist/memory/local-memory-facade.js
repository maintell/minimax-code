import { join } from 'node:path';
import { FsLocalMemoryStore } from './local-memory-store-fs.js';
import { LocalMemoryError, } from './types.js';
const USER_APPEND_MAX_CHARS = 500;
const SUMMARY_MAX_BYTES = 4 * 1024;
const CLEANUP_THRESHOLD_BYTES = 64 * 1024;
const USER_TARGET = { scope: 'user' };
// Stable identifier surfaced on emitted memory.saved payloads for user scope,
// which has no agentName.
const USER_SCOPE_KEY = '';
function agentTarget(agentName) {
    return { scope: 'agent', agentName: agentName ?? '' };
}
function scopeKey(target) {
    return target.scope === 'agent' ? target.agentName : USER_SCOPE_KEY;
}
export class LocalMemoryFacade {
    options;
    nowMs;
    store;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.store = new FsLocalMemoryStore(options.config, this.nowMs);
    }
    getStore() {
        return this.store;
    }
    async getAgentMemory(agentName) {
        return this.store.readMain(agentTarget(agentName));
    }
    async getUserMemory() {
        return this.store.readMain(USER_TARGET);
    }
    async appendMemory(agentName, content) {
        const target = agentTarget(agentName);
        const result = await this.store.appendMain(target, content);
        this.emitSaved(target, 'main');
        return result;
    }
    async appendUserMemory(content, reason) {
        if (!reason?.trim())
            throw new LocalMemoryError('REASON_REQUIRED', 'user memory append requires reason');
        if (content.length > USER_APPEND_MAX_CHARS) {
            throw new LocalMemoryError('CONTENT_TOO_LONG', 'user memory append content exceeds 500 characters');
        }
        const result = await this.store.appendMain(USER_TARGET, `<!-- mem-append-reason: ${reason.trim()} -->\n${content}`);
        this.emitSaved(USER_TARGET, 'main');
        return result;
    }
    async writeMemory(agentName, content) {
        const target = agentTarget(agentName);
        const result = await this.store.writeMain(target, content);
        this.emitSaved(target, 'main');
        return result;
    }
    async writeMemoryForManagement(agentName, content) {
        const target = agentTarget(agentName);
        const result = await this.store.writeMainForManagement(target, content);
        this.emitSaved(target, 'main');
        return result;
    }
    async writeUserMemory(content) {
        const result = await this.store.writeMain(USER_TARGET, content);
        this.emitSaved(USER_TARGET, 'main');
        return result;
    }
    async writeUserMemoryForManagement(content) {
        const result = await this.store.writeMainForManagement(USER_TARGET, content);
        this.emitSaved(USER_TARGET, 'main');
        return result;
    }
    async editMemory(agentName, oldString, newString, replaceAll = false) {
        const target = agentTarget(agentName);
        const result = await this.store.editMain(target, oldString, newString, replaceAll);
        this.emitSaved(target, 'main');
        return result;
    }
    searchMemory(agentName, query) {
        return this.store.searchMain(agentTarget(agentName), query);
    }
    searchUserMemory(query) {
        return this.store.searchMain(USER_TARGET, query);
    }
    listTopics(agentName) {
        return this.store.listTopics(agentTarget(agentName));
    }
    getTopic(agentName, topicName) {
        return this.store.readTopic(agentTarget(agentName), topicName);
    }
    async writeTopic(agentName, topicName, description, content) {
        const target = agentTarget(agentName);
        await this.store.writeTopic(target, topicName, description, content);
        this.emitSaved(target, 'topic', { topicName });
    }
    async appendTopic(agentName, topicName, content) {
        const target = agentTarget(agentName);
        const result = await this.store.appendTopic(target, topicName, content);
        this.emitSaved(target, 'topic', { topicName });
        return result;
    }
    async editTopic(agentName, topicName, oldString, newString, replaceAll = false) {
        const target = agentTarget(agentName);
        const result = await this.store.editTopic(target, topicName, oldString, newString, replaceAll);
        this.emitSaved(target, 'topic', { topicName });
        return result;
    }
    async deleteTopic(agentName, topicName) {
        const target = agentTarget(agentName);
        const deleted = await this.store.deleteTopic(target, topicName);
        if (deleted)
            this.emitSaved(target, 'topic', { topicName, deleted });
        return deleted;
    }
    searchTopics(agentName, keyword, limit) {
        return this.store.searchTopics(agentTarget(agentName), keyword, limit);
    }
    listDaily(agentName, limit, offset, includeArchived) {
        return this.store.listDaily(agentTarget(agentName), limit, offset, includeArchived);
    }
    getDaily(agentName, date) {
        return this.store.readDaily(agentTarget(agentName), date);
    }
    async writeDaily(agentName, date, content) {
        const target = agentTarget(agentName);
        await this.store.writeDaily(target, date, content);
        this.emitSaved(target, 'daily', { date });
    }
    async appendDaily(agentName, date, content) {
        const target = agentTarget(agentName);
        await this.store.appendDaily(target, date, content);
        this.emitSaved(target, 'daily', { date });
    }
    async deleteDaily(agentName, date) {
        const target = agentTarget(agentName);
        const deleted = await this.store.deleteDaily(target, date);
        if (deleted)
            this.emitSaved(target, 'daily', { date, deleted });
        return deleted;
    }
    async writeMemorySummary(agentName, content) {
        if (Buffer.byteLength(content, 'utf8') > SUMMARY_MAX_BYTES) {
            throw new LocalMemoryError('SUMMARY_TOO_LARGE', 'summary exceeds 4KB');
        }
        const target = agentTarget(agentName);
        await this.store.writeSummary(target, content);
        this.emitSaved(target, 'summary');
    }
    listArchive(agentName, limit, offset) {
        return this.store.listArchive(agentTarget(agentName), limit, offset);
    }
    getArchive(agentName, snapshotDate, fileName) {
        return this.store.readArchive(agentTarget(agentName), snapshotDate, fileName);
    }
    snapshotForCleanup(agentName, date) {
        return this.store.snapshotForCleanup(agentTarget(agentName), date);
    }
    archiveOldDaily(agentName, ttlDays) {
        return this.store.archiveOldDaily(agentTarget(agentName), ttlDays);
    }
    async triggerCleanup(agentName, force = false) {
        const target = agentTarget(agentName);
        const current = await this.store.readMain(target);
        if (!force && current.sizeBytes < CLEANUP_THRESHOLD_BYTES) {
            return { spawned: false, reason: 'below_threshold' };
        }
        await this.store.snapshotForCleanup(target);
        return { spawned: true, reason: force ? 'force_snapshot' : 'threshold_snapshot' };
    }
    markSession(date, sessionId, agentName, wroteMemory) {
        return this.store.markSession(date, sessionId, agentName, wroteMemory);
    }
    getUnreminded(date, agentName) {
        return this.store.getUnreminded(date, agentName);
    }
    markReminded(date, sessionId) {
        return this.store.markReminded(date, sessionId);
    }
    markReflected(date, sessionId, agentName, reflectedAt) {
        return this.store.markReflected(date, sessionId, agentName, reflectedAt);
    }
    getReflectionTs(sessionId) {
        return this.store.getReflectionTs(sessionId);
    }
    async collectReminderMemory(agentName) {
        const target = agentTarget(agentName);
        const main = await this.store.readMain(target);
        const user = await this.store.readMain(USER_TARGET);
        const summary = await this.store.readSummary(target);
        const topics = await this.store.listTopics(target).catch(() => []);
        const location = this.store.resolve(target);
        return {
            main: main.content,
            mainPath: location.mainPath,
            mainLines: main.content ? main.content.split('\n').length : 0,
            mainSizeBytes: main.sizeBytes,
            user: user.content,
            userPath: this.store.resolve(USER_TARGET).mainPath,
            summary,
            topics: topics.map((topic) => ({
                name: topic.name,
                description: topic.description,
                path: join(location.memoryDir, 'topics', `${topic.name}.md`),
            })),
        };
    }
    emitSaved(target, kind, extra = {}) {
        this.options.emitBusEvent?.('memory.saved', {
            agentName: scopeKey(target),
            kind,
            timestamp: this.nowMs(),
            ...extra,
        });
    }
}
//# sourceMappingURL=local-memory-facade.js.map