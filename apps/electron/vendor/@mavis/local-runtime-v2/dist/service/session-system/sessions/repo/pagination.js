export function sessionPageFromRows(records, limit) {
    const sessions = records.slice(0, limit);
    const hasMore = records.length > limit;
    const last = sessions.at(-1);
    return {
        sessions,
        hasMore,
        ...(hasMore && last ? { nextCursor: encodeRecencyCursor(last) } : {}),
    };
}
export function sortByRecency(records) {
    return [...records].sort((left, right) => right.updatedAtMs - left.updatedAtMs ||
        right.createdAtMs - left.createdAtMs ||
        left.sessionId.localeCompare(right.sessionId));
}
export function sessionCreationPageFromRows(records, limit, originCronId) {
    const hasMore = records.length > limit;
    const sessions = records.slice(0, limit);
    const last = sessions.at(-1);
    return {
        sessions,
        hasMore,
        ...(hasMore && last ? { nextCursor: encodeCreationCursor(last, originCronId) } : {}),
    };
}
export function normalizePageLimit(value, maximum = 200) {
    if (value === undefined || !Number.isFinite(value))
        return 50;
    const normalized = Math.floor(value);
    return normalized > 0 ? Math.min(normalized, maximum) : 50;
}
function encodeRecencyCursor(record) {
    return Buffer.from(JSON.stringify({
        v: 1,
        k: 'recency',
        updatedAtMs: record.updatedAtMs,
        createdAtMs: record.createdAtMs,
        sessionId: record.sessionId,
    })).toString('base64url');
}
export function decodeRecencyCursor(value) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (!isRecord(parsed) || parsed.v !== 1 || parsed.k !== 'recency')
            return undefined;
        if (!Number.isSafeInteger(parsed.updatedAtMs) || !Number.isSafeInteger(parsed.createdAtMs)) {
            return undefined;
        }
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId)
            return undefined;
        return {
            updatedAtMs: parsed.updatedAtMs,
            createdAtMs: parsed.createdAtMs,
            sessionId: parsed.sessionId,
        };
    }
    catch {
        return undefined;
    }
}
function encodeCreationCursor(record, originCronId) {
    return Buffer.from(JSON.stringify({
        v: 1,
        k: 'cron-origin',
        createdAtMs: record.createdAtMs,
        sessionId: record.sessionId,
        originCronId,
    })).toString('base64url');
}
export function decodeCreationCursor(value, originCronId) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (!isRecord(parsed) ||
            parsed.v !== 1 ||
            parsed.k !== 'cron-origin' ||
            parsed.originCronId !== originCronId ||
            !Number.isSafeInteger(parsed.createdAtMs) ||
            typeof parsed.sessionId !== 'string' ||
            !parsed.sessionId) {
            return undefined;
        }
        return {
            createdAtMs: parsed.createdAtMs,
            sessionId: parsed.sessionId,
        };
    }
    catch {
        return undefined;
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=pagination.js.map