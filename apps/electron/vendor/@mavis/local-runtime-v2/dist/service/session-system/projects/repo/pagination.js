export function projectPageFromRows(records, limit, kind) {
    const projects = records.slice(0, limit);
    const hasMore = records.length > limit;
    const last = projects.at(-1);
    return {
        projects,
        hasMore,
        ...(hasMore && last ? { nextCursor: encodeProjectCursor(last, kind) } : {}),
    };
}
export function normalizeProjectLimit(value) {
    if (value === undefined || !Number.isFinite(value))
        return 50;
    const normalized = Math.floor(value);
    return normalized > 0 ? Math.min(normalized, 200) : 50;
}
function encodeProjectCursor(record, kind) {
    const value = kind === 'recent'
        ? { v: 1, k: kind, i: record.projectId, r: record.recentAtMs }
        : {
            v: 1,
            k: kind,
            i: record.projectId,
            p: record.pinned,
            o: record.orderIndex,
            a: record.latestActivityAtMs,
        };
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}
export function decodeProjectCursor(value, kind) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
        if (!isCursorEnvelope(parsed, kind))
            return undefined;
        return kind === 'recent' ? decodeRecentCursor(parsed) : decodeCatalogCursor(parsed, kind);
    }
    catch {
        return undefined;
    }
}
function isCursorEnvelope(value, kind) {
    return (isRecord(value) &&
        value.v === 1 &&
        value.k === kind &&
        Number.isSafeInteger(value.i) &&
        value.i > 0);
}
function decodeRecentCursor(value) {
    return Number.isFinite(value.r)
        ? { kind: 'recent', projectId: value.i, recentAtMs: value.r }
        : undefined;
}
function decodeCatalogCursor(value, kind) {
    if (typeof value.p !== 'boolean' || !Number.isSafeInteger(value.o) || !Number.isFinite(value.a)) {
        return undefined;
    }
    return {
        kind,
        projectId: value.i,
        pinned: value.p,
        orderIndex: value.o,
        latestActivityAtMs: value.a,
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=pagination.js.map