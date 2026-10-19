import { createHash, randomBytes } from 'node:crypto';
import fs, { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
// Derived test-status cache for BYOK model providers. Everything in this file
// is rebuildable from re-running connection tests; it must never contain API
// keys, request headers, or response bodies — only normalized states, error
// codes, sanitized messages, and Unix-ms timestamps.
const MODEL_CACHE_FILE = 'model-cache.json';
const CACHE_STATES = new Set(['unknown', 'available', 'failed']);
const MAX_ERROR_MESSAGE_LENGTH = 500;
const mutationTails = new Map();
export function emptyModelCacheData() {
    return { version: 3, provider_status: {}, model_status: {} };
}
export function loadModelCacheData(dataDir) {
    return loadModelCacheFile(resolve(dataDir, MODEL_CACHE_FILE));
}
function loadModelCacheFile(filePath) {
    if (!existsSync(filePath))
        return emptyModelCacheData();
    try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!isPlainRecord(parsed))
            return emptyModelCacheData();
        return {
            version: 3,
            provider_status: readStatusMap(parsed.provider_status),
            model_status: readStatusMap(parsed.model_status),
        };
    }
    catch {
        return emptyModelCacheData();
    }
}
export function modelCacheStatusFor(data, providerId, modelId, expectedFingerprint) {
    const entry = data.model_status[`${providerId}/${modelId}`] ?? data.provider_status[providerId];
    if (expectedFingerprint !== undefined && entry?.config_fingerprint !== expectedFingerprint) {
        return undefined;
    }
    return entry;
}
export function modelConfigFingerprint(value) {
    const canonical = JSON.stringify(sortForFingerprint(value));
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
export class LocalModelCache {
    getDataDir;
    constructor(getDataDir) {
        this.getDataDir = getDataDir;
    }
    load() {
        return loadModelCacheData(this.getDataDir());
    }
    async setProviderStatus(providerId, entry) {
        await this.mutate((data) => {
            data.provider_status[providerId] = sanitizeEntry(entry);
        });
    }
    async setModelStatus(modelKey, entry) {
        await this.replaceModelStatus(modelKey, entry);
    }
    async replaceModelStatus(modelKey, entry) {
        return this.mutate((data) => {
            const previous = data.model_status[modelKey];
            data.model_status[modelKey] = sanitizeEntry(entry);
            return previous;
        });
    }
    async restoreModelStatusIfCurrent(modelKey, expectedCurrent, previous) {
        return this.mutate((data) => {
            if (!statusEntriesEqual(data.model_status[modelKey], expectedCurrent))
                return false;
            if (previous)
                data.model_status[modelKey] = sanitizeEntry(previous);
            else
                delete data.model_status[modelKey];
            return true;
        });
    }
    async removeModelStatus(modelKey) {
        await this.mutate((data) => {
            delete data.model_status[modelKey];
        });
    }
    async removeProvider(providerId) {
        await this.mutate((data) => {
            delete data.provider_status[providerId];
            for (const key of Object.keys(data.model_status)) {
                if (key.startsWith(`${providerId}/`))
                    delete data.model_status[key];
            }
        });
    }
    async mutate(mutate) {
        const filePath = resolve(this.getDataDir(), MODEL_CACHE_FILE);
        const previous = mutationTails.get(filePath) ?? Promise.resolve();
        const operation = this.runMutation(previous, filePath, mutate);
        const tail = ignorePromiseOutcome(operation);
        mutationTails.set(filePath, tail);
        try {
            return await operation;
        }
        finally {
            if (mutationTails.get(filePath) === tail)
                mutationTails.delete(filePath);
        }
    }
    async runMutation(previous, filePath, mutate) {
        await ignorePromiseOutcome(previous);
        const data = loadModelCacheFile(filePath);
        const result = mutate(data);
        await this.write(filePath, data);
        return result;
    }
    async write(filePath, data) {
        await fs.promises.mkdir(dirname(filePath), { recursive: true });
        const tmpPath = join(dirname(filePath), `.model-cache-tmp-${randomBytes(6).toString('hex')}`);
        try {
            await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), {
                encoding: 'utf-8',
                mode: 0o600,
            });
            await fs.promises.rename(tmpPath, filePath);
        }
        catch (error) {
            try {
                await fs.promises.unlink(tmpPath);
            }
            catch {
                // The original write failure remains authoritative when cleanup also fails.
            }
            throw error;
        }
    }
}
function statusEntriesEqual(left, right) {
    if (!left || !right)
        return left === right;
    const normalizedLeft = sanitizeEntry(left);
    const normalizedRight = sanitizeEntry(right);
    return (normalizedLeft.state === normalizedRight.state &&
        normalizedLeft.last_tested_at === normalizedRight.last_tested_at &&
        normalizedLeft.last_error_code === normalizedRight.last_error_code &&
        normalizedLeft.last_error_message === normalizedRight.last_error_message &&
        normalizedLeft.config_fingerprint === normalizedRight.config_fingerprint);
}
function sanitizeEntry(entry) {
    return {
        state: entry.state,
        ...(typeof entry.last_tested_at === 'number' ? { last_tested_at: entry.last_tested_at } : {}),
        ...(typeof entry.last_error_code === 'string' && entry.last_error_code
            ? { last_error_code: entry.last_error_code }
            : {}),
        ...(typeof entry.last_error_message === 'string' && entry.last_error_message
            ? { last_error_message: entry.last_error_message.slice(0, MAX_ERROR_MESSAGE_LENGTH) }
            : {}),
        ...(typeof entry.config_fingerprint === 'string' && entry.config_fingerprint
            ? { config_fingerprint: entry.config_fingerprint }
            : {}),
    };
}
function sortForFingerprint(value) {
    if (Array.isArray(value))
        return value.map(sortForFingerprint);
    if (!isPlainRecord(value))
        return value;
    return Object.fromEntries(Object.keys(value)
        .sort()
        .map((key) => [key, sortForFingerprint(value[key])]));
}
function readStatusMap(value) {
    if (!isPlainRecord(value))
        return {};
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (!isPlainRecord(raw))
            continue;
        const state = raw.state;
        if (typeof state !== 'string' || !CACHE_STATES.has(state))
            continue;
        out[key] = sanitizeEntry(readStatusEntry(raw, state));
    }
    return out;
}
function readStatusEntry(raw, state) {
    return {
        state,
        ...(typeof raw.last_tested_at === 'number' ? { last_tested_at: raw.last_tested_at } : {}),
        ...(typeof raw.last_error_code === 'string' ? { last_error_code: raw.last_error_code } : {}),
        ...(typeof raw.last_error_message === 'string'
            ? { last_error_message: raw.last_error_message }
            : {}),
        ...(typeof raw.config_fingerprint === 'string'
            ? { config_fingerprint: raw.config_fingerprint }
            : {}),
    };
}
async function ignorePromiseOutcome(value) {
    try {
        await value;
    }
    catch {
        // Serialization continues after a failed predecessor.
    }
}
function isPlainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=model-cache.js.map