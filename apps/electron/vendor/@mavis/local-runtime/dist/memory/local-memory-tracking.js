import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LocalMemoryError, } from './types.js';
import { assertDate, formatTs, safeRead, safeReaddir } from './local-memory-store-utils.js';
/**
 * Per-date session tracking for the local memory subsystem (which sessions
 * wrote memory / were reminded / reflected). Stored as JSON under
 * `<dataDir>/memory/tracking/<date>.json` and keyed by agentName.
 */
export class FsLocalMemoryTracking {
    config;
    nowMs;
    writeQueues = new Map();
    constructor(config, nowMs) {
        this.config = config;
        this.nowMs = nowMs;
    }
    async markSession(date, sessionId, agentName, wroteMemory) {
        await this.updateTracking(date, (records) => {
            const idx = records.findIndex((record) => record.sessionId === sessionId);
            const previous = idx >= 0 ? records[idx] : undefined;
            const next = {
                ...(previous ?? {}),
                sessionId,
                agentName,
                wroteMemory: wroteMemory || previous?.wroteMemory === true,
                reminded: previous?.reminded ?? false,
                checkedAt: formatTs(this.nowMs()),
            };
            if (idx >= 0)
                records[idx] = next;
            else
                records.push(next);
            return records;
        });
    }
    async getUnreminded(date, agentName) {
        return (await this.readTracking(date)).flatMap((record) => {
            if (record.reminded)
                return [];
            if (agentName !== undefined && record.agentName !== agentName)
                return [];
            return [
                {
                    sessionId: record.sessionId,
                    agentName: record.agentName ?? '',
                    wroteMemory: record.wroteMemory,
                    reminded: record.reminded,
                    checkedAt: record.checkedAt,
                    ...(record.lastReflectedAt ? { lastReflectedAt: record.lastReflectedAt } : {}),
                },
            ];
        });
    }
    async markReminded(date, sessionId) {
        await this.updateTracking(date, (records) => {
            for (const record of records)
                if (record.sessionId === sessionId)
                    record.reminded = true;
            return records;
        });
    }
    async markReflected(date, sessionId, agentName, reflectedAt) {
        await this.updateTracking(date, (records) => {
            const idx = records.findIndex((record) => record.sessionId === sessionId);
            const previous = idx >= 0 ? records[idx] : undefined;
            const next = {
                ...(previous ?? {}),
                sessionId,
                agentName,
                wroteMemory: previous?.wroteMemory ?? false,
                reminded: previous?.reminded ?? false,
                checkedAt: previous?.checkedAt ?? formatTs(this.nowMs()),
                lastReflectedAt: reflectedAt,
            };
            if (idx >= 0)
                records[idx] = next;
            else
                records.push(next);
            return records;
        });
    }
    async getReflectionTs(sessionId) {
        const trackingDir = join(this.config().dataDir, 'memory', 'tracking');
        for (const file of await safeReaddir(trackingDir)) {
            if (!file.endsWith('.json'))
                continue;
            const found = (await this.readTracking(file.slice(0, -5))).find((record) => record.sessionId === sessionId);
            if (found?.lastReflectedAt)
                return found.lastReflectedAt;
        }
        return undefined;
    }
    trackingPath(date) {
        return join(this.config().dataDir, 'memory', 'tracking', `${assertDate(date)}.json`);
    }
    async readTracking(date) {
        const raw = await safeRead(this.trackingPath(date));
        if (!raw.trim())
            return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    async updateTracking(date, update) {
        const trackingPath = this.trackingPath(date);
        await this.withFileQueue(trackingPath, async () => {
            const raw = await safeRead(trackingPath);
            const parsed = raw.trim() ? JSON.parse(raw) : [];
            const records = Array.isArray(parsed) ? parsed : [];
            this.assertWritable();
            await this.writeFileAtomic(trackingPath, `${JSON.stringify(update(records), null, 2)}\n`);
        });
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
//# sourceMappingURL=local-memory-tracking.js.map