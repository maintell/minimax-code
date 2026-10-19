const DAY_MS = 24 * 60 * 60 * 1_000;
const TURN_DIFF_RETENTION_MS = 7 * DAY_MS;
const TURN_DIFF_RETENTION_BATCH_SIZE = 250;
/**
 * One bounded post-ready pass over current Turn Diff state. Migrated Session
 * history is intentionally outside automatic retention and is never read here.
 */
export function createSessionStorageRetention(options) {
    return {
        run: async () => {
            if (!options.pruneTurnDiffs)
                return { attempted: false };
            const cutoffMs = retentionCutoff(options);
            if (cutoffMs === undefined)
                return { attempted: false };
            try {
                await options.pruneTurnDiffs(cutoffMs, TURN_DIFF_RETENTION_BATCH_SIZE);
            }
            catch (error) {
                options.logger?.warn({ error }, 'Turn Diff retention failed');
            }
            return { attempted: true, cutoffMs };
        },
    };
}
function retentionCutoff(options) {
    try {
        const nowMs = (options.nowMs ?? Date.now)();
        if (!Number.isSafeInteger(nowMs) || nowMs < TURN_DIFF_RETENTION_MS)
            return undefined;
        return nowMs - TURN_DIFF_RETENTION_MS;
    }
    catch (error) {
        options.logger?.warn({ error }, 'Turn Diff retention clock failed');
        return undefined;
    }
}
//# sourceMappingURL=storage-retention.js.map