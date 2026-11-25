/**
 * Scopes of the runs in flight, keyed by the Session and Turn of their accepted lease. A Host
 * accepts a Turn id once; should it run one lease twice at a time, the later run answers until
 * it settles and the earlier one answers again after that.
 */
export class ActiveRunScopes {
    scopes = new Map();
    scope(turn) {
        const entries = this.scopes.get(runKey(turn));
        return entries?.[entries.length - 1];
    }
    /**
     * Registers `scope` for the Turn of `lease` until the returned release runs. A malformed
     * lease registers nothing; the kernel rejects it with its own lease error.
     */
    enter(lease, scope) {
        if (!isRunTurn(lease))
            return () => undefined;
        const key = runKey(lease);
        const entries = this.scopes.get(key) ?? [];
        entries.push(scope);
        this.scopes.set(key, entries);
        return () => {
            const index = entries.lastIndexOf(scope);
            if (index >= 0)
                entries.splice(index, 1);
            if (entries.length === 0)
                this.scopes.delete(key);
        };
    }
}
function runKey(turn) {
    return JSON.stringify([turn.sessionId, turn.turnId]);
}
function isRunTurn(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'sessionId') === 'string' &&
        typeof Reflect.get(value, 'turnId') === 'string');
}
//# sourceMappingURL=active-runs.js.map