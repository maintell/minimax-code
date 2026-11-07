import {} from './database-contracts.js';
export function runInTransaction(db, fn) {
    if (db.transaction) {
        db.transaction(fn)();
        return;
    }
    fn();
}
export function normalizePositiveInteger(value) {
    if (value === undefined || !Number.isFinite(value))
        return undefined;
    return Math.max(1, Math.floor(value));
}
export function numericOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
export function normalizeTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const numeric = Number(value);
        if (Number.isFinite(numeric))
            return numeric;
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return Date.now();
}
export function stableMessageSuffix(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url').slice(0, 12);
}
export function parseJson(raw) {
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
export function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
//# sourceMappingURL=sqlite-persistence-values.js.map