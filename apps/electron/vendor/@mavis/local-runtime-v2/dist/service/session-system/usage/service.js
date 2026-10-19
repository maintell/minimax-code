export class SessionUsageServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'SessionUsageServiceError';
    }
}
export class SessionUsageService {
    store;
    constructor(store) {
        this.store = store;
    }
    async summarizeSession(input) {
        return this.store.summarizeBySession(input.sessionId, normalizeRange(input.from, input.to));
    }
    async readSession(input) {
        const range = normalizeRange(input.from, input.to);
        const [summary, rows] = await Promise.all([
            this.store.summarizeBySession(input.sessionId, range),
            this.store.listBySession(input.sessionId, range),
        ]);
        return { summary, rows };
    }
    async summarizeGlobal(input) {
        const range = normalizeRange(input.from, input.to);
        const group = normalizeGroup(input.group);
        const summary = await this.store.summarizeGlobal(range);
        return group
            ? { summary, groups: await this.store.summarizeGroupBy(group, range) }
            : { summary };
    }
}
function normalizeRange(fromValue, toValue) {
    const from = optionalTimestamp(fromValue, 'from');
    const to = optionalTimestamp(toValue, 'to');
    if (from !== undefined && to !== undefined && from > to) {
        throw new SessionUsageServiceError('invalid-range', `Invalid usage range: from (${String(from)}) > to (${String(to)})`);
    }
    return {
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
    };
}
function optionalTimestamp(value, name) {
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new SessionUsageServiceError(name === 'from' ? 'invalid-from' : 'invalid-to', `Invalid usage ${name} timestamp: ${String(value)}`);
    }
    return value;
}
function normalizeGroup(value) {
    if (value === undefined || value === '')
        return undefined;
    if (value === 'agent' || value === 'session' || value === 'model' || value === 'day') {
        return value;
    }
    throw new SessionUsageServiceError('invalid-group', `Invalid usage group: ${value}`);
}
//# sourceMappingURL=service.js.map