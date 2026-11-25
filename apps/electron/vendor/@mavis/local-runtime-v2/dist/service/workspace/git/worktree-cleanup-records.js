import { deletePreferenceValue, readPreferenceValue, upsertPreferenceValue, } from '../../../infra/db/preference-values.js';
const RECORDS_KEY = 'worktree-cleanup.records';
const ENABLED_AT_KEY = 'worktree-cleanup.enabled-at';
const EVER_CLEANED_KEY = 'worktree-cleanup.ever-cleaned';
/** Durable cleanup records in the shared preferences KV table. */
export class WorktreeCleanupRecordStore {
    db;
    constructor(db) {
        this.db = db;
    }
    list() {
        const value = readPreferenceValue(this.db, RECORDS_KEY);
        return Array.isArray(value) ? value.filter(isCleanupRecord) : [];
    }
    findBySession(sessionId) {
        return this.list().find((record) => record.sessionIds.includes(sessionId));
    }
    /** The record of the worktree a Session directory belonged to. */
    findByDir(dir) {
        return this.list().find((record) => record.worktreeDir === dir || record.ownerDirs?.includes(dir) === true);
    }
    save(record) {
        this.write([...this.list().filter((existing) => existing.id !== record.id), record]);
    }
    remove(id) {
        this.write(this.list().filter((record) => record.id !== id));
    }
    /** Drops a deleted Session; returns records no Session refers to any more. */
    forgetSession(sessionId) {
        const orphaned = [];
        const kept = [];
        let changed = false;
        for (const record of this.list()) {
            if (!record.sessionIds.includes(sessionId)) {
                kept.push(record);
                continue;
            }
            changed = true;
            const sessionIds = record.sessionIds.filter((id) => id !== sessionId);
            if (sessionIds.length === 0)
                orphaned.push(record);
            else
                kept.push({ ...record, sessionIds });
        }
        if (changed)
            this.write(kept);
        return orphaned;
    }
    /** When cleanup was first enabled; starts the grace period on first read. */
    enabledAtMs(nowMs) {
        const value = readPreferenceValue(this.db, ENABLED_AT_KEY);
        if (typeof value === 'number' && Number.isSafeInteger(value))
            return value;
        upsertPreferenceValue(this.db, ENABLED_AT_KEY, nowMs);
        return nowMs;
    }
    /** Disabling resets the grace period so re-enabling never deletes at once. */
    clearEnabledAt() {
        deletePreferenceValue(this.db, ENABLED_AT_KEY);
    }
    /**
     * Whether a record was ever saved; until then there is nothing to reconcile.
     * Stored records count too, which covers records written before the flag
     * existed and a write interrupted between the two keys.
     */
    everCleaned() {
        return (readPreferenceValue(this.db, EVER_CLEANED_KEY) === true || this.list().length > 0);
    }
    write(records) {
        if (records.length === 0) {
            deletePreferenceValue(this.db, RECORDS_KEY);
            return;
        }
        // The flag goes first: a flag without records only costs one extra Session read at startup.
        upsertPreferenceValue(this.db, EVER_CLEANED_KEY, true);
        upsertPreferenceValue(this.db, RECORDS_KEY, records);
    }
}
function isCleanupRecord(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    return (typeof record.id === 'string' &&
        typeof record.worktreeDir === 'string' &&
        typeof record.repoDir === 'string' &&
        typeof record.head === 'string' &&
        isOptionalStringArray(record.ownerDirs) &&
        isStringArray(record.sessionIds) &&
        isOptionalStringArray(record.addedRunLocationSessionIds) &&
        typeof record.cleanedAtMs === 'number');
}
function isOptionalStringArray(value) {
    return value === undefined || isStringArray(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
//# sourceMappingURL=worktree-cleanup-records.js.map